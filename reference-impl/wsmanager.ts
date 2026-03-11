/**
 * wsmanager — canonical public API for the Bun reference implementation.
 *
 * Owns namespace/workspace/topic routes, public authentication, and websocket
 * bridging to per-workspace runtimes.
 */

import { actorFromRequest, actorFromToken, encodeInternalActor, type Actor } from "./auth.ts";
import {
  MANAGER_PROTOCOL_VERSION,
  namespaceBase,
  topicEventsPath,
  topicState as attachTopicState,
  topicSummary as attachTopicSummary,
  type ManagedTool,
  type ManagedToolGrant,
  type TopicState,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from "./protocol.ts";

const PORT = parseInt(process.env.PORT || "31337", 10);
const IMAGE = process.env.WMLET_IMAGE || "agrp-wmlet";
const NAMESPACE = process.env.WS_NAMESPACE || "default";
const INTERNAL_HOST = "127.0.0.1";
const PORT_RANGE_START = 52001;

type PublicSocket = any;
type TopicSocketData = {
  kind: "topic";
  workspaceName: string;
  topicName: string;
  actor: Actor | null;
  upstream: WebSocket | null;
  queue: string[];
  upstreamOpen: boolean;
};
type NamespaceSocketData = {
  kind: "namespace";
  authenticated: boolean;
};
type SocketData = TopicSocketData | NamespaceSocketData;

interface WorkspaceRecord extends WorkspaceSummary {
  containerId: string;
  port: number;
  tools: Map<string, ManagedTool>;
}

const workspaces = new Map<string, WorkspaceRecord>();
const namespaceSockets = new Set<PublicSocket>();
let nextPort = PORT_RANGE_START;

function jsonError(error: string, status = 400): Response {
  return Response.json({ error }, { status });
}

function requireNamespace(pathNamespace: string): Response | null {
  if (decodeURIComponent(pathNamespace) !== NAMESPACE) {
    return jsonError("namespace not found", 404);
  }
  return null;
}

function requireActor(req: Request): Actor | Response {
  const actor = actorFromRequest(req);
  if (!actor) return jsonError("unauthorized", 401);
  return actor;
}

async function getClaudeToken(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const proc = Bun.spawn({
      cmd: ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    try {
      const creds = JSON.parse(out.trim());
      return creds.claudeAiOauth?.accessToken || null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function dockerRun(name: string, port: number): Promise<string> {
  const token = await getClaudeToken();
  const cmd = [
    "docker", "run", "-d",
    "--name", `agrp-ws-${name}`,
    "-p", `${port}:31337`,
    "-e", `WORKSPACE_NAME=${name}`,
  ];
  if (token) {
    cmd.push("-e", `ANTHROPIC_API_KEY=${token}`);
  }
  cmd.push("--label", "agrp=workspace", IMAGE);

  const proc = Bun.spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (exitCode !== 0) {
    throw new Error(`docker run failed: ${stderr.trim()}`);
  }
  return stdout.trim().slice(0, 12);
}

async function dockerStop(name: string): Promise<void> {
  const proc = Bun.spawn({
    cmd: ["docker", "rm", "-f", `agrp-ws-${name}`],
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
}

async function dockerPs(): Promise<string[]> {
  const proc = Bun.spawn({
    cmd: ["docker", "ps", "--filter", "label=agrp=workspace", "--format", "{{.Names}}"],
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  return out.trim().split("\n").filter(Boolean);
}

function allocatePort(): number {
  return nextPort++;
}

function runtimeURL(workspace: WorkspaceRecord, path: string): string {
  return `http://${INTERNAL_HOST}:${workspace.port}${path}`;
}

async function waitForRuntime(workspace: WorkspaceRecord) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(runtimeURL(workspace, "/internal/health"));
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await Bun.sleep(250);
  }
  throw new Error(`workspace ${workspace.name} did not become ready`);
}

function publicTopicEventsURL(req: Request, workspace: string, topic: string): string {
  return new URL(topicEventsPath(NAMESPACE, workspace, topic), req.url.replace(/^http/, "ws")).toString();
}

async function runtimeJSON(
  workspace: WorkspaceRecord,
  path: string,
  init?: RequestInit,
  actor?: Actor,
): Promise<Response> {
  const headers = new Headers(init?.headers ?? {});
  if (actor) {
    headers.set("x-workspace-actor", encodeInternalActor(actor));
  }
  return fetch(runtimeURL(workspace, path), { ...init, headers });
}

async function readRuntimeJSON<T>(
  workspace: WorkspaceRecord,
  path: string,
  init?: RequestInit,
  actor?: Actor,
): Promise<T> {
  const response = await runtimeJSON(workspace, path, init, actor);
  if (!response.ok) {
    const body = await response.text();
    let error = body || response.statusText;
    try {
      error = JSON.parse(body).error || error;
    } catch {
      // keep raw body
    }
    throw new Error(`${response.status}:${error}`);
  }
  return await response.json() as T;
}

function topicNames(topics: Array<{ name: string }>): Array<{ name: string }> {
  return topics.map((topic) => ({ name: topic.name }));
}

async function workspaceTopics(req: Request, workspace: WorkspaceRecord) {
  const topics = await readRuntimeJSON<any[]>(workspace, "/internal/topics");
  return topics.map((topic) => attachTopicSummary(NAMESPACE, workspace.name, req, {
    ...topic,
    queue: [],
  }));
}

async function workspaceDetail(req: Request, workspace: WorkspaceRecord): Promise<WorkspaceDetail> {
  return {
    id: workspace.id,
    namespace: workspace.namespace,
    name: workspace.name,
    status: workspace.status,
    createdAt: workspace.createdAt,
    topics: await workspaceTopics(req, workspace),
  };
}

function send(ws: PublicSocket, event: Record<string, unknown>) {
  ws.send(JSON.stringify(event));
}

async function broadcastNamespaceEvent(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  for (const socket of namespaceSockets) {
    socket.send(payload);
  }
}

async function replayNamespaceState(ws: PublicSocket, reqURL: string) {
  const fakeRequest = new Request(reqURL);
  for (const workspace of workspaces.values()) {
    const topics = await workspaceTopics(fakeRequest, workspace);
    send(ws, {
      type: "workspace_created",
      workspace: {
        name: workspace.name,
        status: workspace.status,
        createdAt: workspace.createdAt,
        topics: topicNames(topics),
      },
    });
  }
}

function workspaceRoute(url: URL) {
  return url.pathname.match(/^\/apis\/v1\/namespaces\/([^/]+)\/workspaces(?:\/([^/]+))?(.*)$/);
}

function getWorkspace(name: string): WorkspaceRecord | Response {
  const workspace = workspaces.get(decodeURIComponent(name));
  if (!workspace) return jsonError("workspace not found", 404);
  return workspace;
}

function inventory(workspace: WorkspaceRecord) {
  return [...workspace.tools.values()].map((tool) => ({
    kind: "mcp" as const,
    name: tool.name,
    description: tool.description,
  }));
}

const server = Bun.serve<SocketData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    const topicEventsMatch = url.pathname.match(/^\/apis\/v1\/namespaces\/([^/]+)\/workspaces\/([^/]+)\/topics\/([^/]+)\/events$/);
    if (topicEventsMatch) {
      const namespace = topicEventsMatch[1];
      const workspaceName = topicEventsMatch[2];
      const topicName = topicEventsMatch[3];
      if (!namespace || !workspaceName || !topicName) return jsonError("not found", 404);
      const nsError = requireNamespace(namespace);
      if (nsError) return nsError;
      const workspace = workspaces.get(decodeURIComponent(workspaceName));
      if (!workspace) return jsonError("workspace not found", 404);
      const upgraded = server.upgrade(req, {
        data: {
          kind: "topic" as const,
          workspaceName: workspace.name,
          topicName: decodeURIComponent(topicName),
          actor: null,
          upstream: null,
          queue: [],
          upstreamOpen: false,
        },
      });
      if (!upgraded) return new Response("upgrade failed", { status: 400 });
      return undefined;
    }

    const namespaceEventsMatch = url.pathname.match(/^\/apis\/v1\/namespaces\/([^/]+)\/events$/);
    if (namespaceEventsMatch) {
      const namespace = namespaceEventsMatch[1];
      if (!namespace) return jsonError("not found", 404);
      const nsError = requireNamespace(namespace);
      if (nsError) return nsError;
      const upgraded = server.upgrade(req, {
        data: {
          kind: "namespace" as const,
          authenticated: false,
        },
      });
      if (!upgraded) return new Response("upgrade failed", { status: 400 });
      return undefined;
    }

    if (url.pathname === "/health") {
      const containers = await dockerPs();
      return Response.json({
        status: "ok",
        namespace: NAMESPACE,
        workspaces: workspaces.size,
        containers: containers.length,
      });
    }

    const route = workspaceRoute(url);
    if (!route) return jsonError("not found", 404);
    const namespace = route[1] ?? "";
    const encodedWorkspace = route[2] ?? "";
    const tail = route[3] ?? "";
    const nsError = requireNamespace(namespace);
    if (nsError) return nsError;

    if (tail === "" && req.method === "GET" && encodedWorkspace === "") {
      const actor = requireActor(req);
      if (actor instanceof Response) return actor;
      return Response.json([...workspaces.values()].map((workspace) => ({
        id: workspace.id,
        namespace: workspace.namespace,
        name: workspace.name,
        status: workspace.status,
        createdAt: workspace.createdAt,
      })));
    }

    if (tail === "" && req.method === "POST" && encodedWorkspace === "") {
      const actor = requireActor(req);
      if (actor instanceof Response) return actor;
      const body = await req.json() as { name?: string; topics?: Array<{ name?: string }>; template?: string };
      const name = String(body.name ?? "").trim();
      if (!name) return jsonError("name required", 400);
      if (workspaces.has(name)) return jsonError("already exists", 409);

      const workspace: WorkspaceRecord = {
        id: `${name}.${NAMESPACE}@wsmanager`,
        namespace: NAMESPACE,
        name,
        containerId: "",
        port: allocatePort(),
        status: "starting",
        createdAt: new Date().toISOString(),
        tools: new Map(),
      };

      try {
        workspace.containerId = await dockerRun(name, workspace.port);
        workspaces.set(name, workspace);
        await waitForRuntime(workspace);
        workspace.status = "running";
        const requestedTopics = (body.topics ?? [])
          .map((topic) => String(topic?.name ?? "").trim())
          .filter(Boolean);
        for (const topicName of requestedTopics) {
          await runtimeJSON(workspace, "/internal/topics", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: topicName }),
          });
        }
        const detail = await workspaceDetail(req, workspace);
        await broadcastNamespaceEvent({
          type: "workspace_created",
          workspace: {
            name: workspace.name,
            status: workspace.status,
            createdAt: workspace.createdAt,
            topics: topicNames(detail.topics),
          },
        });
        return Response.json(detail, { status: 201 });
      } catch (error) {
        workspaces.delete(name);
        if (workspace.containerId) {
          await dockerStop(name).catch(() => undefined);
        }
        return jsonError(error instanceof Error ? error.message : String(error), 500);
      }
    }

    if (!encodedWorkspace) return jsonError("not found", 404);
    const workspaceOrResponse = getWorkspace(encodedWorkspace);
    if (workspaceOrResponse instanceof Response) return workspaceOrResponse;
    const workspace = workspaceOrResponse;
    const actor = requireActor(req);
    if (actor instanceof Response) return actor;

    if (tail === "" && req.method === "GET") {
      return Response.json(await workspaceDetail(req, workspace));
    }

    if (tail === "" && req.method === "DELETE") {
      await dockerStop(workspace.name);
      workspaces.delete(workspace.name);
      await broadcastNamespaceEvent({
        type: "workspace_deleted",
        workspace: { name: workspace.name },
      });
      return Response.json({ name: workspace.name, status: "deleted" });
    }

    if (tail === "/topics" && req.method === "GET") {
      const topics = await readRuntimeJSON<any[]>(workspace, "/internal/topics");
      return Response.json(topics.map((topic) => attachTopicSummary(NAMESPACE, workspace.name, req, {
        ...topic,
        queue: [],
      })));
    }

    if (tail === "/topics" && req.method === "POST") {
      const body = await req.json() as { name?: string };
      const topicName = String(body.name ?? "").trim();
      if (!topicName) return jsonError("name required", 400);
      const response = await runtimeJSON(workspace, "/internal/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: topicName }),
      });
      if (!response.ok) {
        const payload = await response.text();
        return jsonError(payload || response.statusText, response.status);
      }
      const topic = await response.json() as {
        name: string;
        activeRun?: TopicState["activeRun"];
        queuedCount?: number;
        createdAt: string;
      };
      await broadcastNamespaceEvent({
        type: "topic_created",
        workspace: workspace.name,
        topic: { name: topic.name },
      });
      return Response.json(attachTopicSummary(NAMESPACE, workspace.name, req, {
        name: topic.name,
        activeRun: topic.activeRun ?? null,
        queuedCount: topic.queuedCount ?? 0,
        createdAt: topic.createdAt,
        queue: [],
      }), { status: 201 });
    }

    const topicMatch = tail.match(/^\/topics\/([^/]+)$/);
    if (topicMatch && req.method === "GET") {
      const topic = await readRuntimeJSON<TopicState>(workspace, `/internal/topics/${topicMatch[1]}`);
      return Response.json(attachTopicState(NAMESPACE, workspace.name, req, topic));
    }

    if (topicMatch && req.method === "DELETE") {
      const topicSegment = topicMatch[1];
      if (!topicSegment) return jsonError("not found", 404);
      const topicName = decodeURIComponent(topicSegment);
      const response = await runtimeJSON(workspace, `/internal/topics/${topicSegment}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.text();
        return jsonError(payload || response.statusText, response.status);
      }
      await broadcastNamespaceEvent({
        type: "topic_deleted",
        workspace: workspace.name,
        topic: { name: topicName },
      });
      return response;
    }

    const queueMatch = tail.match(/^\/topics\/([^/]+)\/queue\/([^/]+)$/);
    if (queueMatch && req.method === "PATCH") {
      const response = await runtimeJSON(workspace, `/internal/topics/${queueMatch[1]}/queue/${queueMatch[2]}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: await req.text(),
      }, actor);
      if (!response.ok) {
        const payload = await response.text();
        return jsonError(payload || response.statusText, response.status);
      }
      return Response.json(attachTopicState(NAMESPACE, workspace.name, req, await response.json() as TopicState));
    }

    if (queueMatch && req.method === "DELETE") {
      const response = await runtimeJSON(workspace, `/internal/topics/${queueMatch[1]}/queue/${queueMatch[2]}`, {
        method: "DELETE",
      }, actor);
      return new Response(response.body, { status: response.status, headers: response.headers });
    }

    const moveMatch = tail.match(/^\/topics\/([^/]+)\/queue\/([^/]+)\/move$/);
    if (moveMatch && req.method === "POST") {
      const response = await runtimeJSON(workspace, `/internal/topics/${moveMatch[1]}/queue/${moveMatch[2]}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await req.text(),
      }, actor);
      if (!response.ok) {
        const payload = await response.text();
        return jsonError(payload || response.statusText, response.status);
      }
      return Response.json(attachTopicState(NAMESPACE, workspace.name, req, await response.json() as TopicState));
    }

    const clearMatch = tail.match(/^\/topics\/([^/]+)\/queue:clear-mine$/);
    if (clearMatch && req.method === "POST") {
      const response = await runtimeJSON(workspace, `/internal/topics/${clearMatch[1]}/queue:clear-mine`, {
        method: "POST",
      }, actor);
      return new Response(response.body, { status: response.status, headers: response.headers });
    }

    const injectMatch = tail.match(/^\/topics\/([^/]+)\/inject$/);
    if (injectMatch && req.method === "POST") {
      const response = await runtimeJSON(workspace, `/internal/topics/${injectMatch[1]}/inject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await req.text(),
      }, actor);
      return new Response(response.body, { status: response.status, headers: response.headers });
    }

    const interruptMatch = tail.match(/^\/topics\/([^/]+)\/interrupt$/);
    if (interruptMatch && req.method === "POST") {
      const response = await runtimeJSON(workspace, `/internal/topics/${interruptMatch[1]}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await req.text(),
      }, actor);
      return new Response(response.body, { status: response.status, headers: response.headers });
    }

    if (tail === "/tools" && req.method === "GET") {
      return Response.json(inventory(workspace));
    }

    if (tail === "/tools" && req.method === "POST") {
      const body = await req.json() as Partial<ManagedTool>;
      const name = String(body.name ?? "").trim();
      if (!name) return jsonError("name required", 400);
      if (workspace.tools.has(name)) return jsonError("already exists", 409);
      if (!body.transport?.url || !body.transport.type) return jsonError("transport required", 400);
      const tool: ManagedTool = {
        kind: "mcp",
        name,
        description: body.description,
        provider: body.provider,
        protocol: "mcp",
        transport: {
          type: body.transport.type,
          url: body.transport.url,
          ...(body.transport.headers ? { headers: body.transport.headers } : {}),
        },
        grants: [],
      };
      workspace.tools.set(name, tool);
      return Response.json(tool, { status: 201 });
    }

    const toolMatch = tail.match(/^\/tools\/([^/]+)$/);
    if (toolMatch && req.method === "GET") {
      const toolName = toolMatch[1];
      if (!toolName) return jsonError("not found", 404);
      const tool = workspace.tools.get(decodeURIComponent(toolName));
      if (!tool) return jsonError("not found", 404);
      return Response.json(tool);
    }

    if (toolMatch && req.method === "DELETE") {
      const name = toolMatch[1] ? decodeURIComponent(toolMatch[1]) : "";
      if (!name) return jsonError("not found", 404);
      if (!workspace.tools.delete(name)) return jsonError("not found", 404);
      return new Response(null, { status: 204 });
    }

    const grantsMatch = tail.match(/^\/tools\/([^/]+)\/grants$/);
    if (grantsMatch && req.method === "POST") {
      const toolName = grantsMatch[1];
      if (!toolName) return jsonError("not found", 404);
      const tool = workspace.tools.get(decodeURIComponent(toolName));
      if (!tool) return jsonError("not found", 404);
      const body = await req.json() as Partial<ManagedToolGrant>;
      const grant: ManagedToolGrant = {
        grantId: `grant_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        subject: String(body.subject ?? "").trim(),
        tools: Array.isArray(body.tools) ? body.tools.map(String) : [],
        access: body.access === "allowed" || body.access === "approval_required" || body.access === "denied"
          ? body.access
          : "approval_required",
        ...(Array.isArray(body.approvers) ? { approvers: body.approvers.map(String) } : {}),
        ...(body.scope && typeof body.scope === "object" ? { scope: body.scope as Record<string, unknown> } : {}),
      };
      if (!grant.subject) return jsonError("subject required", 400);
      tool.grants.push(grant);
      return Response.json(grant, { status: 201 });
    }

    const grantDeleteMatch = tail.match(/^\/tools\/([^/]+)\/grants\/([^/]+)$/);
    if (grantDeleteMatch && req.method === "DELETE") {
      const toolName = grantDeleteMatch[1];
      const grantName = grantDeleteMatch[2];
      if (!toolName || !grantName) return jsonError("not found", 404);
      const tool = workspace.tools.get(decodeURIComponent(toolName));
      if (!tool) return jsonError("not found", 404);
      const grantId = decodeURIComponent(grantName);
      const next = tool.grants.filter((grant) => grant.grantId !== grantId);
      if (next.length === tool.grants.length) return jsonError("not found", 404);
      tool.grants = next;
      return new Response(null, { status: 204 });
    }

    if (tail.startsWith("/files")) {
      const forwardPath = tail.replace(/^\/files/, "/internal/files");
      const response = await runtimeJSON(workspace, `${forwardPath}${url.search}`, {
        method: req.method,
        headers: req.method === "POST" || req.method === "PUT" ? {
          "Content-Type": req.headers.get("Content-Type") || "application/octet-stream",
        } : undefined,
        body: req.method === "GET" || req.method === "DELETE" ? undefined : await req.arrayBuffer(),
      });
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    }

    return jsonError("not found", 404);
  },

  websocket: {
    async message(ws, raw) {
      const data = (ws.data ?? {}) as Record<string, any>;
      let message: any;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", data: "invalid json" });
        return;
      }

      if (data.kind === "namespace") {
        if (!data.authenticated) {
          if (message.type !== "authenticate") {
            send(ws, { type: "error", data: "authenticate first" });
            ws.close();
            return;
          }
          const actor = actorFromToken(String(message.token ?? ""));
          if (!actor) {
            send(ws, { type: "error", data: "unauthorized" });
            ws.close();
            return;
          }
          data.authenticated = true;
          namespaceSockets.add(ws);
          send(ws, { type: "authenticated", actor });
          send(ws, {
            type: "connected",
            protocolVersion: MANAGER_PROTOCOL_VERSION,
            namespace: NAMESPACE,
            replay: true,
          });
          await replayNamespaceState(ws, `http://localhost:${PORT}${namespaceBase(NAMESPACE)}`);
          return;
        }
        send(ws, { type: "error", data: "unsupported message type" });
        return;
      }

      if (data.kind !== "topic") {
        send(ws, { type: "error", data: "unknown socket" });
        ws.close();
        return;
      }

      if (!data.actor) {
        if (message.type !== "authenticate") {
          send(ws, { type: "error", data: "authenticate first" });
          ws.close();
          return;
        }
        const actor = actorFromToken(String(message.token ?? ""));
        if (!actor) {
          send(ws, { type: "error", data: "unauthorized" });
          ws.close();
          return;
        }
        const workspace = workspaces.get(String(data.workspaceName));
        if (!workspace) {
          send(ws, { type: "error", data: "workspace not found" });
          ws.close();
          return;
        }
        data.actor = actor;
        send(ws, { type: "authenticated", actor });

        const upstreamURL = `ws://${INTERNAL_HOST}:${workspace.port}/internal/topics/${encodeURIComponent(String(data.topicName))}/events?actor=${encodeURIComponent(encodeInternalActor(actor))}`;
        const upstream = new WebSocket(upstreamURL);
        data.upstream = upstream;
        upstream.onopen = () => {
          data.upstreamOpen = true;
          for (const pending of data.queue as string[]) {
            upstream.send(pending);
          }
          data.queue = [];
        };
        upstream.onmessage = (event) => {
          ws.send(event.data);
        };
        upstream.onclose = () => {
          ws.close();
        };
        upstream.onerror = () => {
          send(ws, { type: "error", data: "topic upstream failed" });
          ws.close();
        };
        return;
      }

      const upstream = data.upstream as WebSocket | null;
      if (!upstream) {
        send(ws, { type: "error", data: "topic upstream unavailable" });
        return;
      }
      const frame = raw.toString();
      if (data.upstreamOpen) {
        upstream.send(frame);
      } else {
        (data.queue as string[]).push(frame);
      }
    },

    close(ws) {
      const data = (ws.data ?? {}) as Record<string, any>;
      if (data.kind === "namespace") {
        namespaceSockets.delete(ws);
      }
      if (data.upstream) {
        (data.upstream as WebSocket).close();
      }
    },
  },
});

console.log(`[wsmanager] listening on :${PORT}`);
console.log(`[wsmanager] namespace: ${NAMESPACE}`);
console.log(`[wsmanager] image: ${IMAGE}`);
