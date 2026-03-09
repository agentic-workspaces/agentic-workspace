/**
 * wsmanager — workspace manager.
 *
 * REST API that creates/lists/deletes workspaces as Docker containers.
 * Each workspace runs wmlet + claude inside a container with its own ACP port.
 */

const PORT = parseInt(process.env.PORT || "31337");
const IMAGE = process.env.WMLET_IMAGE || "agrp-wmlet";
const HOST = process.env.HOST || "localhost";
const PORT_RANGE_START = 52001;

// --- State ---

interface Workspace {
  id: string;
  name: string;
  containerId: string;
  port: number;
  status: "starting" | "running" | "stopped";
  createdAt: string;
}

const workspaces = new Map<string, Workspace>();
let nextPort = PORT_RANGE_START;

// --- Credentials ---

async function getClaudeToken(): Promise<string | null> {
  // Read OAuth token from macOS keychain
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
}

// --- Docker helpers ---

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

  return stdout.trim().slice(0, 12); // short container id
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

// --- API ---

function allocatePort(): number {
  return nextPort++;
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // POST /workspaces — create
    if (url.pathname === "/workspaces" && req.method === "POST") {
      const body = await req.json() as { name: string };
      const name = body.name;

      if (!name) {
        return Response.json({ error: "name required" }, { status: 400 });
      }
      if (workspaces.has(name)) {
        return Response.json({ error: "already exists" }, { status: 409 });
      }

      const port = allocatePort();
      try {
        const containerId = await dockerRun(name, port);
        const ws: Workspace = {
          id: name,
          name,
          containerId,
          port,
          status: "running",
          createdAt: new Date().toISOString(),
        };
        workspaces.set(name, ws);

        return Response.json({
          name,
          status: "running",
          acp: `ws://${HOST}:${port}/acp`,
          api: `http://${HOST}:${port}`,
        }, { status: 201 });
      } catch (e: any) {
        return Response.json({ error: e.message }, { status: 500 });
      }
    }

    // GET /workspaces — list
    if (url.pathname === "/workspaces" && req.method === "GET") {
      const list = [...workspaces.values()].map((ws) => ({
        name: ws.name,
        status: ws.status,
        acp: `ws://${HOST}:${ws.port}/acp`,
        createdAt: ws.createdAt,
      }));
      return Response.json(list);
    }

    // GET /workspaces/:name
    const getMatch = url.pathname.match(/^\/workspaces\/([^/]+)$/);
    if (getMatch && req.method === "GET") {
      const ws = workspaces.get(getMatch[1]);
      if (!ws) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json({
        name: ws.name,
        status: ws.status,
        containerId: ws.containerId,
        acp: `ws://${HOST}:${ws.port}/acp`,
        api: `http://${HOST}:${ws.port}`,
        createdAt: ws.createdAt,
      });
    }

    // DELETE /workspaces/:name
    const delMatch = url.pathname.match(/^\/workspaces\/([^/]+)$/);
    if (delMatch && req.method === "DELETE") {
      const name = delMatch[1];
      const ws = workspaces.get(name);
      if (!ws) return Response.json({ error: "not found" }, { status: 404 });

      await dockerStop(name);
      workspaces.delete(name);
      return Response.json({ name, status: "deleted" });
    }

    // GET /health
    if (url.pathname === "/health") {
      const containers = await dockerPs();
      return Response.json({
        status: "ok",
        workspaces: workspaces.size,
        containers: containers.length,
      });
    }

    return Response.json({
      service: "wsmanager",
      endpoints: [
        "POST   /workspaces      — create workspace",
        "GET    /workspaces      — list workspaces",
        "GET    /workspaces/:name — get workspace",
        "DELETE /workspaces/:name — delete workspace",
        "GET    /health          — health check",
      ],
    });
  },
});

console.log(`[wsmanager] listening on :${PORT}`);
console.log(`[wsmanager] image: ${IMAGE}`);
console.log(`[wsmanager] port range: ${PORT_RANGE_START}+`);
