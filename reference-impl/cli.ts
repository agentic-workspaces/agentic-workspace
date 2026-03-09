#!/usr/bin/env bun
/**
 * ws — CLI client for agentic workspace.
 *
 * Usage:
 *   ws list                         — list workspaces
 *   ws create <name>                — create workspace
 *   ws delete <name>                — delete workspace
 *   ws topics <name>                — list topics in workspace
 *   ws connect <name> [topic]       — connect to topic (default: general)
 *   ws health                       — manager health
 */

const MANAGER = process.env.WS_MANAGER || "http://localhost:31337";

const [cmd, ...args] = process.argv.slice(2);

async function api(url: string, opts?: RequestInit) {
  const res = await fetch(url, opts);
  return res.json();
}

async function managerApi(path: string, opts?: RequestInit) {
  return api(`${MANAGER}${path}`, opts);
}

// Get workspace API base URL
async function wsApi(name: string): Promise<string> {
  const ws = await managerApi(`/workspaces/${name}`);
  if (ws.error) { console.error("Error:", ws.error); process.exit(1); }
  return ws.api;
}

async function list() {
  const data = await managerApi("/workspaces");
  if (!data.length) { console.log("No workspaces."); return; }
  console.log("WORKSPACE\tSTATUS\tACP");
  for (const ws of data) {
    console.log(`${ws.name}\t${ws.status}\t${ws.acp}`);
  }
}

async function create(name: string) {
  if (!name) { console.error("Usage: ws create <name>"); process.exit(1); }
  const data = await managerApi("/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  console.log(`Created: ${data.name}`);
  console.log(`ACP:     ${data.acp}`);
}

async function del(name: string) {
  if (!name) { console.error("Usage: ws delete <name>"); process.exit(1); }
  const data = await managerApi(`/workspaces/${name}`, { method: "DELETE" });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  console.log(`Deleted: ${data.name}`);
}

async function listTopics(name: string) {
  if (!name) { console.error("Usage: ws topics <workspace>"); process.exit(1); }
  const base = await wsApi(name);
  const data = await api(`${base}/topics`);
  if (!data.length) { console.log("No topics. Connect to create one."); return; }
  console.log("TOPIC\t\tCLIENTS\tBUSY\tCREATED");
  for (const t of data) {
    console.log(`${t.name}\t\t${t.clients}\t${t.busy}\t${t.createdAt}`);
  }
}

async function health() {
  const data = await managerApi("/health");
  console.log(JSON.stringify(data, null, 2));
}

async function connect(name: string, topic = "general") {
  if (!name) { console.error("Usage: ws connect <name> [topic]"); process.exit(1); }

  const ws = await managerApi(`/workspaces/${name}`);
  if (ws.error) { console.error("Error:", ws.error); process.exit(1); }

  // Build ACP URL: ws://host:port/acp/<topic>
  const acpBase = ws.acp.replace(/\/acp$/, "");
  const acpUrl = `${acpBase}/acp/${topic}`;
  console.log(`Connecting to ${acpUrl}...`);

  const socket = new WebSocket(acpUrl);
  let connected = false;

  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case "system":
        console.log(`\x1b[90m[system] ${msg.data}\x1b[0m`);
        break;
      case "connected":
        connected = true;
        console.log(`\x1b[32mConnected to topic "${msg.topic}" (session ${msg.sessionId})\x1b[0m`);
        console.log(`Type a message and press Enter. /quit to disconnect.\n`);
        promptInput();
        break;
      case "text":
        process.stdout.write(msg.data);
        break;
      case "tool_call":
        console.log(`\x1b[33m[tool] ${msg.title} (${msg.status})\x1b[0m`);
        break;
      case "tool_update":
        if (msg.status === "completed") {
          console.log(`\x1b[33m[tool] ${msg.title || msg.toolCallId} done\x1b[0m`);
        }
        break;
      case "done":
        console.log(`\n\x1b[90m---\x1b[0m`);
        promptInput();
        break;
      case "error":
        console.error(`\x1b[31m[error] ${msg.data}\x1b[0m`);
        promptInput();
        break;
      default:
        console.log(`[${msg.type}]`, msg.data || "");
    }
  };

  socket.onerror = () => { console.error("WebSocket error"); process.exit(1); };
  socket.onclose = () => { console.log("\nDisconnected."); process.exit(0); };

  function promptInput() {
    process.stdout.write(`\x1b[36m[${topic}]> \x1b[0m`);
  }

  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    const lines = decoder.decode(chunk).split("\n").filter(Boolean);
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      if (text === "/quit" || text === "/exit") { socket.close(); process.exit(0); }
      if (!connected) continue;
      socket.send(JSON.stringify({ type: "prompt", data: text }));
    }
  }
}

// --- Main ---

switch (cmd) {
  case "list":
  case "ls":
    await list();
    break;
  case "create":
    await create(args[0]);
    break;
  case "delete":
  case "rm":
    await del(args[0]);
    break;
  case "topics":
    await listTopics(args[0]);
    break;
  case "connect":
  case "c":
    await connect(args[0], args[1]);
    break;
  case "health":
    await health();
    break;
  default:
    console.log(`ws — agentic workspace CLI

Commands:
  list                       List workspaces
  create <name>              Create workspace
  delete <name>              Delete workspace
  topics <name>              List topics in workspace
  connect <name> [topic]     Connect to topic (default: general)
  health                     Manager health`);
}
