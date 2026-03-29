/**
 * wsmanager — canonical public API for the Bun reference implementation.
 *
 * Owns namespace/workspace/topic routes, public authentication, and websocket
 * bridging to per-workspace runtimes.
 */

import { actorFromRequest, actorFromToken, bearerTokenFromRequest, encodeInternalActor, mintUnsignedJWT, type Actor } from "./auth.ts";
import { WorkspacesPage, WorkspaceList, ErrorBanner } from "./ui/workspaces.tsx";
import { TopicList } from "./ui/topics.tsx";
import { ClaudeLoginPrompt } from "./ui/login.tsx";
import { WorkspacePage, TopicPage } from "./ui/topic.tsx";
import { renderMarkdownPreview } from "./ui/files.tsx";
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
import { rename, mkdir } from "node:fs/promises";

const PORT = parseInt(process.env.PORT || "31337", 10);
const IMAGE = process.env.WMLET_IMAGE || "agrp-wmlet";
const NAMESPACE = process.env.WS_NAMESPACE || "default";

// ── OAuth config (all optional — if not set, unsigned JWT fallback is used) ──
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || "";
const OAUTH_AUTHORIZE_URL = process.env.OAUTH_AUTHORIZE_URL || "";
const OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL || "";
const OAUTH_USERINFO_URL = process.env.OAUTH_USERINFO_URL || "";
const OAUTH_SCOPES = process.env.OAUTH_SCOPES || "openid profile email";
const OAUTH_ENABLED = !!(OAUTH_CLIENT_ID && OAUTH_AUTHORIZE_URL && OAUTH_TOKEN_URL);

// User directory (Keycloak admin API or compatible)
const USER_DIRECTORY_URL = process.env.USER_DIRECTORY_URL || ""; // e.g. https://keycloak.example.com/admin/realms/myrealm/users
const INTERNAL_HOST = "127.0.0.1";
const PORT_RANGE_START = 52001;
const CONTAINER_HOME = "/root";
const STATIC_PREFIX_RE = /^\/(styles|assets|js|webfonts)\//;
// Claude env keys — no longer forwarded to containers (users log in inside)
const _CLAUDE_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_EXECUTABLE",
  "CLAUDE_CONFIG_DIR",
  "MAX_THINKING_TOKENS",
] as const;

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

interface WorkspaceMember {
  id: string;
  displayName: string;
  role: "owner" | "member";
  addedAt: string;
}

interface WorkspaceRecord extends WorkspaceSummary {
  containerId: string;
  port: number;
  owner?: Actor;
  members: WorkspaceMember[];
  tools: Map<string, ManagedTool>;
  mode: "docker" | "local";
  workdir?: string;          // local mode: host folder
  localProcess?: import("bun").Subprocess;  // local mode: wmlet child process
}

function isMember(workspace: WorkspaceRecord, actor: Actor): boolean {
  return workspace.members.some(m => m.id === actor.id);
}

function requireMember(workspace: WorkspaceRecord, actor: Actor): Response | null {
  if (!isMember(workspace, actor)) {
    return jsonError("access denied: not a workspace member", 403);
  }
  return null;
}

function isOwner(workspace: WorkspaceRecord, actor: Actor): boolean {
  return workspace.members.some(m => m.id === actor.id && m.role === "owner");
}

const workspaces = new Map<string, WorkspaceRecord>();
const namespaceSockets = new Set<PublicSocket>();

// ── JSON persistence for workspaces ──

const DATA_DIR = process.env.DATA_DIR || `${import.meta.dir}/data`;
const WS_FILE = `${DATA_DIR}/workspaces.json`;

interface PersistedWorkspace {
  name: string;
  namespace: string;
  id: string;
  mode: "docker" | "local";
  workdir?: string;
  createdAt: string;
  owner?: { id: string; displayName: string };
  members?: WorkspaceMember[];
}

async function saveWorkspaces(): Promise<void> {
  const records: PersistedWorkspace[] = [];
  for (const ws of workspaces.values()) {
    records.push({
      name: ws.name, namespace: ws.namespace, id: ws.id,
      mode: ws.mode, workdir: ws.workdir,
      createdAt: ws.createdAt,
      owner: ws.owner ? { id: ws.owner.id, displayName: ws.owner.displayName } : undefined,
      members: ws.members,
    });
  }
  const tmpFile = `${WS_FILE}.tmp`;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await Bun.write(tmpFile, JSON.stringify(records, null, 2));
    await rename(tmpFile, WS_FILE);
  } catch (e) {
    console.error("[persist] failed to save workspaces:", e);
  }
}

