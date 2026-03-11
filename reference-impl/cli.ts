#!/usr/bin/env bun
/**
 * ws — CLI client for agentic workspace.
 *
 * Usage:
 *   ws list                         — list workspaces
 *   ws create <name>                — create workspace
 *   ws delete <name>                — delete workspace
 *   ws topics <name>                — list topics in workspace
 *   ws queue <name> <topic>         — show topic queue
 *   ws edit-queue <name> <topic> <promptId> <text...>
 *                                   — edit one of my queued prompts
 *   ws move-queue <name> <topic> <promptId> <up|down|top|bottom>
 *                                   — reorder one of my queued prompts
 *   ws clear-queue <name> <topic>   — clear my queued prompts
 *   ws inject <name> <topic> <text...>
 *                                   — inject guidance into the active turn
 *   ws interrupt <name> <topic> <reason...>
 *                                   — interrupt the active turn
 *   ws connect <name> [topic]       — connect to topic (default: general)
 *   ws health                       — manager health
 */

const MANAGER = process.env.WS_MANAGER || "http://localhost:31337";
let cachedNamespace: string | null = null;

type AuthState = {
  subject: string;
  displayName: string;
  token: string;
};

function randomId(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function base64UrlEncode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeJWTPayload(token: string): Record<string, unknown> {
  const [, payload = ""] = token.split(".");
  if (!payload) return {};
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function mintUnsignedJWT(subject: string, displayName: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `${base64UrlEncode({ alg: "none", typ: "JWT" })}.${base64UrlEncode({
    iss: "workspace-demo",
    sub: subject,
    name: displayName,
    iat: now,
  })}.`;
}

function normalizeDisplayName(value: string, fallback: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 64) || fallback;
}

function loadAuthState(): AuthState {
  const provided = (process.env.WS_JWT ?? "").trim();
  if (provided) {
    const claims = decodeJWTPayload(provided);
    const subject = String(claims.sub ?? process.env.WS_SUBJECT ?? randomId("cli"));
    const displayName = normalizeDisplayName(
      String(claims.name ?? claims.preferred_username ?? claims.email ?? process.env.WS_NAME ?? subject),
      subject,
    );
    return { subject, displayName, token: provided };
  }

  const subject = (process.env.WS_SUBJECT ?? "").trim() || randomId("cli");
  const displayName = normalizeDisplayName(process.env.WS_NAME ?? "", subject);
  return {
    subject,
    displayName,
    token: mintUnsignedJWT(subject, displayName),
  };
}

function setDisplayName(nextDisplayName: string) {
  authState = {
    subject: authState.subject,
    displayName: normalizeDisplayName(nextDisplayName, authState.subject),
    token: mintUnsignedJWT(authState.subject, normalizeDisplayName(nextDisplayName, authState.subject)),
  };
}

let authState = loadAuthState();

const [cmd, ...args] = process.argv.slice(2);

async function api(url: string, opts?: RequestInit) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    return { error: (data && (data.error || data.raw)) || text || `HTTP ${res.status}`, status: res.status };
  }
  if (data === null) {
    return { ok: true, status: res.status };
  }
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    return { ...data, status: res.status };
  }
  return data;
}

function withAuth(opts: RequestInit = {}): RequestInit {
  const headers = new Headers(opts.headers ?? {});
  headers.set("Authorization", `Bearer ${authState.token}`);
  return { ...opts, headers };
}

async function managerApi(path: string, opts?: RequestInit) {
  return api(`${MANAGER}${path}`, withAuth(opts));
}

async function managerNamespace(): Promise<string> {
  if (cachedNamespace) return cachedNamespace;
  const health = await managerApi("/health");
  cachedNamespace = typeof health.namespace === "string" && health.namespace
    ? health.namespace
    : "default";
  return cachedNamespace;
}

async function workspaceBase(name: string): Promise<string> {
  const namespace = await managerNamespace();
  return `${MANAGER}/apis/v1/namespaces/${encodeURIComponent(namespace)}/workspaces/${encodeURIComponent(name)}`;
}

function requestHeaders() {
  return { Authorization: `Bearer ${authState.token}` };
}

function printQueueSnapshot(snapshot: any) {
  const active = snapshot.activePromptId ? `active=${snapshot.activePromptId}` : "active=none";
  console.log(`\x1b[90m[queue] ${active}\x1b[0m`);
  if (!Array.isArray(snapshot.entries) || snapshot.entries.length === 0) {
    console.log(`\x1b[90m[queue] no queued prompts\x1b[0m`);
    return;
  }
  for (const entry of snapshot.entries) {
    const owner = entry.submittedBy?.displayName || entry.submittedBy?.id || "unknown";
    console.log(`\x1b[90m[queue] #${entry.position} ${entry.promptId} ${entry.status} by ${owner}: ${entry.text}\x1b[0m`);
  }
}

