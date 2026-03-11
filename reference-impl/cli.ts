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
 *   ws edit-queue <name> <topic> <runId> <text...>
 *                                   — edit one of my queued runs
 *   ws move-queue <name> <topic> <runId> <up|down|top|bottom>
 *                                   — reorder one of my queued runs
 *   ws clear-queue <name> <topic>   — clear my queued runs
 *   ws inject <name> <topic> <text...>
 *                                   — inject guidance into the active run
 *   ws interrupt <name> <topic> <reason...>
 *                                   — interrupt the active run
 *   ws connect <name> [topic]       — connect to topic (default: general)
 *   ws health                       — manager health
 */

import { decodeJWTPayload, mintUnsignedJWT, normalizeDisplayName } from "./auth.ts";

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
  return cachedNamespace ?? "default";
}

async function workspaceBase(name: string): Promise<string> {
  const namespace = await managerNamespace();
  return `${MANAGER}/apis/v1/namespaces/${encodeURIComponent(namespace)}/workspaces/${encodeURIComponent(name)}`;
}

function requestHeaders() {
  return { Authorization: `Bearer ${authState.token}` };
}

function topicActivityLabel(topic: any) {
  if (topic?.activeRun?.state === "running") {
    return topic.activeRun.runId ? `running (${topic.activeRun.runId})` : "running";
  }
  if ((topic?.queuedCount ?? 0) > 0) {
    return `idle (${topic.queuedCount} queued)`;
  }
  return "idle";
}

function printTopicState(topicState: any) {
  const activeRun = topicState?.activeRun;
  const queue = Array.isArray(topicState?.queue) ? topicState.queue : [];
  const active = activeRun?.runId ? `active=${activeRun.runId}` : "active=none";
  console.log(`\x1b[90m[topic] ${active}\x1b[0m`);
  if (queue.length === 0) {
    console.log(`\x1b[90m[queue] no queued runs\x1b[0m`);
    return;
  }
  for (const entry of queue) {
    const owner = entry.submittedBy?.displayName || entry.submittedBy?.id || "unknown";
    console.log(`\x1b[90m[queue] #${entry.position} ${entry.runId} ${entry.state} by ${owner}: ${entry.text}\x1b[0m`);
  }
}

function actorLabel(message: any, fallback = "user") {
  return message?.submittedBy?.displayName
    || message?.submittedBy?.id
    || message?.actor?.displayName
    || message?.actor?.id
    || fallback;
}