async function restoreWorkspaces(): Promise<void> {
  const file = Bun.file(WS_FILE);
  if (!(await file.exists())) return;
  let records: PersistedWorkspace[];
  try {
    records = await file.json();
  } catch (e) {
    console.error("[persist] failed to read workspaces:", e);
    return;
  }
  if (!Array.isArray(records)) {
    console.error("[persist] workspaces.json is not an array, skipping restore");
    return;
  }
  for (const rec of records) {
    if (!rec || typeof rec.name !== "string" || typeof rec.mode !== "string" || typeof rec.id !== "string") {
      console.warn("[persist] skipping invalid workspace record:", rec);
      continue;
    }
    const port = await allocatePort();
    const workspace: WorkspaceRecord = {
      id: rec.id, namespace: rec.namespace, name: rec.name,
      containerId: "", port, status: "starting",
      createdAt: rec.createdAt, owner: rec.owner as Actor | undefined,
      members: rec.members || [],
      tools: new Map(), mode: rec.mode, workdir: rec.workdir,
    };
    try {
      if (rec.mode === "local" && rec.workdir) {
        workspace.localProcess = localRun(rec.name, port, rec.workdir);
        workspace.containerId = `local-${workspace.localProcess.pid}`;
      } else if (rec.mode === "docker") {
        const wd = rec.workdir || defaultWorkdir(rec.name);
        workspace.workdir = wd;
        workspace.containerId = await dockerRun(rec.name, port, wd, rec.owner as Actor | undefined);
      }
      workspaces.set(rec.name, workspace);
      await waitForRuntime(workspace);
      workspace.status = "running";
      console.log(`[persist] restored workspace "${rec.name}" (${rec.mode}) on port ${port}`);
    } catch (e) {
      console.error(`[persist] failed to restore workspace "${rec.name}":`, e);
      if (workspace.mode === "local") localStop(workspace);
      else if (workspace.containerId) await dockerStop(rec.name).catch(() => {});
    }
  }
}

function jsonError(error: string, status = 400): Response {
  return Response.json({ error }, { status });
}

function requireNamespace(pathNamespace: string): Response | null {
  if (decodeURIComponent(pathNamespace) !== NAMESPACE) {
    return jsonError("namespace not found", 404);
  }
  return null;
}

function tokenFromCookie(req: Request): string {
  const cookie = req.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)ws-token=([^;]+)/);
  return match?.[1] ?? "";
}

interface ActorResult {
  actor: Actor | null;
  token: string;
}

const LOCAL_ACTOR: Actor = { id: "local-user", displayName: "Local User" };

/** Resolve an actor from a request, trying Bearer token first then cookie, then local fallback. */
function actorFromAny(req: Request): ActorResult {
  const bearer = bearerTokenFromRequest(req);
  if (bearer) {
    return { actor: actorFromToken(bearer), token: bearer };
  }
  const cookie = tokenFromCookie(req);
  if (cookie) {
    return { actor: actorFromToken(cookie), token: cookie };
  }
  // In non-OAuth mode, use a default local actor so UI and htmx work without login
  if (!OAUTH_ENABLED) {
    const localToken = mintUnsignedJWT(LOCAL_ACTOR.id, LOCAL_ACTOR.displayName);
    return { actor: LOCAL_ACTOR, token: localToken };
  }
  return { actor: null, token: "" };
}

function requireActor(req: Request): Actor | Response {
  const { actor } = actorFromAny(req);
  if (actor) return actor;
  return jsonError("unauthorized", 401);
}

async function getClaudeTokenRaw(): Promise<Record<string, unknown> | null> {
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
    return JSON.parse(out.trim());
  } catch {
    return null;
  }
}

/** Default workdir for docker workspaces: data/workspaces/<name>/ */
function defaultWorkdir(name: string): string {
  return `${DATA_DIR}/workspaces/${name}`;
}

async function dockerRun(name: string, port: number, workdir: string, owner?: Actor): Promise<string> {
  // Ensure workdir exists on host
  await mkdir(workdir, { recursive: true });

  // Derive username from owner displayName (lowercase, no spaces, max 32 chars)
  const wsUser = owner
    ? owner.displayName.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32) || "developer"
    : "developer";

  const cmd = [
    "docker", "run", "-d",
    "--name", `agrp-ws-${name}`,
    "-p", `${port}:31337`,
    "-e", `WORKSPACE_NAME=${name}`,
    "-e", `MANAGER_URL=http://host.docker.internal:${PORT}`,
    "-e", `WS_USER=${wsUser}`,
    "-v", `${workdir}:/home/${wsUser}/workspace`,
    "-v", `${workdir}/.claude-auth:/home/${wsUser}/.claude`,
  ];
  // Dev mode: mount local source + node_modules into container to avoid rebuilds
  const appDir = new URL(".", import.meta.url).pathname;
  for (const file of ["wmlet.ts", "auth.ts", "protocol.ts", "tsconfig.json", "package.json"]) {
    cmd.push("-v", `${appDir}${file}:/app/${file}:ro`);
  }
  cmd.push("-v", `${appDir}ui:/app/ui:ro`);
  cmd.push("-v", `${appDir}node_modules:/app/node_modules:ro`);
  cmd.push(
    "--label", "agrp=workspace",
    "--label", `agrp.workspace=${name}`,
    "--label", `agrp.namespace=${NAMESPACE}`,
  );
  if (owner) {
    cmd.push("--label", `agrp.owner.id=${owner.id}`);
    cmd.push("--label", `agrp.owner.name=${owner.displayName}`);
  }
  cmd.push(IMAGE);

  // Remove stale container with the same name (stopped leftovers)
  await Bun.spawn({ cmd: ["docker", "rm", "-f", `agrp-ws-${name}`], stdout: "pipe", stderr: "pipe" }).exited;

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

