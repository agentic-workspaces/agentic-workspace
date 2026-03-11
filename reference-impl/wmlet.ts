/**
 * wmlet — workspace agent inside a container.
 *
 * Manages topics — named conversation threads, each backed by a separate
 * claude-agent-acp process with its own ACP session.
 *
 * REST API for topic management, WebSocket for ACP communication.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type {
  Client,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";

const PORT = parseInt(process.env.WMLET_PORT || process.env.PORT || "31337");
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
const BIN_DIR = `${process.cwd()}/node_modules/.bin`;

// --- State ---

interface Topic {
  name: string;
  connection: ClientSideConnection;
  process: ChildProcess;
  sessionId: string;
  clients: Set<string>;
  log: Array<{ type: string; data: any; ts: string }>;
  busy: boolean;
  createdAt: string;
}

const topics = new Map<string, Topic>();
const wsClients = new Map<string, any>();

// --- ACP ---

function cleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION;
  return env;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

function broadcastToTopic(topicName: string, msg: any) {
  const topic = topics.get(topicName);
  if (!topic) return;
  const data = JSON.stringify(msg);
  for (const clientId of topic.clients) {
    const ws = wsClients.get(clientId);
    if (ws) ws.send(data);
  }
}

async function createTopic(name: string): Promise<Topic> {
  console.log(`[wmlet] creating topic: ${name}`);

  const command = `${BIN_DIR}/claude-agent-acp`;
  const proc = spawn(command, [], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: WORKSPACE_DIR,
    env: cleanEnv(),
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) console.error(`[${name}:stderr] ${line}`);
  });

  if (!proc.stdin || !proc.stdout) {
    throw new Error("Failed to create ACP stdio pipes");
  }

  const input = Writable.toWeb(proc.stdin);
  const output = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  const clientImpl: Client = {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      const update = params.update as any;
      const updateType = update.sessionUpdate;
      if (!updateType) return;

      const topic = topics.get(name);
      if (topic) {
        topic.log.push({ type: updateType, data: update, ts: new Date().toISOString() });
      }

      switch (updateType) {
        case "agent_message_chunk": {
          const text = update.content?.text;
          if (text) broadcastToTopic(name, { type: "text", data: text });
          break;
        }
        case "tool_call": {
          broadcastToTopic(name, {
            type: "tool_call",
            toolCallId: update.toolCallId,
            title: update.title,
            kind: update.kind,
            status: update.status,
          });
          break;
        }
        case "tool_call_update": {
          broadcastToTopic(name, {
            type: "tool_update",
            toolCallId: update.toolCallId,
            status: update.status,
            title: update.title,
          });
          break;
        }
      }
    },

    async requestPermission(
      params: RequestPermissionRequest
    ): Promise<RequestPermissionResponse> {
      console.log(`[${name}] permission request:`, JSON.stringify(params));
      return { approved: true };
    },
  };

  const connection = new ClientSideConnection(() => clientImpl, stream);

  await withTimeout(
    connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "wmlet", version: "0.1.0" },
    }),
    30_000,
    `${name} ACP initialize`
  );

  const acpSession = await withTimeout(
    connection.newSession({ cwd: WORKSPACE_DIR, mcpServers: [] }),
    30_000,
    `${name} ACP newSession`
  );

  console.log(`[wmlet] topic "${name}" ready, session: ${acpSession.sessionId}`);

  const topic: Topic = {
    name,
    connection,
    process: proc,
    sessionId: acpSession.sessionId,
    clients: new Set(),
    log: [],
    busy: false,
    createdAt: new Date().toISOString(),
  };

  proc.on("exit", (code) => {
    console.log(`[wmlet] topic "${name}" agent exited: ${code}`);
    topics.delete(name);
    broadcastToTopic(name, { type: "system", data: `agent exited (${code})` });
  });

  topics.set(name, topic);
  return topic;
}

async function promptTopic(topicName: string, text: string) {
  const topic = topics.get(topicName);
  if (!topic) return;
  if (topic.busy) {
    broadcastToTopic(topicName, { type: "system", data: "agent is busy, wait..." });
    return;
  }

  topic.busy = true;
  broadcastToTopic(topicName, { type: "system", data: "thinking..." });

  try {
    await topic.connection.prompt({
      sessionId: topic.sessionId,
      prompt: [{ type: "text", text }],
    });
    broadcastToTopic(topicName, { type: "done" });
  } catch (err: any) {
    console.error(`[${topicName}] prompt error:`, err);
    broadcastToTopic(topicName, { type: "error", data: err.message });
  } finally {
    topic.busy = false;
  }
}

function deleteTopic(name: string): boolean {
  const topic = topics.get(name);
  if (!topic) return false;
  topic.process.kill();
  topics.delete(name);
  for (const clientId of topic.clients) {
    const ws = wsClients.get(clientId);
    if (ws) ws.send(JSON.stringify({ type: "system", data: "topic archived" }));
  }
  return true;
}

// --- Server ---

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket: /acp/:topic
    const acpMatch = url.pathname.match(/^\/acp\/([^/]+)$/);
    if (acpMatch) {
      const topicName = acpMatch[1];
      const upgraded = server.upgrade(req, { data: { topicName } });
      if (!upgraded) return new Response("upgrade failed", { status: 400 });
      return undefined;
    }
    // Backward compat: /acp?session=X → /acp/X
    if (url.pathname === "/acp") {
      const topicName = url.searchParams.get("session") || url.searchParams.get("topic") || "general";
      const upgraded = server.upgrade(req, { data: { topicName } });
      if (!upgraded) return new Response("upgrade failed", { status: 400 });
      return undefined;
    }

    // REST: topics
    if (url.pathname === "/topics" && req.method === "GET") {
      return Response.json(
        [...topics.values()].map((t) => ({
          name: t.name,
          clients: t.clients.size,
          busy: t.busy,
          logSize: t.log.length,
          createdAt: t.createdAt,
        }))
      );
    }

    if (url.pathname === "/topics" && req.method === "POST") {
      const body = await req.json() as { name: string };
      if (!body.name) return Response.json({ error: "name required" }, { status: 400 });
      if (topics.has(body.name)) return Response.json({ error: "already exists" }, { status: 409 });
      try {
        const topic = await createTopic(body.name);
        return Response.json({
          name: topic.name,
          acp: `ws://localhost:${PORT}/acp/${topic.name}`,
          createdAt: topic.createdAt,
        }, { status: 201 });
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    const topicMatch = url.pathname.match(/^\/topics\/([^/]+)$/);
    if (topicMatch && req.method === "GET") {
      const topic = topics.get(topicMatch[1]);
      if (!topic) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({
        name: topic.name,
        clients: topic.clients.size,
        busy: topic.busy,
        logSize: topic.log.length,
        acp: `ws://localhost:${PORT}/acp/${topic.name}`,
        createdAt: topic.createdAt,
      });
    }

    if (topicMatch && req.method === "DELETE") {
      const ok = deleteTopic(topicMatch[1]);
      if (!ok) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({ name: topicMatch[1], status: "archived" });
    }

    // Health
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        hasApiKey: !!process.env.ANTHROPIC_API_KEY,
        topics: [...topics.keys()],
      });
    }

    return Response.json({
      service: "wmlet",
      endpoints: [
        "GET    /health           — health check",
        "GET    /topics           — list topics",
        "POST   /topics           — create topic",
        "GET    /topics/:name     — get topic",
        "DELETE /topics/:name     — archive topic",
        "WS     /acp/:topic      — connect to topic",
      ],
    });
  },

  websocket: {
    async open(ws) {
      const clientId = crypto.randomUUID();
      const topicName = (ws.data as any).topicName;
      (ws as any)._clientId = clientId;
      (ws as any)._topicName = topicName;
      wsClients.set(clientId, ws);

      console.log(`[wmlet] client ${clientId} joining topic "${topicName}"`);

      let topic = topics.get(topicName);
      if (!topic) {
        try {
          ws.send(JSON.stringify({ type: "system", data: "starting agent..." }));
          topic = await createTopic(topicName);
        } catch (err: any) {
          console.error(`[wmlet] failed to create topic:`, err);
          ws.send(JSON.stringify({ type: "error", data: err.message }));
          ws.close();
          return;
        }
      }
      topic.clients.add(clientId);

      ws.send(JSON.stringify({
        type: "connected",
        topic: topicName,
      }));
    },

    message(ws, raw) {
      const topicName = (ws as any)._topicName;
      const msg = JSON.parse(raw.toString());

      if (msg.type === "prompt") {
        promptTopic(topicName, msg.data);
      }
    },

    close(ws) {
      const clientId = (ws as any)._clientId;
      const topicName = (ws as any)._topicName;
      wsClients.delete(clientId);
      const topic = topics.get(topicName);
      if (topic) topic.clients.delete(clientId);
      console.log(`[wmlet] client ${clientId} left topic "${topicName}"`);
    },
  },
});

console.log(`[wmlet] listening on :${PORT}`);
console.log(`[wmlet] workspace: ${WORKSPACE_DIR}`);
console.log(`[wmlet] API key: ${process.env.ANTHROPIC_API_KEY ? "present" : "missing"}`);