async function queue(name: string, topic = "general") {
  if (!name) { console.error("Usage: ws queue <workspace> <topic>"); process.exit(1); }
  const base = await workspaceBase(name);
  const data = await api(`${base}/topics/${encodeURIComponent(topic)}`, {
    headers: requestHeaders(),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  printTopicState(data);
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
  console.log(`Cleared ${removed.length} queued run(s).`);
  if (removed.length > 0) {
    console.log(removed.join("\n"));
  }
}

async function editQueue(name: string, topic = "general", runId?: string, text?: string) {
  if (!name || !runId || !text) {
    console.error("Usage: ws edit-queue <workspace> <topic> <runId> <text...>");
    process.exit(1);
  }
  const base = await workspaceBase(name);
  const data = await api(`${base}/topics/${encodeURIComponent(topic)}/queue/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: {
      ...requestHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: text }),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  printTopicState(data);
}

async function moveQueue(name: string, topic = "general", runId?: string, direction?: string) {
  if (!name || !runId || !direction) {
    console.error("Usage: ws move-queue <workspace> <topic> <runId> <up|down|top|bottom>");
    process.exit(1);
  }
  const base = await workspaceBase(name);
  const data = await api(`${base}/topics/${encodeURIComponent(topic)}/queue/${encodeURIComponent(runId)}/move`, {
    method: "POST",
    headers: {
      ...requestHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ direction }),
  });
  if (data.error) { console.error("Error:", data.error); process.exit(1); }
  printTopicState(data);
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
  console.log(`Interrupted: ${data.runId} (${data.reason || data.status})`);
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
  console.log("TOPIC\t\tCLIENTS\tACTIVITY\tCREATED");
  for (const t of data) {
    console.log(`${t.name}\t\t${t.clients ?? 0}\t${topicActivityLabel(t)}\t${t.createdAt || ""}`);
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
  const runStates = new Map<string, string>();
  const ownRuns: string[] = [];
  let currentTopicState: any = { activeRun: null, queue: [] };
  const ownQueuedRunIds = () => ownRuns.filter((candidate) => runStates.get(candidate) === "queued");

  function buildTopicURL() {
    const scheme = MANAGER.startsWith("https://") ? "wss://" : "ws://";
    const authority = MANAGER.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `${scheme}${authority}/apis/v1/namespaces/${encodeURIComponent(namespace)}/workspaces/${encodeURIComponent(name)}/topics/${encodeURIComponent(topic)}/events`;
  }

  function rememberOwnRun(msg: any) {
    if (msg.submittedBy?.id === authState.subject && msg.runId && !ownRuns.includes(msg.runId)) {
      ownRuns.push(msg.runId);
    }
  }

  function applyTopicState(msg: any) {
    currentTopicState = {
      activeRun: msg.activeRun ?? null,
      queue: Array.isArray(msg.queue) ? msg.queue : [],
    };
    if (currentTopicState.activeRun?.runId) {
      runStates.set(currentTopicState.activeRun.runId, currentTopicState.activeRun.state || "running");
      rememberOwnRun({
        runId: currentTopicState.activeRun.runId,
        submittedBy: currentTopicState.activeRun.submittedBy,
      });
    }
    for (const entry of currentTopicState.queue) {
      runStates.set(entry.runId, entry.state || "queued");
      rememberOwnRun(entry);
    }
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
        case "topic_state": {
          const previousActiveRunID = currentTopicState.activeRun?.runId || "";
          const previousQueueLength = currentTopicState.queue?.length || 0;
          applyTopicState(msg);
          const activeLabel = topicActivityLabel({
            activeRun: currentTopicState.activeRun,
            queuedCount: currentTopicState.queue.length,
          });
          if (
            msg.replay ||
            previousActiveRunID !== (currentTopicState.activeRun?.runId || "") ||
            previousQueueLength !== currentTopicState.queue.length
          ) {
            console.log(`\x1b[90m[topic] ${activeLabel}\x1b[0m`);
            if (currentTopicState.queue.length > 0) {
              printTopicState(currentTopicState);
            }
          }
          break;
        }
        case "run_updated":
          rememberOwnRun(msg);
          if (msg.runId && msg.state) {
            runStates.set(msg.runId, msg.state);
          }
          console.log(`\x1b[90m[run] ${msg.runId} ${msg.state}${msg.position ? ` (#${msg.position})` : ""}${msg.text ? `: ${msg.text}` : ""}\x1b[0m`);
          if (msg.state === "completed" || msg.state === "cancelled" || msg.state === "failed") {
            console.log(`\n\x1b[90m--- ${msg.state}${msg.reason ? `: ${msg.reason}` : ""}\x1b[0m`);
            promptInput();
          }
          break;
        case "inject_status":
          console.log(`\x1b[90m[inject] ${msg.injectId} ${msg.status}${msg.reason ? ` (${msg.reason})` : ""}\x1b[0m`);
          break;
        case "message":
          if (msg.role === "user") {
            console.log(`\x1b[36m[${actorLabel(msg)}] ${msg.text || ""}\x1b[0m`);
            break;
          }
          if (msg.role === "assistant") {
            process.stdout.write(msg.text || "");
          }
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
        case "error":
          console.error(`\x1b[31m[error] ${msg.data}\x1b[0m`);
          promptInput();
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
    const data = await api(`${apiBase}/topics/${encodeURIComponent(topic)}`, {
      headers: requestHeaders(),
    });
    if (data.error) {
      console.error(`\x1b[31m[error] ${data.error}\x1b[0m`);
      return;
    }
    printTopicState(data);
  }

  async function cancelRun(id: string) {
    let runId = id;
    if (runId === "last") {
      const pending = ownQueuedRunIds();
      runId = pending[pending.length - 1] ?? "";
      if (!runId) {
        console.error(`\x1b[31m[error] no queued run to cancel\x1b[0m`);
        return;
      }
    }
    const data = await api(`${apiBase}/topics/${encodeURIComponent(topic)}/queue/${encodeURIComponent(runId)}`, {
      method: "DELETE",
      headers: requestHeaders(),
    });
    if (data.error && data.status !== 204) {
      console.error(`\x1b[31m[error] ${data.error}\x1b[0m`);
      return;
    }
    console.log(`\x1b[90m[queue] cancel requested for ${runId}\x1b[0m`);
  }

  function resolveQueuedRun(target: string) {
    if (target !== "last") return target;
    const pending = ownQueuedRunIds();
    return pending[pending.length - 1] || "";
  }

  async function editRun(target: string, text: string) {
    const runId = resolveQueuedRun(target);
    if (!runId) {
      console.error(`\x1b[31m[error] no queued run to edit\x1b[0m`);
      return;
    }
    const data = await api(`${apiBase}/topics/${encodeURIComponent(topic)}/queue/${encodeURIComponent(runId)}`, {
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
    printTopicState(data);
  }

  async function moveRun(target: string, direction: "up" | "down" | "top" | "bottom") {
    const runId = resolveQueuedRun(target);
    if (!runId) {
      console.error(`\x1b[31m[error] no queued run to move\x1b[0m`);
      return;
    }
    const data = await api(`${apiBase}/topics/${encodeURIComponent(topic)}/queue/${encodeURIComponent(runId)}/move`, {
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
    printTopicState(data);
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
    console.log(`\x1b[90m[queue] cleared ${removed.length} run(s)\x1b[0m`);
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
\x1b[1mRuns & Queue\x1b[0m
  <text>                Submit a run (queued behind any active run)
  /next <text>          Submit a run to the \x1b[1mfront\x1b[0m of the queue
  /queue                Show the current topic state
  /cancel <id|last>     Cancel a queued run
  /edit <id|last> <text>  Replace the text of a queued run
  /up <id|last>         Move a queued run up one position
  /down <id|last>       Move a queued run down one position
  /top <id|last>        Move a queued run to the front
  /bottom <id|last>     Move a queued run to the back
  /clear                Clear all \x1b[1myour\x1b[0m queued runs

\x1b[1mActive Run\x1b[0m
  /inject <text>        Send guidance into the running run
  /interrupt <reason>   Stop the active run and move to the next queued run

\x1b[1mOther\x1b[0m
  /name <name>          Change your display name (reconnects)
  /whoami               Show your authenticated subject
  /quit                 Disconnect

\x1b[1mExamples\x1b[0m
  Hello, please summarize this repo          \x1b[90m# queued run\x1b[0m
  /next Fix the typo in README first         \x1b[90m# jump the queue\x1b[0m
  /inject Also check the tests               \x1b[90m# mid-run guidance\x1b[0m
  /interrupt Wrong approach, let me rethink   \x1b[90m# stop current run\x1b[0m
  /cancel last                               \x1b[90m# cancel your last queued run\x1b[0m
  /edit last Use Python instead of Go         \x1b[90m# edit your last queued run\x1b[0m
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
        await cancelRun(text.slice("/cancel ".length).trim());
        promptInput();
        continue;
      }
      if (text.startsWith("/edit ")) {
        const rest = text.slice("/edit ".length).trim();
        const splitAt = rest.indexOf(" ");
        if (splitAt <= 0) {
          console.error(`\x1b[31m[error] usage: /edit <runId|last> <text>\x1b[0m`);
          promptInput();
          continue;
        }
        await editRun(rest.slice(0, splitAt), rest.slice(splitAt + 1).trim());
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
        await moveRun(text.slice("/up ".length).trim(), "up");
        promptInput();
        continue;
      }
      if (text.startsWith("/top ")) {
        await moveRun(text.slice("/top ".length).trim(), "top");
        promptInput();
        continue;
      }
      if (text.startsWith("/down ")) {
        await moveRun(text.slice("/down ".length).trim(), "down");
        promptInput();
        continue;
      }
      if (text.startsWith("/bottom ")) {
        await moveRun(text.slice("/bottom ".length).trim(), "bottom");
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
    await create(args[0] ?? "", args.slice(1));
    break;
  case "delete":
  case "rm":
    await del(args[0] ?? "");
    break;
  case "topics":
    await listTopics(args[0] ?? "");
    break;
  case "queue":
    await queue(args[0] ?? "", args[1]);
    break;
  case "edit-queue":
    await editQueue(args[0] ?? "", args[1], args[2], args.slice(3).join(" ").trim());
    break;
  case "move-queue":
    await moveQueue(args[0] ?? "", args[1], args[2], args[3]);
    break;
  case "clear-queue":
    await clearQueue(args[0] ?? "", args[1]);
    break;
  case "inject":
    await inject(args[0] ?? "", args[1], args.slice(2).join(" ").trim());
    break;
  case "interrupt":
    await interrupt(args[0] ?? "", args[1], args.slice(2).join(" ").trim());
    break;
  case "connect":
  case "c":
    await connect(args[0] ?? "", args[1]);
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
  edit-queue <name> <topic> <runId> <text...>
                             Edit one of your queued runs
  move-queue <name> <topic> <runId> <up|down|top|bottom>
                             Reorder one of your queued runs
  clear-queue <name> <topic> Clear my queued runs for a topic
  inject <name> <topic> <text...>
                             Inject guidance into the active run
  interrupt <name> <topic> <reason...>
                             Interrupt the active run
  connect <name> [topic]     Connect to topic (default: general)
  health                     Manager health`);
}