// ── Local mode: run wmlet as a child process ──

function localRun(name: string, port: number, workdir: string): import("bun").Subprocess {
  const appDir = new URL(".", import.meta.url).pathname;
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    WMLET_PORT: String(port),
    WORKSPACE_DIR: workdir,
    WORKSPACE_NAME: name,
    MANAGER_URL: `http://127.0.0.1:${PORT}`,
  };
  const proc = Bun.spawn({
    cmd: ["bun", "run", `${appDir}wmlet.ts`],
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  console.log(`[local] started wmlet for "${name}" pid=${proc.pid} port=${port} workdir=${workdir}`);
  return proc;
}

function localStop(workspace: WorkspaceRecord): void {
  if (workspace.localProcess) {
    workspace.localProcess.kill();
    console.log(`[local] stopped wmlet for "${workspace.name}"`);
    workspace.localProcess = undefined;
  }
}

interface ContainerInfo {
  container: string;
  containerId: string;
  workspace: string;
  namespace: string;
  owner: { id: string; displayName: string } | null;
  status: string;
  state: string;
  ports: string;
  createdAt: string;
}

async function dockerPs(all = false): Promise<ContainerInfo[]> {
  const format = [
    "{{.Names}}", "{{.ID}}", "{{.Status}}", "{{.State}}", "{{.Ports}}", "{{.CreatedAt}}",
    "{{.Label \"agrp.workspace\"}}", "{{.Label \"agrp.namespace\"}}",
    "{{.Label \"agrp.owner.id\"}}", "{{.Label \"agrp.owner.name\"}}",
  ].join("\t");
  const cmd = ["docker", "ps", ...(all ? ["-a"] : []), "--filter", "label=agrp=workspace", "--format", format];
  const proc = Bun.spawn({ cmd, stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  return out.trim().split("\n").filter(Boolean).map((line) => {
    const [container, containerId, status, state, ports, createdAt, workspace, namespace, ownerId, ownerName] = line.split("\t");
    return {
      container, containerId, workspace, namespace,
      owner: ownerId ? { id: ownerId, displayName: ownerName || ownerId } : null,
      status, state, ports, createdAt,
    };
  });
}

async function allocatePort(): Promise<number> {
  const usedPorts = new Set([...workspaces.values()].map(w => w.port));
  // Try random 5-digit ports (10000-59999)
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = 10000 + Math.floor(Math.random() * 50000);
    if (usedPorts.has(port)) continue;
    try {
      const server = Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {}, open() {}, close() {} } });
      server.stop();
      return port;
    } catch {
      // Port in use
    }
  }
  throw new Error("no available ports after 100 attempts");
}

function runtimeURL(workspace: WorkspaceRecord, path: string): string {
  return `http://${INTERNAL_HOST}:${workspace.port}${path}`;
}