async function queue(name: string, topic = "general") {
  if (!name) { console.error("Usage: ws queue <workspace> <topic>"); process.exit(1); }
  const base = await workspaceBase(name);
  const data = await api(`${base}/topics/${encodeURIComponent(topic)}/queue`, {
    headers: requestHeaders(),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  printQueueSnapshot(data);
}

async function clearQueue(name: string, topic = "general") {
  if (!name) { console.error("Usage: ws clear-queue <workspace> <topic>"); process.exit(1); }
  const base = await workspaceBase(name);
  const data = await api(`${base}/topics/${encodeURIComponent(topic)}/queue:clear-mine`, {
    method: "POST",
    headers: requestHeaders(),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  const removed = Array.isArray(data.removed) ? data.removed : [];
  console.log(`Cleared ${removed.length} queued prompt(s).`);
  if (removed.length > 0) {
    console.log(removed.join("\n"));
  }
}

async function editQueue(name: string, topic = "general", promptId?: string, text?: string) {
  if (!name || !promptId || !text) {
    console.error("Usage: ws edit-queue <workspace> <topic> <promptId> <text...>");
    process.exit(1);
  }
  const base = await workspaceBase(name);
  const data = await api(`${base}/topics/${encodeURIComponent(topic)}/queue/${encodeURIComponent(promptId)}`, {
    method: "PATCH",
    headers: {
      ...requestHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: text }),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  printQueueSnapshot(data);
}

async function moveQueue(name: string, topic = "general", promptId?: string, direction?: string) {
  if (!name || !promptId || !direction) {
    console.error("Usage: ws move-queue <workspace> <topic> <promptId> <up|down|top|bottom>");
    process.exit(1);
  }
  const base = await workspaceBase(name);
  const data = await api(`${base}/topics/${encodeURIComponent(topic)}/queue/${encodeURIComponent(promptId)}/move`, {
    method: "POST",
    headers: {
      ...requestHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ direction }),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  printQueueSnapshot(data);
}

async function inject(name: string, topic = "general", text?: string) {
  if (!name || !text) {
    console.error("Usage: ws inject <workspace> <topic> <text...>");
    process.exit(1);
  }
  const base = await workspaceBase(name);
  const data = await api(`${base}/topics/${encodeURIComponent(topic)}/inject`, {
    method: "POST",
    headers: {
      ...requestHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: text }),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  console.log(`Inject accepted: ${data.injectId}`);
}

async function interrupt(name: string, topic = "general", reason?: string) {
  if (!name || !reason) {
    console.error("Usage: ws interrupt <workspace> <topic> <reason...>");
    process.exit(1);
  }
  const base = await workspaceBase(name);
  const data = await api(`${base}/topics/${encodeURIComponent(topic)}/interrupt`, {
    method: "POST",
    headers: {
      ...requestHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ reason }),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  console.log(`Interrupted: ${data.promptId} (${data.reason || data.status})`);
}

async function list() {
  const namespace = await managerNamespace();
  const data = await managerApi(`/apis/v1/namespaces/${encodeURIComponent(namespace)}/workspaces`);
  if (!data.length) { console.log("No workspaces."); return; }
  console.log("WORKSPACE\tSTATUS");
  for (const ws of data) {
    console.log(`${ws.name}\t${ws.status}`);
  }
}

async function create(name: string, topicNames: string[]) {
  if (!name) { console.error("Usage: ws create <name> [topic1 topic2 ...]"); process.exit(1); }
  const namespace = await managerNamespace();
  const body: any = { name };
  if (topicNames.length > 0) body.topics = topicNames.map((topic) => ({ name: topic }));
  const data = await managerApi(`/apis/v1/namespaces/${encodeURIComponent(namespace)}/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  console.log(`Created: ${data.name}`);
  if (Array.isArray(data.topics) && data.topics.length > 0) {
    console.log(`Topics:  ${data.topics.map((topic: any) => topic.name).join(", ")}`);
  }
}

async function del(name: string) {
  if (!name) { console.error("Usage: ws delete <name>"); process.exit(1); }
  const base = await workspaceBase(name);
  const data = await api(base, withAuth({ method: "DELETE" }));
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  console.log(`Deleted: ${data.name}`);
}

async function listTopics(name: string) {
  if (!name) { console.error("Usage: ws topics <workspace>"); process.exit(1); }
  const base = await workspaceBase(name);
  const data = await api(`${base}/topics`, withAuth());
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

  const namespace = await managerNamespace();
  const apiBase = await workspaceBase(name);
  const ws = await api(apiBase, withAuth());
  if (ws.error) { console.error("Error:", ws.error); process.exit(1); }

  let connected = false;
  let reconnecting = false;
  const promptStates = new Map<string, string>();
  const ownPrompts: string[] = [];
  const ownQueuedPromptIds = () => ownPrompts.filter((candidate) => promptStates.get(candidate) === "queued");

  function buildTopicURL() {
    const scheme = MANAGER.startsWith("https://") ? "wss://" : "ws://";
    const authority = MANAGER.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `${scheme}${authority}/apis/v1/namespaces/${encodeURIComponent(namespace)}/workspaces/${encodeURIComponent(name)}/topics/${encodeURIComponent(topic)}/events`;
  }

  function setupSocket(ws: WebSocket) {
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "authenticate", token: authState.token }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      switch (msg.type) {
        case "authenticated":
          break;
        case "system":
          console.log(`\x1b[90m[system] ${msg.data}\x1b[0m`);
          break;
        case "connected":
          connected = true;
          console.log(`\x1b[32mConnected to topic "${msg.topic}" (${msg.protocolVersion || "unknown"})\x1b[0m`);
          console.log(`Type a message and press Enter. /help for commands, /quit to disconnect.\n`);
          promptInput();
          break;
        case "queue_snapshot":
          printQueueSnapshot(msg);
          break;
        case "prompt_status":
          if (msg.submittedBy?.id === authState.subject && msg.promptId && !ownPrompts.includes(msg.promptId)) {
            ownPrompts.push(msg.promptId);
          }
          promptStates.set(msg.promptId, msg.status);
          console.log(`\x1b[90m[prompt] ${msg.promptId} ${msg.status}${msg.position ? ` (#${msg.position})` : ""}${msg.data ? `: ${msg.data}` : ""}\x1b[0m`);
          break;
        case "inject_status":
          console.log(`\x1b[90m[inject] ${msg.injectId} ${msg.status}${msg.reason ? ` (${msg.reason})` : ""}\x1b[0m`);
          break;
        case "user":
          console.log(`\x1b[36m[user] ${msg.data}\x1b[0m`);
          break;
        case "text":
          process.stdout.write(msg.data);
          break;
        case "tool_call":
          console.log(`\x1b[33m[tool] ${msg.title} (${msg.status})\x1b[0m`);
          break;
        case "tool_update":
          console.log(`\x1b[33m[tool] ${msg.title || msg.toolCallId} ${msg.status || "updated"}\x1b[0m`);
          if (msg.data) {
            console.log(msg.data);
          }
          break;
        case "done":
          if (msg.status === "interrupted") {
            console.log(`\n\x1b[90m--- interrupted${msg.reason ? `: ${msg.reason}` : ""}\x1b[0m`);
          } else {
            console.log(`\n\x1b[90m--- ${msg.status || "done"}\x1b[0m`);
          }
          promptInput();
          break;
        case "error":
          console.error(`\x1b[31m[error] ${msg.data}\x1b[0m`);
          promptInput();
          break;
        case "queue_entry_removed":
          console.log(`\x1b[90m[queue] removed ${msg.promptId} (${msg.reason || "removed"})\x1b[0m`);
          break;
        case "queue_entry_updated":
          console.log(`\x1b[90m[queue] updated ${msg.promptId} (#${msg.position || "?"})\x1b[0m`);
          break;
        case "queue_entry_moved":
          console.log(`\x1b[90m[queue] moved ${msg.promptId} ${msg.direction || ""} (#${msg.position || "?"})\x1b[0m`);
          break;
        case "queue_cleared":
          console.log(`\x1b[90m[queue] cleared ${Array.isArray(msg.removed) ? msg.removed.join(", ") : ""}\x1b[0m`);
          break;
        default:
          console.log(`[${msg.type}]`, msg.data || "");
      }
    };
    ws.onerror = () => { console.error("WebSocket error"); process.exit(1); };
    ws.onclose = () => {
      if (reconnecting) return;
      console.log("\nDisconnected.");
      process.exit(0);
    };
  }

  console.log(`Connecting as ${authState.displayName} (${authState.subject})...`);
  let socket = new WebSocket(buildTopicURL());
  setupSocket(socket);

  function promptInput() {
    process.stdout.write(`\x1b[36m[${topic}]> \x1b[0m`);
  }

  async function showQueue() {
    const data = await api(`${apiBase}/topics/${encodeURIComponent(topic)}/queue`, {
      headers: requestHeaders(),
    });
    if (data.error) {
      console.error(`\x1b[31m[error] ${data.error}\x1b[0m`);
      return;
    }
    printQueueSnapshot(data);
  }

  async function cancelPrompt(id: string) {
    let promptId = id;
    if (promptId === "last") {
      const pending = ownQueuedPromptIds();
      promptId = pending[pending.length - 1];
      if (!promptId) {
        console.error(`\x1b[31m[error] no queued prompt to cancel\x1b[0m`);
        return;
      }
    }
    const data = await api(`${apiBase}/topics/${encodeURIComponent(topic)}/queue/${encodeURIComponent(promptId)}`, {
      method: "DELETE",
      headers: requestHeaders(),
    });
    if (data.error && data.status !== 204) {
      console.error(`\x1b[31m[error] ${data.error}\x1b[0m`);
      return;
    }
    console.log(`\x1b[90m[queue] cancel requested for ${promptId}\x1b[0m`);
  }

  function resolveQueuedPrompt(target: string) {
    if (target !== "last") return target;
    const pending = ownQueuedPromptIds();
    return pending[pending.length - 1] || "";
  }

  async function editPrompt(target: string, text: string) {
    const promptId = resolveQueuedPrompt(target);
    if (!promptId) {
      console.error(`\x1b[31m[error] no queued prompt to edit\x1b[0m`);
      return;
    }
    const data = await api(`${apiBase}/topics/${encodeURIComponent(topic)}/queue/${encodeURIComponent(promptId)}`, {
      method: "PATCH",
      headers: {
        ...requestHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: text }),
    });
    if (data.error) {
      console.error(`\x1b[31m[error] ${data.error}\x1b[0m`);
      return;
    }
    printQueueSnapshot(data);
  }

  async function movePrompt(target: string, direction: "up" | "down" | "top" | "bottom") {
    const promptId = resolveQueuedPrompt(target);
    if (!promptId) {
      console.error(`\x1b[31m[error] no queued prompt to move\x1b[0m`);
      return;
    }
    const data = await api(`${apiBase}/topics/${encodeURIComponent(topic)}/queue/${encodeURIComponent(promptId)}/move`, {
      method: "POST",
      headers: {
        ...requestHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ direction }),
    });
    if (data.error) {
      console.error(`\x1b[31m[error] ${data.error}\x1b[0m`);
      return;
    }
    printQueueSnapshot(data);
  }

  async function clearMine() {
    const data = await api(`${apiBase}/topics/${encodeURIComponent(topic)}/queue:clear-mine`, {
      method: "POST",
      headers: requestHeaders(),
    });
    if (data.error) {
      console.error(`\x1b[31m[error] ${data.error}\x1b[0m`);
      return;
    }
    const removed = Array.isArray(data.removed) ? data.removed : [];
    console.log(`\x1b[90m[queue] cleared ${removed.length} prompt(s)\x1b[0m`);
  }

  function sendPrompt(text: string, position?: number) {
    socket.send(JSON.stringify({ type: "prompt", data: text, ...(position === undefined ? {} : { position }) }));
  }

  function sendInject(text: string) {
    socket.send(JSON.stringify({ type: "inject", data: text }));
  }

  function sendInterrupt(reason: string) {
    socket.send(JSON.stringify({ type: "interrupt", reason }));
  }

  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    const lines = decoder.decode(chunk).split("\n").filter(Boolean);
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      if (text === "/quit" || text === "/exit") { socket.close(); process.exit(0); }
      if (text === "/help" || text === "/?") {
        console.log(`
\x1b[1mPrompts & Queue\x1b[0m
  <text>                Send a prompt (queued behind any active turn)
  /next <text>          Send a prompt to the \x1b[1mfront\x1b[0m of the queue
  /queue                Show the current queue
  /cancel <id|last>     Cancel a queued prompt
  /edit <id|last> <text>  Replace the text of a queued prompt
  /up <id|last>         Move a queued prompt up one position
  /down <id|last>       Move a queued prompt down one position
  /top <id|last>        Move a queued prompt to the front
  /bottom <id|last>     Move a queued prompt to the back
  /clear                Clear all \x1b[1myour\x1b[0m queued prompts

\x1b[1mActive Turn\x1b[0m
  /inject <text>        Send guidance into the running turn (mid-turn)
  /interrupt <reason>   Stop the active turn and move to the next prompt

\x1b[1mOther\x1b[0m
  /name <name>          Change your display name (reconnects)
  /whoami               Show your authenticated subject
  /quit                 Disconnect

\x1b[1mExamples\x1b[0m
  Hello, please summarize this repo          \x1b[90m# queued prompt\x1b[0m
  /next Fix the typo in README first         \x1b[90m# jump the queue\x1b[0m
  /inject Also check the tests               \x1b[90m# mid-turn guidance\x1b[0m
  /interrupt Wrong approach, let me rethink   \x1b[90m# stop current turn\x1b[0m
  /cancel last                               \x1b[90m# cancel your last queued prompt\x1b[0m
  /edit last Use Python instead of Go         \x1b[90m# edit your last queued prompt\x1b[0m
  /name JoshM                                \x1b[90m# change your display name\x1b[0m
`);
        promptInput();
        continue;
      }
      if (text === "/queue") {
        await showQueue();
        promptInput();
        continue;
      }
      if (text === "/clear") {
        await clearMine();
        promptInput();
        continue;
      }
      if (text.startsWith("/cancel ")) {
        await cancelPrompt(text.slice("/cancel ".length).trim());
        promptInput();
        continue;
      }
      if (text.startsWith("/edit ")) {
        const rest = text.slice("/edit ".length).trim();
        const splitAt = rest.indexOf(" ");
        if (splitAt <= 0) {
          console.error(`\x1b[31m[error] usage: /edit <promptId|last> <text>\x1b[0m`);
          promptInput();
          continue;
        }
        await editPrompt(rest.slice(0, splitAt), rest.slice(splitAt + 1).trim());
        promptInput();
        continue;
      }
      if (text.startsWith("/inject ")) {
        sendInject(text.slice("/inject ".length).trim());
        promptInput();
        continue;
      }
      if (text.startsWith("/interrupt ")) {
        sendInterrupt(text.slice("/interrupt ".length).trim());
        promptInput();
        continue;
      }
      if (text.startsWith("/next ")) {
        sendPrompt(text.slice("/next ".length).trim(), 0);
        promptInput();
        continue;
      }
      if (text.startsWith("/up ")) {
        await movePrompt(text.slice("/up ".length).trim(), "up");
        promptInput();
        continue;
      }
      if (text.startsWith("/top ")) {
        await movePrompt(text.slice("/top ".length).trim(), "top");
        promptInput();
        continue;
      }
      if (text.startsWith("/down ")) {
        await movePrompt(text.slice("/down ".length).trim(), "down");
        promptInput();
        continue;
      }
      if (text.startsWith("/bottom ")) {
        await movePrompt(text.slice("/bottom ".length).trim(), "bottom");
        promptInput();
        continue;
      }
      if (text === "/whoami") {
        console.log(`subject ${authState.subject} (${authState.displayName})`);
        promptInput();
        continue;
      }
      if (text.startsWith("/name ") || text.startsWith("/nick ")) {
        const newName = text.slice(text.indexOf(" ") + 1).trim();
        if (!newName) {
          console.error("Usage: /name <name>");
          promptInput();
          continue;
        }
        setDisplayName(newName);
        console.log(`\x1b[90mReconnecting as ${authState.displayName} (${authState.subject})...\x1b[0m`);
        reconnecting = true;
        connected = false;
        socket.close();
        socket = new WebSocket(buildTopicURL());
        setupSocket(socket);
        reconnecting = false;
        continue;
      }
      if (!connected) continue;
      sendPrompt(text);
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
    await create(args[0], args.slice(1));
    break;
  case "delete":
  case "rm":
    await del(args[0]);
    break;
  case "topics":
    await listTopics(args[0]);
    break;
  case "queue":
    await queue(args[0], args[1]);
    break;
  case "edit-queue":
    await editQueue(args[0], args[1], args[2], args.slice(3).join(" ").trim());
    break;
  case "move-queue":
    await moveQueue(args[0], args[1], args[2], args[3]);
    break;
  case "clear-queue":
    await clearQueue(args[0], args[1]);
    break;
  case "inject":
    await inject(args[0], args[1], args.slice(2).join(" ").trim());
    break;
  case "interrupt":
    await interrupt(args[0], args[1], args.slice(2).join(" ").trim());
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
  create <name> [topics...]  Create workspace (optionally with topics)
  delete <name>              Delete workspace
  topics <name>              List topics in workspace
  queue <name> <topic>       Show topic queue
  edit-queue <name> <topic> <promptId> <text...>
                             Edit one of your queued prompts
  move-queue <name> <topic> <promptId> <up|down|top|bottom>
                             Reorder one of your queued prompts
  clear-queue <name> <topic> Clear my queued prompts for a topic
  inject <name> <topic> <text...>
                             Inject guidance into the active turn
  interrupt <name> <topic> <reason...>
                             Interrupt the active turn
  connect <name> [topic]     Connect to topic (default: general)
  health                     Manager health`);
}
