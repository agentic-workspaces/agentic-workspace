/**
 * wmlet — workspace manager inside the container.
 *
 * Phase 1: launch claude-code, expose ACP endpoint.
 */

import { spawn, type Subprocess } from "bun";

const PORT = parseInt(process.env.PORT || "31337");
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";

// --- State ---

interface Session {
  id: string;
  proc: Subprocess;
  clients: Set<string>;
  log: string[];
}

const sessions = new Map<string, Session>();
const wsClients = new Map<string, any>();

// --- Launch claude-code ---

function createSession(id: string): Session {
  console.log(`[wmlet] creating session: ${id}`);

  const proc = spawn({
    cmd: ["claude", "--verbose"],
    cwd: WORKSPACE_DIR,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TERM: "dumb",
      NO_COLOR: "1",
    },
  });

  const session: Session = { id, proc, clients: new Set(), log: [] };

  // Read stdout
  if (proc.stdout) {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        session.log.push(text);
        // Broadcast to connected clients
        for (const clientId of session.clients) {
          const ws = wsClients.get(clientId);
          if (ws) ws.send(JSON.stringify({ type: "output", session: id, data: text }));
        }
      }
    })();
  }

  // Read stderr
  if (proc.stderr) {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        session.log.push(`[stderr] ${text}`);
        for (const clientId of session.clients) {
          const ws = wsClients.get(clientId);
          if (ws) ws.send(JSON.stringify({ type: "stderr", session: id, data: text }));
        }
      }
    })();
  }

  proc.exited.then((code) => {
    console.log(`[wmlet] session ${id} exited: ${code}`);
    sessions.delete(id);
  });

  sessions.set(id, session);
  return session;
}

function sendToSession(sessionId: string, text: string) {
  const session = sessions.get(sessionId);
  if (!session?.proc.stdin) return false;
  const writer = session.proc.stdin.getWriter();
  writer.write(new TextEncoder().encode(text + "\n"));
  writer.releaseLock();
  return true;
}

// --- Server ---

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === "/acp") {
      const sessionId = url.searchParams.get("session") || "default";
      const upgraded = server.upgrade(req, { data: { sessionId } });
      if (!upgraded) return new Response("upgrade failed", { status: 400 });
      return undefined;
    }

    // Health
    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        sessions: [...sessions.keys()],
        clients: wsClients.size,
      });
    }

    // List sessions
    if (url.pathname === "/sessions" && req.method === "GET") {
      return Response.json(
        [...sessions.entries()].map(([id, s]) => ({
          id,
          clients: s.clients.size,
          logLines: s.log.length,
        }))
      );
    }

    return new Response("wmlet\n\nGET /health\nGET /sessions\nWS  /acp?session=<id>\n");
  },

  websocket: {
    open(ws) {
      const clientId = crypto.randomUUID();
      const { sessionId } = ws.data as any;
      (ws as any)._clientId = clientId;
      (ws as any)._sessionId = sessionId;
      wsClients.set(clientId, ws);

      // Create or join session
      let session = sessions.get(sessionId);
      if (!session) {
        session = createSession(sessionId);
      }
      session.clients.add(clientId);

      console.log(`[wmlet] client ${clientId} joined session ${sessionId}`);

      // Send history
      ws.send(JSON.stringify({
        type: "connected",
        session: sessionId,
        history: session.log,
      }));
    },

    message(ws, raw) {
      const sessionId = (ws as any)._sessionId;
      const msg = JSON.parse(raw.toString());

      if (msg.type === "input") {
        sendToSession(sessionId, msg.data);
      }
    },

    close(ws) {
      const clientId = (ws as any)._clientId;
      const sessionId = (ws as any)._sessionId;
      wsClients.delete(clientId);

      const session = sessions.get(sessionId);
      if (session) {
        session.clients.delete(clientId);
        console.log(`[wmlet] client ${clientId} left session ${sessionId}`);
      }
    },
  },
});

console.log(`[wmlet] listening on :${PORT}`);
console.log(`[wmlet] workspace: ${WORKSPACE_DIR}`);
console.log(`[wmlet] connect: ws://localhost:${PORT}/acp?session=default`);