async function waitForRuntime(workspace: WorkspaceRecord) {
  let lastError = "";
  const maxAttempts = 60; // 30 seconds
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(runtimeURL(workspace, "/internal/health"));
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    // Check if process/container died
    if (workspace.mode === "local" && workspace.localProcess) {
      if (workspace.localProcess.exitCode !== null) {
        throw new Error(`workspace "${workspace.name}" process exited with code ${workspace.localProcess.exitCode}`);
      }
    }
    if (workspace.mode === "docker") {
      // Check if container is still running
      try {
        const proc = Bun.spawn({ cmd: ["docker", "inspect", "-f", "{{.State.Status}}", `agrp-ws-${workspace.name}`], stdout: "pipe", stderr: "pipe" });
        const status = (await new Response(proc.stdout).text()).trim();
        if (status === "exited" || status === "dead") {
          const logs = Bun.spawn({ cmd: ["docker", "logs", "--tail", "20", `agrp-ws-${workspace.name}`], stdout: "pipe", stderr: "pipe" });
          const stderr = await new Response(logs.stderr).text();
          const stdout = await new Response(logs.stdout).text();
          throw new Error(`workspace "${workspace.name}" container ${status}. Logs:\n${(stderr + stdout).trim().slice(-500)}`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("workspace")) throw e;
      }
    }
    if (attempt > 0 && attempt % 10 === 0) {
      console.log(`[waitForRuntime] "${workspace.name}" attempt ${attempt}/${maxAttempts}: ${lastError}`);
    }
    await Bun.sleep(500);
  }
  // Grab logs before failing
  let diagInfo = lastError;
  if (workspace.mode === "docker") {
    try {
      const logs = Bun.spawn({ cmd: ["docker", "logs", "--tail", "30", `agrp-ws-${workspace.name}`], stdout: "pipe", stderr: "pipe" });
      const stderr = await new Response(logs.stderr).text();
      const stdout = await new Response(logs.stdout).text();
      diagInfo += `\nContainer logs:\n${(stderr + stdout).trim().slice(-500)}`;
    } catch {}
  }
  throw new Error(`workspace "${workspace.name}" did not become ready after ${maxAttempts * 0.5}s.\nLast error: ${diagInfo}`);
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
  const raw = await readRuntimeJSON<any>(workspace, "/internal/topics");
  const topics = Array.isArray(raw) ? raw : (raw?.topics ?? []);
  return topics.map((topic: any) => attachTopicSummary(NAMESPACE, workspace.name, req, {
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
    containerId: workspace.containerId,
    owner: workspace.owner ? { id: workspace.owner.id, displayName: workspace.owner.displayName } : undefined,
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

// Ensure data directory exists
await Bun.write(`${DATA_DIR}/.keep`, "");

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

    // ── Markdown render API (server-side Shiki + Mermaid) ──
    if (url.pathname === "/api/render-md" && req.method === "POST") {
      const md = await req.text();
      const html = await renderMarkdownPreview(md);
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    // ── User directory search ──
    if (url.pathname === "/api/users" && req.method === "GET") {
      const q = url.searchParams.get("q") || "";
      if (!USER_DIRECTORY_URL) {
        return Response.json([]);
      }
      try {
        // Fetch service account token for admin API
        const tokenResp = await fetch(OAUTH_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: OAUTH_CLIENT_ID,
            client_secret: OAUTH_CLIENT_SECRET,
          }),
        });
        if (!tokenResp.ok) return Response.json([]);
        const { access_token } = await tokenResp.json() as { access_token: string };

        // Search users
        const usersResp = await fetch(`${USER_DIRECTORY_URL}?search=${encodeURIComponent(q)}&max=20`, {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        if (!usersResp.ok) return Response.json([]);
        const users = await usersResp.json() as Array<{ id: string; username: string; firstName?: string; lastName?: string; email?: string }>;

        return Response.json(users.map(u => ({
          id: u.username,
          username: u.username,
          displayName: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username,
          email: u.email || "",
        })));
      } catch (e) {
        console.error("[users] directory search failed:", e);
        return Response.json([]);
      }
    }

    // ── Static assets (public/) ──
    if (STATIC_PREFIX_RE.test(url.pathname)) {
      const file = Bun.file(`${import.meta.dir}/public${url.pathname}`);
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    }

    // ── Server-rendered UI ──
    const uiMatch = url.pathname.match(/^\/(ui)?$/);
    if (uiMatch) {
      const { actor } = actorFromAny(req);
      if (!actor && OAUTH_ENABLED) return Response.redirect("/oauth/login", 302);
      const list = [...workspaces.values()]
        .filter(ws => !ws.members?.length || !actor || ws.members.some(m => m.id === actor.id))
        .map(ws => ({
        id: ws.id, namespace: ws.namespace, name: ws.name,
        status: ws.status, createdAt: ws.createdAt, containerId: ws.containerId,
        owner: ws.owner ? { id: ws.owner.id, displayName: ws.owner.displayName } : undefined,
      }));
      return new Response(WorkspacesPage({ actor, oauthEnabled: OAUTH_ENABLED, workspaces: list }),
        { headers: { "Content-Type": "text/html" } });
    }

    const uiWsMatch = url.pathname.match(/^\/ui\/([^/]+)$/);
    if (uiWsMatch) {
      const { actor } = actorFromAny(req);
      if (!actor && OAUTH_ENABLED) return Response.redirect("/oauth/login", 302);
      const wsName = decodeURIComponent(uiWsMatch[1]!);
      const workspace = workspaces.get(wsName);
      if (!workspace) return new Response("Workspace not found", { status: 404 });
      if (actor && workspace.members.length > 0 && !isMember(workspace, actor)) {
        return new Response("Access denied: you are not a member of this workspace", { status: 403 });
      }
      const topics = await workspaceTopics(req, workspace);
      let agents: Array<{ id: string; name: string; description: string }> = [];
      try {
        const res = await runtimeJSON(workspace, "/agents");
        if (res.ok) {
          const data = await res.json() as { agents?: typeof agents };
          agents = data.agents ?? [];
        }
      } catch {}
      // Pre-fetch file content if ?file= is in URL
      let fileContent: string | undefined;
      const filePath = url.searchParams.get("file");
      if (filePath && workspace) {
        const tab = url.searchParams.get("tab") || undefined;
        const uiBase = `/ui/${encodeURIComponent(wsName)}`;
        const resourcesUrl = `/apis/v1/namespaces/${NAMESPACE}/workspaces/${encodeURIComponent(wsName)}/resources`;
        try {
          const res = await runtimeJSON(workspace, `/resources/${encodeURIComponent(filePath)}?base=${encodeURIComponent(resourcesUrl)}&ui=${encodeURIComponent(uiBase)}${tab ? `&tab=${tab}` : ""}`);
          if (res.ok) fileContent = await res.text();
        } catch {}
      }
      const members = (workspace.members || []).map(m => ({ id: m.id, displayName: m.displayName, role: m.role }));
      return new Response(WorkspacePage({ actor, oauthEnabled: OAUTH_ENABLED, wsName, topics, agents, members, namespace: NAMESPACE, fileContent }),
        { headers: { "Content-Type": "text/html" } });
    }

    const uiTopicMatch = url.pathname.match(/^\/ui\/([^/]+)\/([^/]+)$/);
    if (uiTopicMatch) {
      const { actor, token } = actorFromAny(req);
      if (!actor && OAUTH_ENABLED) return Response.redirect("/oauth/login", 302);
      const wsName = decodeURIComponent(uiTopicMatch[1]!);
      const topicName = decodeURIComponent(uiTopicMatch[2]!);
      const workspace = workspaces.get(wsName);
      if (actor && workspace && workspace.members.length > 0 && !isMember(workspace, actor)) {
        return new Response("Access denied: you are not a member of this workspace", { status: 403 });
      }
      const topics = workspace ? await workspaceTopics(req, workspace) : [];
      let agents: Array<{ id: string; name: string; description: string }> = [];
      if (workspace) {
        try {
          const res = await runtimeJSON(workspace, "/agents");
          if (res.ok) { agents = ((await res.json()) as any).agents ?? []; }
        } catch {}
      }
      // Pre-fetch file content if ?file= is in URL
      let fileContent: string | undefined;
      const filePath = url.searchParams.get("file");
      if (filePath && workspace) {
        const tab = url.searchParams.get("tab") || undefined;
        const uiBase = `/ui/${encodeURIComponent(wsName)}/${encodeURIComponent(topicName)}`;
        const resourcesUrl = `/apis/v1/namespaces/${NAMESPACE}/workspaces/${encodeURIComponent(wsName)}/resources`;
        try {
          const res = await runtimeJSON(workspace, `/resources/${encodeURIComponent(filePath)}?base=${encodeURIComponent(resourcesUrl)}&ui=${encodeURIComponent(uiBase)}${tab ? `&tab=${tab}` : ""}`);
          if (res.ok) fileContent = await res.text();
        } catch {}
      }
      const members = (workspace?.members || []).map(m => ({ id: m.id, displayName: m.displayName, role: m.role }));
      return new Response(TopicPage({ actor, oauthEnabled: OAUTH_ENABLED, wsName, topicName, token, namespace: NAMESPACE, topics, agents, members, fileContent }),
        { headers: { "Content-Type": "text/html" } });
    }

    // ── HTMX partials ──
    if (url.pathname === "/htmx/workspaces" && req.method === "POST") {
      const actor = requireActor(req);
      if (actor instanceof Response) {
        // For htmx, redirect to login instead of returning JSON 401
        if (OAUTH_ENABLED) return new Response("", { status: 200, headers: { "HX-Redirect": "/oauth/login" } });
        return actor;
      }
      const form = await req.formData();
      const name = String(form.get("name") ?? "").trim();

      const currentList = () => [...workspaces.values()].map(ws => ({
        id: ws.id, namespace: ws.namespace, name: ws.name,
        status: ws.status, createdAt: ws.createdAt, containerId: ws.containerId,
        owner: ws.owner ? { id: ws.owner.id, displayName: ws.owner.displayName } : undefined,
      }));
      const htmlResponse = (html: string) => new Response(html, { headers: { "Content-Type": "text/html" } });
      const errorAndList = (msg: string) => htmlResponse(ErrorBanner({ message: msg }) + WorkspaceList({ workspaces: currentList() }));

      if (!name) return errorAndList("Name is required");

      if (workspaces.has(name)) return errorAndList(`Workspace "${name}" already exists`);

      // Check for stale docker container with same name
      const containers = await dockerPs(true);
      const stale = containers.find(c => c.workspace === name);
      if (stale) {
        // Clean up stale container automatically
        await dockerStop(name).catch(() => {});
      }

      const topicNames = String(form.get("topics") ?? "").split(",").map(s => s.trim()).filter(Boolean);
      const mode = String(form.get("mode") || "docker") as "docker" | "local";
      const workdir = String(form.get("workdir") ?? "").trim();

      const resolvedWorkdir = workdir || defaultWorkdir(name);
      console.log(`[create] workspace "${name}" mode=${mode} workdir=${resolvedWorkdir} actor=${actor.id}`);

      const port = await allocatePort();
      console.log(`[create] allocated port ${port} for "${name}"`);

      const now = new Date().toISOString();
      const workspace: WorkspaceRecord = {
        id: `${name}.${NAMESPACE}@wsmanager`, namespace: NAMESPACE, name,
        containerId: "", port, status: "starting",
        createdAt: now, owner: actor, tools: new Map(),
        members: [{ id: actor.id, displayName: actor.displayName, role: "owner", addedAt: now }],
        mode, workdir: resolvedWorkdir,
      };
      try {
        if (mode === "local") {
          workspace.localProcess = localRun(name, workspace.port, resolvedWorkdir);
          workspace.containerId = `local-${workspace.localProcess.pid}`;
        } else {
          console.log(`[create] starting docker for "${name}"...`);
          workspace.containerId = await dockerRun(name, workspace.port, resolvedWorkdir, actor);
          console.log(`[create] docker container ${workspace.containerId} for "${name}"`);
        }
        workspaces.set(name, workspace);
        console.log(`[create] waiting for runtime "${name}" on port ${port}...`);
        await waitForRuntime(workspace);
        workspace.status = "running";
        await saveWorkspaces();
        console.log(`[create] workspace "${name}" is running`);
        for (const tn of topicNames) {
          await runtimeJSON(workspace, "/internal/topics", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: tn }),
          });
        }
      } catch (e) {
        console.error(`[create] workspace "${name}" failed:`, e);
        workspaces.delete(name);
        await saveWorkspaces();
        if (workspace.mode === "local") localStop(workspace);
        else if (workspace.containerId) await dockerStop(name).catch(() => {});
        return errorAndList(e instanceof Error ? e.message : String(e));
      }

      return htmlResponse(WorkspaceList({ workspaces: currentList() }));
    }

    const htmxTopicMatch = url.pathname.match(/^\/htmx\/([^/]+)\/topics$/);
    if (htmxTopicMatch && req.method === "POST") {
      const actor = requireActor(req);
      if (actor instanceof Response) {
        if (OAUTH_ENABLED) return new Response("", { status: 200, headers: { "HX-Redirect": "/oauth/login" } });
        return actor;
      }
      const wsName = decodeURIComponent(htmxTopicMatch[1]!);
      const workspace = workspaces.get(wsName);
      if (!workspace) return new Response("not found", { status: 404 });

      const form = await req.formData();
      const name = String(form.get("name") ?? "").trim();
      if (!name) return new Response("name required", { status: 400 });

      const res = await runtimeJSON(workspace, "/internal/topics", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      // If Claude not authenticated, return login prompt HTML
      if (res.status === 401) {
        const err = await res.json() as { error?: string };
        if (err.error === "claude_not_authenticated") {
          return new Response(ClaudeLoginPrompt({ wsName, namespace: NAMESPACE }),
            { headers: { "Content-Type": "text/html" } });
        }
      }

      const topics = await workspaceTopics(req, workspace);
      return new Response(TopicList({ wsName, topics }),
        { headers: { "Content-Type": "text/html" } });
    }

    // ── OAuth endpoints ──
    if (url.pathname === "/oauth/config") {
      return Response.json({ enabled: OAUTH_ENABLED });
    }

    if (url.pathname === "/oauth/logout") {
      const res = Response.redirect("/ui", 302);
      res.headers.set("Set-Cookie", "ws-token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      return res;
    }

    if (url.pathname === "/oauth/login" && OAUTH_ENABLED) {
      const redirectUri = `${(req.headers.get("x-forwarded-proto") || url.protocol.replace(":",""))}://${url.host}/oauth/callback`;
      const params = new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: OAUTH_SCOPES,
      });
      return Response.redirect(`${OAUTH_AUTHORIZE_URL}?${params}`, 302);
    }

    if (url.pathname === "/oauth/callback" && OAUTH_ENABLED) {
      const code = url.searchParams.get("code");
      if (!code) return jsonError("missing code", 400);

      const redirectUri = `${(req.headers.get("x-forwarded-proto") || url.protocol.replace(":",""))}://${url.host}/oauth/callback`;
      try {
        // Exchange code for access token
        const tokenRes = await fetch(OAUTH_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: OAUTH_CLIENT_ID,
            client_secret: OAUTH_CLIENT_SECRET,
            code,
            redirect_uri: redirectUri,
          }),
        });
        if (!tokenRes.ok) {
          const body = await tokenRes.text();
          return jsonError(`token exchange failed: ${body}`, 502);
        }
        const tokenData = await tokenRes.json() as Record<string, unknown>;
        const accessToken = String(tokenData.access_token ?? "");
        if (!accessToken) return jsonError("no access_token in response", 502);

        // Fetch user info
        let sub = "", displayName = "", email = "";
        if (OAUTH_USERINFO_URL) {
          const userRes = await fetch(OAUTH_USERINFO_URL, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (userRes.ok) {
            const user = await userRes.json() as Record<string, unknown>;
            sub = String(user.preferred_username ?? user.login ?? user.sub ?? user.id ?? "");
            displayName = String(user.name ?? user.display_name ?? user.preferred_username ?? user.login ?? "");
            email = String(user.email ?? "");
          }
        }

        // Fallback: decode id_token if present
        if (!sub && tokenData.id_token) {
          try {
            const [, payload] = String(tokenData.id_token).split(".");
            const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
            sub = sub || String(claims.preferred_username ?? claims.sub ?? "");
            displayName = displayName || String(claims.name ?? claims.preferred_username ?? "");
            email = email || String(claims.email ?? "");
          } catch { /* ignore */ }
        }

        if (!sub) sub = email || "unknown";
        if (!displayName) displayName = email || sub;

        const jwt = mintUnsignedJWT(sub, displayName);
        const redirect = Response.redirect(`${url.protocol}//${url.host}/ui`, 302);
        redirect.headers.set("Set-Cookie", `ws-token=${jwt}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
        return redirect;
      } catch (e) {
        return jsonError(`oauth error: ${e instanceof Error ? e.message : e}`, 502);
      }
    }

    if (url.pathname === "/internal/token") {
      const raw = await getClaudeTokenRaw();
      if (!raw) return jsonError("no token available", 404);
      return Response.json(raw);
    }

    if (url.pathname === "/health") {
      const containers = await dockerPs(true);
      return Response.json({
        status: "ok",
        namespace: NAMESPACE,
        workspaces: workspaces.size,
        containers: containers.map((c) => ({
          container: c.container,
          containerId: c.containerId,
          workspace: c.workspace,
          namespace: c.namespace,
          owner: c.owner,
          status: c.status,
          state: c.state,
        })),
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
      return Response.json([...workspaces.values()]
        .filter(ws => ws.members.length === 0 || isMember(ws, actor))
        .map((workspace) => ({
          id: workspace.id,
          namespace: workspace.namespace,
          name: workspace.name,
          status: workspace.status,
          createdAt: workspace.createdAt,
          containerId: workspace.containerId,
          owner: workspace.owner ? { id: workspace.owner.id, displayName: workspace.owner.displayName } : undefined,
        })));
    }

    if (tail === "" && req.method === "POST" && encodedWorkspace === "") {
      const actor = requireActor(req);
      if (actor instanceof Response) return actor;
      const body = await req.json() as { name?: string; topics?: Array<{ name?: string }>; template?: string; mode?: string; workdir?: string };
      const name = String(body.name ?? "").trim();
      if (!name) return jsonError("name required", 400);
      if (workspaces.has(name)) return jsonError("already exists", 409);
      const mode = (body.mode === "local" ? "local" : "docker") as "docker" | "local";
      const workdir = String(body.workdir ?? "").trim();
      const resolvedWorkdir = workdir || defaultWorkdir(name);

      const now = new Date().toISOString();
      const workspace: WorkspaceRecord = {
        id: `${name}.${NAMESPACE}@wsmanager`,
        namespace: NAMESPACE,
        name,
        containerId: "",
        port: await allocatePort(),
        status: "starting",
        createdAt: now,
        owner: actor,
        members: [{ id: actor.id, displayName: actor.displayName, role: "owner", addedAt: now }],
        tools: new Map(),
        mode,
        workdir: resolvedWorkdir,
      };

      try {
        if (mode === "local") {
          workspace.localProcess = localRun(name, workspace.port, resolvedWorkdir);
          workspace.containerId = `local-${workspace.localProcess.pid}`;
        } else {
          workspace.containerId = await dockerRun(name, workspace.port, resolvedWorkdir, actor);
        }
        workspaces.set(name, workspace);
        await waitForRuntime(workspace);
        workspace.status = "running";
        await saveWorkspaces();
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
        await saveWorkspaces();
        if (workspace.mode === "local") localStop(workspace);
        else if (workspace.containerId) await dockerStop(name).catch(() => undefined);
        return jsonError(error instanceof Error ? error.message : String(error), 500);
      }
    }

    if (!encodedWorkspace) return jsonError("not found", 404);
    const workspaceOrResponse = getWorkspace(encodedWorkspace);
    if (workspaceOrResponse instanceof Response) return workspaceOrResponse;
    const workspace = workspaceOrResponse;
    const actor = requireActor(req);
    if (actor instanceof Response) return actor;

    // Members-only access control
    if (workspace.members.length > 0) {
      const memberError = requireMember(workspace, actor);
      if (memberError) return memberError;
    }

    // ── Members management ──
    if (tail === "/members" && req.method === "GET") {
      return Response.json(workspace.members);
    }

    if (tail === "/members" && req.method === "POST") {
      if (!isOwner(workspace, actor)) return jsonError("only owner can invite members", 403);
      const body = await req.json() as { id?: string; displayName?: string };
      const memberId = String(body.id ?? "").trim();
      const memberName = String(body.displayName ?? memberId).trim();
      if (!memberId) return jsonError("member id required", 400);
      if (workspace.members.some(m => m.id === memberId)) return jsonError("already a member", 409);
      const member: WorkspaceMember = { id: memberId, displayName: memberName, role: "member", addedAt: new Date().toISOString() };
      workspace.members.push(member);
      await saveWorkspaces();
      return Response.json(member, { status: 201 });
    }

    if (tail.startsWith("/members/") && req.method === "DELETE") {
      if (!isOwner(workspace, actor)) return jsonError("only owner can remove members", 403);
      const memberId = decodeURIComponent(tail.slice("/members/".length));
      const idx = workspace.members.findIndex(m => m.id === memberId);
      if (idx === -1) return jsonError("member not found", 404);
      if (workspace.members[idx].role === "owner") return jsonError("cannot remove owner", 400);
      workspace.members.splice(idx, 1);
      await saveWorkspaces();
      return Response.json({ removed: memberId });
    }

    // ── Claude auth: status, login, credentials ──
    if (tail === "/auth/status" && req.method === "GET") {
      try {
        const res = await runtimeJSON(workspace, "/internal/auth/status");
        if (res.ok) return new Response(res.body, { headers: { "Content-Type": "application/json" } });
        return Response.json({ authenticated: false });
      } catch {
        return Response.json({ authenticated: false });
      }
    }

    // Stream workspace logs as SSE (proxy to wmlet)
    if (tail === "/logs/stream" && req.method === "GET") {
      try {
        const res = await runtimeJSON(workspace, "/internal/logs");
        return new Response(res.body, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      } catch {
        return jsonError("logs unavailable", 502);
      }
    }

    if (tail === "/exec" && req.method === "POST") {
      const body = await req.text();
      const res = await runtimeJSON(workspace, "/internal/exec", {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      });
      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
    }

    if (tail === "/auth/login" && req.method === "POST") {
      try {
        const res = await runtimeJSON(workspace, "/internal/auth/login", { method: "POST" });
        return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return jsonError("login failed", 500);
      }
    }

    if (tail === "/auth/token" && req.method === "POST") {
      const body = await req.text();
      const res = await runtimeJSON(workspace, "/internal/auth/token", {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
      });
      return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
    }

    if (tail === "/auth/code" && req.method === "POST") {
      try {
        const body = await req.text();
        const res = await runtimeJSON(workspace, "/internal/auth/code", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        return new Response(res.body, { status: res.status, headers: { "Content-Type": "application/json" } });
      } catch (e) {
        return jsonError("code submission failed", 500);
      }
    }

    if (tail === "/auth/credentials" && req.method === "POST") {
      if (!isOwner(workspace, actor)) return jsonError("only owner can set credentials", 403);
      const creds = await req.json();
      try {
        const res = await runtimeJSON(workspace, "/internal/auth/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(creds),
        });
        if (!res.ok) return jsonError("failed to write credentials", 500);
        return Response.json({ ok: true });
      } catch {
        return jsonError("failed to set credentials", 500);
      }
    }

    if (tail === "" && req.method === "GET") {
      return Response.json(await workspaceDetail(req, workspace));
    }

    if (tail === "/logs" && req.method === "GET") {
      const lines = url.searchParams.get("lines") || "100";
      const proc = Bun.spawn({
        cmd: ["docker", "logs", "--tail", lines, `agrp-ws-${workspace.name}`],
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const text = stderr + stdout;
      if (req.headers.get("accept")?.includes("text/html")) {
        return new Response(
          `<pre class="text-xs text-gray-500 whitespace-pre-wrap max-h-48 overflow-y-auto bg-gray-50 p-2 m-2 rounded">${Bun.escapeHTML(text)}</pre>`,
          { headers: { "Content-Type": "text/html" } },
        );
      }
      return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (tail === "" && req.method === "DELETE") {
      if (workspace.mode === "local") localStop(workspace);
      else await dockerStop(workspace.name);
      workspaces.delete(workspace.name);
      await saveWorkspaces();
      await broadcastNamespaceEvent({
        type: "workspace_deleted",
        workspace: { name: workspace.name },
      });
      return Response.json({ name: workspace.name, status: "deleted" });
    }

    if (tail === "/topics" && req.method === "GET") {
      const raw = await readRuntimeJSON<any>(workspace, "/internal/topics");
      const topics = Array.isArray(raw) ? raw : (raw?.topics ?? []);
      return Response.json(topics.map((topic: any) => attachTopicSummary(NAMESPACE, workspace.name, req, {
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
      const response = await runtimeJSON(workspace, `/internal/topics/${topicMatch[1]}`);
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return jsonError(body || response.statusText, response.status);
      }
      const topic = await response.json() as TopicState;
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
      // Map manager's simplified /files API to wmlet's /internal/files sub-paths
      let forwardPath: string;
      if (req.method === "PUT") {
        forwardPath = "/internal/files/content";
      } else if (req.method === "GET" && url.searchParams.get("content") === "true") {
        forwardPath = "/internal/files/content";
      } else {
        forwardPath = tail.replace(/^\/files/, "/internal/files");
      }
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

    // Proxy /agents and /resources/* to wmlet (public workspace API)
    if (tail === "/agents" && req.method === "GET") {
      const response = await runtimeJSON(workspace, "/agents");
      return new Response(response.body, { status: response.status, headers: response.headers });
    }

    if (tail.startsWith("/resources")) {
      const fwdHeaders: Record<string, string> = {};
      if (req.method === "PUT" || req.method === "POST") {
        fwdHeaders["Content-Type"] = req.headers.get("Content-Type") || "text/plain";
      }
      const acceptHeader = req.headers.get("Accept");
      if (acceptHeader) fwdHeaders["Accept"] = acceptHeader;
      const response = await runtimeJSON(workspace, `${tail}${url.search}`, {
        method: req.method,
        headers: Object.keys(fwdHeaders).length > 0 ? fwdHeaders : undefined,
        body: req.method === "GET" || req.method === "DELETE" ? undefined : await req.text(),
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
        if (workspace.members.length > 0 && !isMember(workspace, actor)) {
          send(ws, { type: "error", data: "access denied: not a workspace member" });
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

// Restore persisted workspaces after server is listening
await restoreWorkspaces();
