/**
 * wmlet — internal workspace runtime inside one container.
 *
 * Public API shape lives at the manager. This process exposes an internal
 * workspace-specific API that the manager proxies onto the canonical protocol.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { listDir, isTextFile, FileSidebar, FileContentView } from "./ui/files.tsx";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from "@agentclientprotocol/sdk";
import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  StopReason,
} from "@agentclientprotocol/sdk";
import { decodeInternalActor, type Actor } from "./auth.ts";
import {
  TOPIC_PROTOCOL_VERSION,
  type ActiveRun,
  type QueuedRun,
  type RunState,
  type TopicState,
} from "./protocol.ts";

const PORT = parseInt(process.env.WMLET_PORT || process.env.PORT || "31337", 10);
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/workspace";
const HOME_DIR = process.env.HOME || "/root";
const BIN_DIR = `${process.cwd()}/node_modules/.bin`;

// ── Log buffer for streaming ──
const wmletLogs: string[] = [];
const logSubscribers = new Set<(line: string) => void>();
const MAX_LOG_LINES = 500;

function wmLog(msg: string) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  wmletLogs.push(line);
  if (wmletLogs.length > MAX_LOG_LINES) wmletLogs.shift();
  console.log(msg);
  for (const sub of logSubscribers) sub(line);
}

type ClientSocket = any;

// Active login processes waiting for auth code
const loginProcesses = new Map<string, ReturnType<typeof Bun.spawn>>();
type SocketData = {
  actor: Actor;
  topicName: string;
};

interface RunRecord {
  runId: string;
  text: string;
  state: RunState;
  submittedBy: Actor;
  assistantText: string;
  reason?: string;
  interruptedBy?: Actor;
}

interface TopicEvent {
  type: string;
  [key: string]: unknown;
}

interface Topic {
  name: string;
  createdAt: string;
  connection: ClientSideConnection;
  process: ChildProcess;
  sessionId: string;
  sockets: Set<ClientSocket>;
  history: TopicEvent[];
  runs: Map<string, RunRecord>;
  queue: string[];
  activeRunId: string | null;
}

const topics = new Map<string, Topic>();

export function jsonError(error: string, status = 400): Response {
  return Response.json({ error }, { status });
}

export function cleanEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION;
  return env;
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

export function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function activeRun(topic: Topic): RunRecord | null {
  if (!topic.activeRunId) return null;
  return topic.runs.get(topic.activeRunId) ?? null;
}

function activeRunShape(topic: Topic): ActiveRun | null {
  const run = activeRun(topic);
  if (!run || run.state !== "running") return null;
  return {
    runId: run.runId,
    state: "running",
    interruptible: true,
    submittedBy: run.submittedBy,
  };
}

function queueShape(topic: Topic): QueuedRun[] {
  return topic.queue.flatMap((runId, index) => {
    const run = topic.runs.get(runId);
    if (!run || run.state !== "queued") return [];
    return [{
      runId: run.runId,
      state: "queued" as const,
      text: run.text,
      position: index + 1,
      submittedBy: run.submittedBy,
    }];
  });
}

function topicState(topic: Topic): TopicState {
  return {
    name: topic.name,
    activeRun: activeRunShape(topic),
    queue: queueShape(topic),
    queuedCount: topic.queue.length,
    createdAt: topic.createdAt,
  };
}

function summary(topic: Topic) {
  const state = topicState(topic);
  return {
    name: state.name,
    activeRun: state.activeRun,
    queuedCount: state.queue.length,
    createdAt: state.createdAt,
  };
}

export function replayable(event: TopicEvent): boolean {
  return event.type === "run_updated"
    || event.type === "message"
    || event.type === "tool_call"
    || event.type === "tool_update";
}

function send(ws: ClientSocket, event: TopicEvent) {
  ws.send(JSON.stringify(event));
}

async function saveTopicHistory(topic: Topic) {
  const dir = `${WORKSPACE_DIR}/.topics/${topic.name}`;
  await mkdir(dir, { recursive: true });
  await Bun.write(`${dir}/history.json`, JSON.stringify(topic.history));
  await Bun.write(`${dir}/meta.json`, JSON.stringify({ name: topic.name, createdAt: topic.createdAt }));
}

async function restoreTopics() {
  const topicsDir = `${WORKSPACE_DIR}/.topics`;
  try {
    const entries = await readdir(topicsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const historyFile = Bun.file(`${topicsDir}/${entry.name}/history.json`);
      if (!(await historyFile.exists())) continue;
      try {
        await createTopic(entry.name);
        wmLog(`[restore] topic "${entry.name}"`);
      } catch (e) {
        wmLog(`[restore] failed to restore topic "${entry.name}": ${e}`);
      }
    }
  } catch {
    // no .topics dir yet
  }
}

async function loadTopicHistory(name: string): Promise<TopicEvent[]> {
  const path = `${WORKSPACE_DIR}/.topics/${name}/history.json`;
  const file = Bun.file(path);
  if (await file.exists()) {
    return await file.json();
  }
  return [];
}

function broadcast(topic: Topic, event: TopicEvent, options?: { record?: boolean }) {
  if (options?.record !== false && replayable(event)) {
    topic.history.push(structuredClone(event));
    saveTopicHistory(topic).catch((err) => wmLog(`Failed to save topic history: ${err}`));
  }
  const payload = JSON.stringify(event);
  for (const socket of topic.sockets) {
    socket.send(payload);
  }
}

function broadcastTopicState(topic: Topic) {
  broadcast(topic, { type: "topic_state", ...topicState(topic) }, { record: false });
}

function queuedRunUpdate(run: RunRecord, position: number): TopicEvent {
  return {
    type: "run_updated",
    runId: run.runId,
    state: "queued",
    text: run.text,
    position,
    submittedBy: run.submittedBy,
  };
}

function announceQueue(topic: Topic) {
  for (const [index, runId] of topic.queue.entries()) {
    const run = topic.runs.get(runId);
    if (!run || run.state !== "queued") continue;
    broadcast(topic, queuedRunUpdate(run, index + 1));
  }
  broadcastTopicState(topic);
}

function emitRunUpdate(topic: Topic, event: Record<string, unknown>) {
  broadcast(topic, { ...event, type: "run_updated" });
}

function emitMessage(topic: Topic, event: Record<string, unknown>) {
  broadcast(topic, { ...event, type: "message" });
}

export function toolUpdateData(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof value.message === "string" && value.message) {
      parts.push(value.message);
    }
    if (typeof value.code === "string" || typeof value.code === "number") {
      parts.push(`code=${String(value.code)}`);
    }
    if (value.data !== undefined) {
      parts.push(`data=${toolUpdateData(value.data) ?? String(value.data)}`);
    }
    if (parts.length > 0) return parts.join(" ");
    try {
      return JSON.stringify(value);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

async function createTopic(name: string): Promise<Topic> {
  const command = `${BIN_DIR}/claude-agent-acp`;
  const proc = spawn(command, [], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: WORKSPACE_DIR,
    env: cleanEnv(),
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) wmLog(`[${name}:stderr] ${line}`);
  });

  if (!proc.stdin || !proc.stdout) {
    throw new Error("failed to create ACP stdio pipes");
  }

  const topicRef: { current: Topic | null } = { current: null };
  const input = Writable.toWeb(proc.stdin);
  const output = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  const clientImpl: Client = {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      const topic = topicRef.current;
      if (!topic) return;
      const run = activeRun(topic);
      const runId = run?.runId;
      if (!runId) return;

      const update = params.update as any;
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const text = update.content?.text;
          if (text && run) {
            run.assistantText += text;
            broadcast(topic, {
              type: "text_chunk",
              runId,
              text,
            });
          }
          break;
        }
        case "tool_call": {
          broadcast(topic, {
            type: "tool_call",
            runId,
            toolCallId: update.toolCallId,
            title: update.title,
            tool: update.title,
            status: update.status ?? "pending",
          });
          break;
        }
        case "tool_call_update": {
          broadcast(topic, {
            type: "tool_update",
            runId,
            toolCallId: update.toolCallId,
            title: update.title,
            status: update.status ?? "updated",
            data: toolUpdateData(update.rawOutput ?? update.content),
          });
          break;
        }
      }
    },

    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      return {
        outcome: {
          outcome: "selected",
          optionId: params.options[0]?.optionId ?? "allow",
        },
      };
    },
  };

  const connection = new ClientSideConnection(() => clientImpl, stream);
  const initResult = await withTimeout(
    connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "wmlet", version: "0.2.0" },
    }),
    30_000,
    `${name} ACP initialize`,
  );

  const session = await withTimeout(
    connection.newSession({ cwd: WORKSPACE_DIR, mcpServers: [] }),
    30_000,
    `${name} ACP newSession`,
  );

  const topic: Topic = {
    name,
    createdAt: new Date().toISOString(),
    connection,
    process: proc,
    sessionId: session.sessionId,
    sockets: new Set(),
    history: await loadTopicHistory(name),
    runs: new Map(),
    queue: [],
    activeRunId: null,
  };
  topicRef.current = topic;

  proc.on("exit", (code) => {
    topics.delete(name);
    broadcast(topic, {
      type: "error",
      data: `agent exited (${code ?? "unknown"})`,
    }, { record: false });
  });

  topics.set(name, topic);
  return topic;
}

export function runStateFromStopReason(stopReason: StopReason): RunState {
  if (stopReason === "end_turn") return "completed";
  if (stopReason === "cancelled") return "cancelled";
  return "failed";
}

async function finishRun(topic: Topic, run: RunRecord, state: RunState, reason?: string, interruptedBy?: Actor) {
  if (run.assistantText) {
    emitMessage(topic, {
      runId: run.runId,
      role: "assistant",
      text: run.assistantText,
    });
  }

  run.state = state;
  run.reason = reason;
  run.interruptedBy = interruptedBy;
  emitRunUpdate(topic, {
    runId: run.runId,
    state,
    ...(reason ? { reason } : {}),
    ...(interruptedBy ? { interruptedBy } : {}),
  });

  if (topic.activeRunId === run.runId) {
    topic.activeRunId = null;
  }

  if (topic.queue.length > 0) {
    const nextRunId = topic.queue.shift()!;
    const nextRun = topic.runs.get(nextRunId);
    if (nextRun) {
      announceQueue(topic);
      await startRun(topic, nextRun);
      return;
    }
  }

  broadcastTopicState(topic);
}

async function executeRun(topic: Topic, run: RunRecord) {
  try {
    const response = await topic.connection.prompt({
      sessionId: topic.sessionId,
      prompt: [{ type: "text", text: `${run.submittedBy.displayName}: ${run.text}` }],
    });
    const state = runStateFromStopReason(response.stopReason);
    await finishRun(topic, run, state, run.reason ?? (state === "failed" ? response.stopReason : undefined), run.interruptedBy);
  } catch (error) {
    const message = describeError(error);
    const state: RunState = run.interruptedBy ? "cancelled" : "failed";
    await finishRun(topic, run, state, run.reason ?? message, run.interruptedBy);
  }
}

async function startRun(topic: Topic, run: RunRecord) {
  topic.activeRunId = run.runId;
  run.state = "running";
  run.assistantText = "";

  emitRunUpdate(topic, {
    runId: run.runId,
    state: "running",
    submittedBy: run.submittedBy,
  });
  emitMessage(topic, {
    runId: run.runId,
    role: "user",
    text: run.text,
    submittedBy: run.submittedBy,
  });
  broadcastTopicState(topic);
  void executeRun(topic, run);
}

async function getOrCreateTopic(name: string): Promise<Topic> {
  const existing = topics.get(name);
  if (existing) return existing;
  return createTopic(name);
}

async function submitRun(topic: Topic, actor: Actor, text: string, position?: number) {
  const run: RunRecord = {
    runId: randomId("r"),
    text,
    state: "queued",
    submittedBy: actor,
    assistantText: "",
  };
  topic.runs.set(run.runId, run);

  if (!topic.activeRunId) {
    await startRun(topic, run);
    return run;
  }

  const insertAt = position === 0 ? 0 : topic.queue.length;
  topic.queue.splice(insertAt, 0, run.runId);
  announceQueue(topic);
  return run;
}

function findQueuedRun(topic: Topic, runId: string): RunRecord | null {
  if (!topic.queue.includes(runId)) return null;
  return topic.runs.get(runId) ?? null;
}

function requireQueuedRun(topic: Topic, runId: string, actor: Actor): RunRecord {
  const run = findQueuedRun(topic, runId);
  if (!run) {
    throw new Response(JSON.stringify({ error: "run not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (run.submittedBy.id !== actor.id) {
    throw new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }
  return run;
}

function removeQueuedRun(topic: Topic, runId: string): boolean {
  const index = topic.queue.indexOf(runId);
  if (index < 0) return false;
  topic.queue.splice(index, 1);
  return true;
}

function actorFromInternalRequest(req: Request): Actor | null {
  return decodeInternalActor(req.headers.get("x-workspace-actor"));
}

function actorFromInternalSocket(req: Request): Actor | null {
  const url = new URL(req.url);
  return decodeInternalActor(url.searchParams.get("actor"));
}

function ensureInternalActor(req: Request): Actor {
  const actor = actorFromInternalRequest(req);
  if (!actor) {
    throw jsonError("missing actor", 401);
  }
  return actor;
}

export function relativeWorkspacePath(input: string | null): string {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  if (raw.includes("\\")) throw jsonError("invalid path", 400);
  const normalized = normalize(raw).replace(/^\/+/, "");
  if (!normalized || normalized === ".") return "";
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw jsonError("invalid path", 400);
  }
  return normalized;
}

export function workspacePath(relativePath: string) {
  const fullPath = resolve(WORKSPACE_DIR, relativePath);
  const root = resolve(WORKSPACE_DIR);
  if (fullPath !== root && !fullPath.startsWith(`${root}/`)) {
    throw jsonError("invalid path", 400);
  }
  return fullPath;
}

async function fileInfo(relativePath: string) {
  const fullPath = workspacePath(relativePath);
  const info = await stat(fullPath);
  const base = {
    name: basename(fullPath) || "",
    path: relativePath,
    kind: info.isDirectory() ? "directory" : "file",
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  };
  if (!info.isDirectory()) return base;

  const childNames = await readdir(fullPath);
  const entries = await Promise.all(childNames.sort().map(async (childName) => {
    const childPath = relativePath ? `${relativePath}/${childName}` : childName;
    const childInfo = await stat(join(fullPath, childName));
    return {
      name: childName,
      path: childPath,
      kind: childInfo.isDirectory() ? "directory" : "file",
      size: childInfo.size,
      modifiedAt: childInfo.mtime.toISOString(),
    };
  }));
  return { ...base, entries };
}

const isMainModule = typeof Bun !== "undefined" && Bun.main === import.meta.path;

if (isMainModule) {

const server = Bun.serve<SocketData>({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    const wsMatch = url.pathname.match(/^\/internal\/topics\/([^/]+)\/events$/);
    if (wsMatch) {
      const actor = actorFromInternalSocket(req);
      if (!actor) return jsonError("missing actor", 401);
      const topicName = wsMatch[1];
      if (!topicName) return jsonError("not found", 404);
      const upgraded = server.upgrade(req, {
        data: {
          actor,
          topicName: decodeURIComponent(topicName),
        },
      });
      if (!upgraded) return new Response("upgrade failed", { status: 400 });
      return undefined;
    }

    if (url.pathname === "/health" || url.pathname === "/internal/health") {
      return Response.json({
        status: "ok",
        workspaceDir: WORKSPACE_DIR,
        topics: [...topics.keys()],
        claudeAuthenticated: hasClaudeCredentials(),
      });
    }

    // Set Claude token — accepts setup-token (sk-*) or CLAUDE_CODE_OAUTH_TOKEN
    if (url.pathname === "/internal/auth/token" && req.method === "POST") {
      const body = await req.json() as { token?: string };
      const token = String(body.token ?? "").trim();
      if (!token) return jsonError("token required", 400);
      try {
        wmLog("[login] Setting up Claude token...");
        // Write credentials to persistent volume (~/.claude/)
        const credDir = join(HOME_DIR, ".claude");
        await mkdir(credDir, { recursive: true });
        const credPath = join(credDir, ".credentials.json");
        await writeFile(credPath, JSON.stringify({
          claudeAiOauth: {
            accessToken: token,
            expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
            scopes: ["user:inference", "user:profile", "user:sessions:claude_code", "user:mcp_servers"],
          }
        }), { mode: 0o600 });

        // Write .claude.json to skip onboarding
        const claudeJson = join(HOME_DIR, ".claude.json");
        await writeFile(claudeJson, JSON.stringify({
          hasCompletedOnboarding: true,
          lastOnboardingVersion: "2.0.0",
        }));

        // Also set env var for current process
        process.env.CLAUDE_CODE_OAUTH_TOKEN = token;

        // Verify token works
        wmLog("[login] Verifying token...");
        const proc = Bun.spawn({
          cmd: ["claude", "-p", "say ok"],
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, HOME: HOME_DIR },
        });
        const exitCode = await Promise.race([
          proc.exited,
          new Promise<number>(r => setTimeout(() => r(-1), 30_000)),
        ]);
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        if (exitCode === 0 && stdout.trim()) {
          wmLog("[login] Token verified and saved to disk!");
          return Response.json({ ok: true, authenticated: true });
        }
        wmLog(`[login] Token verification failed (exit=${exitCode}): ${stderr.trim()}`);
        return Response.json({ ok: false, error: `Token verification failed: ${stderr.trim().slice(0, 200)}` }, { status: 400 });
      } catch (e) {
        wmLog(`[login] Token setup error: ${e}`);
        return jsonError(`token setup failed: ${e}`, 500);
      }
    }

    // Start Claude login — spawn `claude auth login`, capture the auth URL + code flow
    if (url.pathname === "/internal/auth/login" && req.method === "POST") {
      try {
        wmLog("[login] Starting claude setup-token...");
        const proc = Bun.spawn({
          cmd: ["claude", "setup-token"],
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          env: { ...process.env, BROWSER: "echo" },
        });

        // Read output looking for the auth URL
        let output = "";
        const reader = proc.stdout.getReader();
        const deadline = Date.now() + 15_000;

        while (Date.now() < deadline) {
          const { value, done } = await Promise.race([
            reader.read(),
            new Promise<{ value: undefined; done: true }>(r => setTimeout(() => r({ value: undefined, done: true }), 2000)),
          ]);
          if (done && !value) break;
          if (value) output += new TextDecoder().decode(value);
          const urlMatch = output.match(/(https:\/\/[^\s]+)/);
          if (urlMatch) {
            reader.releaseLock();
            const sessionId = `login_${Date.now()}`;
            loginProcesses.set(sessionId, proc);
            proc.exited.then(() => loginProcesses.delete(sessionId));
            wmLog("[login] Got setup-token URL");
            return Response.json({ loginUrl: urlMatch[1], sessionId, method: "setup-token" });
          }
        }

        reader.releaseLock();
        proc.kill();
        // Fallback: try claude auth login
        wmLog("[login] setup-token didn't produce URL, trying auth login...");
        const proc2 = Bun.spawn({
          cmd: ["claude", "auth", "login"],
          stdout: "pipe", stderr: "pipe", stdin: "pipe",
          env: { ...process.env, BROWSER: "echo" },
        });
        let output2 = "";
        const reader2 = proc2.stdout.getReader();
        const deadline2 = Date.now() + 15_000;
        while (Date.now() < deadline2) {
          const { value, done } = await Promise.race([
            reader2.read(),
            new Promise<{ value: undefined; done: true }>(r => setTimeout(() => r({ value: undefined, done: true }), 2000)),
          ]);
          if (done && !value) break;
          if (value) output2 += new TextDecoder().decode(value);
          const urlMatch = output2.match(/(https:\/\/[^\s]+)/);
          if (urlMatch) {
            reader2.releaseLock();
            const sessionId = `login_${Date.now()}`;
            loginProcesses.set(sessionId, proc2);
            proc2.exited.then(() => loginProcesses.delete(sessionId));
            wmLog("[login] Got auth login URL");
            return Response.json({ loginUrl: urlMatch[1], sessionId, method: "auth-login" });
          }
        }
        reader2.releaseLock();
        proc2.kill();
        return Response.json({ error: "could not start login", stdout: output.trim() + output2.trim() }, { status: 500 });
      } catch (e) {
        wmLog(`[login] Error: ${e}`);
        return jsonError(`login failed: ${e}`, 500);
      }
    }

    // Submit token from setup-token flow
    if (url.pathname === "/internal/auth/code" && req.method === "POST") {
      const body = await req.json() as { sessionId?: string; code?: string };
      const sid = String(body.sessionId ?? "");
      const code = String(body.code ?? "").trim();
      if (!code) return jsonError("code/token required", 400);

      // If it looks like a setup-token (sk-*), set it directly as env var
      if (code.startsWith("sk-")) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = code;
        wmLog("[login] Setup token set!");
        return Response.json({ ok: true, authenticated: true });
      }

      // Otherwise try piping to the waiting process
      const proc = sid ? loginProcesses.get(sid) : null;
      if (proc) {
        try {
          wmLog("[login] Submitting code to process...");
          proc.stdin.write(code + "\n");
          proc.stdin.end();
          const exitCode = await Promise.race([
            proc.exited,
            new Promise<number>(r => setTimeout(() => r(-1), 30_000)),
          ]);
          loginProcesses.delete(sid);
          if (hasClaudeCredentials()) {
            wmLog("[login] Authenticated!");
            return Response.json({ ok: true, authenticated: true });
          }
          return Response.json({ ok: false, error: `auth failed (exit=${exitCode})` }, { status: 400 });
        } catch (e) {
          return jsonError(`code submission failed: ${e}`, 500);
        }
      }

      return jsonError("no active login session", 404);
    }

    // Execute shell command in workspace dir
    if (url.pathname === "/internal/exec" && req.method === "POST") {
      const body = await req.json() as { command?: string };
      const command = String(body.command ?? "").trim();
      if (!command) return jsonError("command required", 400);
      wmLog(`[exec] $ ${command}`);
      try {
        const proc = Bun.spawn({
          cmd: ["bash", "-c", command],
          cwd: WORKSPACE_DIR,
          stdout: "pipe",
          stderr: "pipe",
          env: process.env,
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const output = (stdout + stderr).trim();
        if (output) wmLog(`[exec] ${output.split("\n").slice(0, 5).join("\n")}`);
        return Response.json({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() });
      } catch (e) {
        return jsonError(`exec failed: ${e}`, 500);
      }
    }

    // Check if a login process completed (credentials appeared)
    if (url.pathname === "/internal/auth/status" && req.method === "GET") {
      return Response.json({
        authenticated: hasClaudeCredentials(),
      });
    }

    // Stream container logs as SSE
    if (url.pathname === "/internal/logs" && req.method === "GET") {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          // Send initial logs
          for (const line of wmletLogs.slice(-100)) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
          }
          // Subscribe to new logs
          const handler = (line: string) => {
            try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`)); } catch {}
          };
          logSubscribers.add(handler);
          // Cleanup on close
          const interval = setInterval(() => {
            try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { clearInterval(interval); logSubscribers.delete(handler); }
          }, 15000);
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
      });
    }

    // Write credentials from external source (e.g. wsmanager OAuth flow)
    if (url.pathname === "/internal/auth/credentials" && req.method === "POST") {
      try {
        const creds = await req.json();
        const home = HOME_DIR;
        const credPath = join(home, ".claude", ".credentials.json");
        await mkdir(join(home, ".claude"), { recursive: true });
        await writeFile(credPath, JSON.stringify(creds), { mode: 0o600 });
        console.log("[wmlet] credentials written via API");
        return Response.json({ ok: true });
      } catch (e) {
        return jsonError(`failed to write credentials: ${e}`, 500);
      }
    }

    if (url.pathname === "/internal/topics" && req.method === "GET") {
      return Response.json([...topics.values()].map((topic) => summary(topic)));
    }

    if (url.pathname === "/internal/topics" && req.method === "POST") {
      const body = await req.json() as { name?: string };
      const name = String(body.name ?? "").trim();
      if (!name) return jsonError("name required", 400);
      if (topics.has(name)) return jsonError("already exists", 409);
      // Check Claude auth before spawning agent
      if (!hasClaudeCredentials()) {
        return Response.json({
          error: "claude_not_authenticated",
          message: "Claude is not authenticated. Please log in first.",
        }, { status: 401 });
      }
      const topic = await createTopic(name);
      return Response.json(summary(topic), { status: 201 });
    }

    const topicMatch = url.pathname.match(/^\/internal\/topics\/([^/]+)$/);
    if (topicMatch && req.method === "GET") {
      const topicName = topicMatch[1];
      if (!topicName) return jsonError("not found", 404);
      const topic = topics.get(decodeURIComponent(topicName));
      if (!topic) return jsonError("not found", 404);
      return Response.json(topicState(topic));
    }

    if (topicMatch && req.method === "DELETE") {
      const topicName = topicMatch[1] ? decodeURIComponent(topicMatch[1]) : "";
      if (!topicName) return jsonError("not found", 404);
      const topic = topics.get(topicName);
      if (!topic) return jsonError("not found", 404);
      topic.process.kill();
      for (const ws of topic.sockets) ws.close();
      topics.delete(topicName);
      // Remove persisted history
      await rm(`${WORKSPACE_DIR}/.topics/${topicName}`, { recursive: true, force: true }).catch(() => {});
      return Response.json({ name: topicName, status: "archived" });
    }

    const queueMatch = url.pathname.match(/^\/internal\/topics\/([^/]+)\/queue\/([^/]+)$/);
    if (queueMatch && req.method === "PATCH") {
      const actor = ensureInternalActor(req);
      const topicName = queueMatch[1];
      const runName = queueMatch[2];
      if (!topicName || !runName) return jsonError("not found", 404);
      const topic = topics.get(decodeURIComponent(topicName));
      if (!topic) return jsonError("not found", 404);
      const runId = decodeURIComponent(runName);
      const run = requireQueuedRun(topic, runId, actor);
      const body = await req.json() as { data?: string };
      const text = String(body.data ?? "").trim();
      if (!text) return jsonError("data required", 400);
      run.text = text;
      announceQueue(topic);
      return Response.json(topicState(topic));
    }

    if (queueMatch && req.method === "DELETE") {
      const actor = ensureInternalActor(req);
      const topicName = queueMatch[1];
      const runName = queueMatch[2];
      if (!topicName || !runName) return jsonError("not found", 404);
      const topic = topics.get(decodeURIComponent(topicName));
      if (!topic) return jsonError("not found", 404);
      const runId = decodeURIComponent(runName);
      const run = requireQueuedRun(topic, runId, actor);
      removeQueuedRun(topic, runId);
      run.state = "cancelled";
      run.reason = "removed from queue";
      emitRunUpdate(topic, {
        runId,
        state: "cancelled",
        reason: run.reason,
        interruptedBy: actor,
      });
      announceQueue(topic);
      return new Response(null, { status: 204 });
    }

    const moveMatch = url.pathname.match(/^\/internal\/topics\/([^/]+)\/queue\/([^/]+)\/move$/);
    if (moveMatch && req.method === "POST") {
      const actor = ensureInternalActor(req);
      const topicName = moveMatch[1];
      const runName = moveMatch[2];
      if (!topicName || !runName) return jsonError("not found", 404);
      const topic = topics.get(decodeURIComponent(topicName));
      if (!topic) return jsonError("not found", 404);
      const runId = decodeURIComponent(runName);
      requireQueuedRun(topic, runId, actor);
      const body = await req.json() as { direction?: string };
      const currentIndex = topic.queue.indexOf(runId);
      if (currentIndex < 0) return jsonError("run not found", 404);
      const direction = body.direction;
      let nextIndex = currentIndex;
      switch (direction) {
        case "up":
          nextIndex = Math.max(0, currentIndex - 1);
          break;
        case "down":
          nextIndex = Math.min(topic.queue.length - 1, currentIndex + 1);
          break;
        case "top":
          nextIndex = 0;
          break;
        case "bottom":
          nextIndex = topic.queue.length - 1;
          break;
        default:
          return jsonError("invalid direction", 400);
      }
      topic.queue.splice(currentIndex, 1);
      topic.queue.splice(nextIndex, 0, runId);
      announceQueue(topic);
      return Response.json(topicState(topic));
    }

    const clearMatch = url.pathname.match(/^\/internal\/topics\/([^/]+)\/queue:clear-mine$/);
    if (clearMatch && req.method === "POST") {
      const actor = ensureInternalActor(req);
      const topicName = clearMatch[1];
      if (!topicName) return jsonError("not found", 404);
      const topic = topics.get(decodeURIComponent(topicName));
      if (!topic) return jsonError("not found", 404);
      const removed: string[] = [];
      const remaining: string[] = [];
      for (const runId of topic.queue) {
        const run = topic.runs.get(runId);
        if (!run) continue;
        if (run.submittedBy.id === actor.id) {
          run.state = "cancelled";
          run.reason = "removed from queue";
          run.interruptedBy = actor;
          removed.push(runId);
          emitRunUpdate(topic, {
            runId,
            state: "cancelled",
            reason: run.reason,
            interruptedBy: actor,
          });
          continue;
        }
        remaining.push(runId);
      }
      topic.queue = remaining;
      announceQueue(topic);
      return Response.json({ removed });
    }

    const injectMatch = url.pathname.match(/^\/internal\/topics\/([^/]+)\/inject$/);
    if (injectMatch && req.method === "POST") {
      const topicName = injectMatch[1];
      if (!topicName) return jsonError("not found", 404);
      const topic = topics.get(decodeURIComponent(topicName));
      if (!topic) return jsonError("not found", 404);
      const run = activeRun(topic);
      if (!run) return jsonError("no active run", 409);
      return jsonError("inject unsupported by ACP runtime", 501);
    }

    const interruptMatch = url.pathname.match(/^\/internal\/topics\/([^/]+)\/interrupt$/);
    if (interruptMatch && req.method === "POST") {
      const actor = ensureInternalActor(req);
      const topicName = interruptMatch[1];
      if (!topicName) return jsonError("not found", 404);
      const topic = topics.get(decodeURIComponent(topicName));
      if (!topic) return jsonError("not found", 404);
      const run = activeRun(topic);
      if (!run) return jsonError("no active run", 409);
      const body = await req.json() as { reason?: string };
      run.reason = String(body.reason ?? "").trim() || "interrupted";
      run.interruptedBy = actor;
      await topic.connection.cancel({ sessionId: topic.sessionId });
      return Response.json({ runId: run.runId, status: "accepted" });
    }

    // ── /agents — list available agent harnesses (public API) ──
    if (url.pathname === "/agents" && req.method === "GET") {
      const agents: Array<{ id: string; name: string; description: string; command: string }> = [];

      // Scan node_modules/.bin for ACP-compatible agents
      const binDir = join(process.cwd(), "node_modules", ".bin");
      try {
        const bins = await readdir(binDir);
        for (const bin of bins) {
          if (bin.includes("agent") && bin.includes("acp")) {
            const id = bin.replace(/-acp$/, "").replace(/^.*-agent-/, "");
            agents.push({
              id: bin,
              name: id.charAt(0).toUpperCase() + id.slice(1),
              description: `ACP agent: ${bin}`,
              command: join(binDir, bin),
            });
          }
        }
      } catch {}

      // Scan workspace for CLAUDE.md / AGENTS.md at root and subdirs
      const instructions: Array<{ path: string; name: string }> = [];
      for (const name of ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"]) {
        const fp = join(WORKSPACE_DIR, name);
        try {
          await stat(fp);
          instructions.push({ path: name, name });
        } catch {}
      }

      return Response.json({ agents, instructions });
    }

    if (url.pathname === "/internal/files" && req.method === "GET") {
      const relativePath = relativeWorkspacePath(url.searchParams.get("path"));
      try {
        return Response.json(await fileInfo(relativePath));
      } catch (error) {
        if (error instanceof Response) return error;
        return jsonError("not found", 404);
      }
    }

    if (url.pathname === "/internal/files/content" && req.method === "GET") {
      const relativePath = relativeWorkspacePath(url.searchParams.get("path"));
      try {
        const content = await readFile(workspacePath(relativePath));
        return new Response(content);
      } catch (error) {
        if (error instanceof Response) return error;
        return jsonError("not found", 404);
      }
    }

    if (url.pathname === "/internal/files/content" && req.method === "PUT") {
      const relativePath = relativeWorkspacePath(url.searchParams.get("path"));
      const fullPath = workspacePath(relativePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, Buffer.from(await req.arrayBuffer()));
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/internal/files/directories" && req.method === "POST") {
      const relativePath = relativeWorkspacePath(url.searchParams.get("path"));
      await mkdir(workspacePath(relativePath), { recursive: true });
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/internal/files/move" && req.method === "POST") {
      const body = await req.json() as { from?: string; to?: string };
      const from = relativeWorkspacePath(body.from ?? "");
      const to = relativeWorkspacePath(body.to ?? "");
      if (!from || !to) return jsonError("from and to required", 400);
      const target = workspacePath(to);
      await mkdir(dirname(target), { recursive: true });
      await rename(workspacePath(from), target);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/internal/files" && req.method === "DELETE") {
      const relativePath = relativeWorkspacePath(url.searchParams.get("path"));
      const recursive = url.searchParams.get("recursive") === "true";
      try {
        await rm(workspacePath(relativePath), { recursive, force: false });
        return new Response(null, { status: 204 });
      } catch (error) {
        if (error instanceof Response) return error;
        return jsonError("not found", 404);
      }
    }

    // ── /resources — RESTful file browser ──
    // GET  /resources/            — file tree sidebar partial
    // GET  /resources/{path}      — file content (HTML partial or raw)
    // PUT  /resources/{path}      — create/update file
    // DELETE /resources/{path}    — delete file
    const BROWSE_BASE = url.searchParams.get("base") || "/resources";
    const UI_BASE = url.searchParams.get("ui") || undefined;
    const resourceMatch = url.pathname.match(/^\/resources(?:\/(.*))?$/);

    if (resourceMatch) {
      const rawPath = resourceMatch[1] ?? "";
      const rp = relativeWorkspacePath(rawPath || null) || "";
      const tab = url.searchParams.get("tab") || undefined;
      const accept = req.headers.get("accept") || "";

      if (req.method === "GET" && !rawPath) {
        // GET /resources/ — directory listing sidebar
        const dirPath = url.searchParams.get("path") || "";
        const dp = relativeWorkspacePath(dirPath || null) || "";
        const files = await listDir(WORKSPACE_DIR, dp);
        return new Response(
          FileSidebar({ files, currentPath: dp, basePath: BROWSE_BASE, uiBase: UI_BASE }),
          { headers: { "Content-Type": "text/html" } },
        );
      }

      if (req.method === "GET" && rawPath) {
        // GET /resources/{path} — file content
        const fullPath = workspacePath(rp);
        const name = basename(rp);
        if (!isTextFile(name)) {
          return new Response(Bun.file(fullPath));
        }
        const content = (await readFile(fullPath, "utf-8")).toString();
        // Return HTML view by default; raw text only if explicitly requested
        if (accept === "text/plain") {
          return new Response(content, { headers: { "Content-Type": "text/plain" } });
        }
        return new Response(
          await FileContentView({ filePath: rp, content, tab, basePath: BROWSE_BASE, uiBase: UI_BASE }),
          { headers: { "Content-Type": "text/html" } },
        );
      }

      if (req.method === "PUT" && rawPath) {
        // PUT /resources/{path} — create or update file
        const fullPath = workspacePath(rp);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, await req.text());
        return new Response(null, { status: 204 });
      }

      if (req.method === "DELETE" && rawPath) {
        // DELETE /resources/{path}
        const fullPath = workspacePath(rp);
        await rm(fullPath, { recursive: false, force: false });
        return new Response(null, { status: 204 });
      }
    }

    return jsonError("not found", 404);
  },

  websocket: {
    async open(ws) {
      const topicName = String(ws.data.topicName);
      const topic = await getOrCreateTopic(topicName);
      topic.sockets.add(ws);

      send(ws, {
        type: "connected",
        topic: topicName,
        protocolVersion: TOPIC_PROTOCOL_VERSION,
        replay: true,
      });
      send(ws, {
        type: "topic_state",
        ...topicState(topic),
      });
      for (const event of topic.history) {
        send(ws, { ...event, replay: true });
      }
    },

    async message(ws, raw) {
      const topicName = String(ws.data.topicName);
      const actor = ws.data.actor;
      if (!actor) {
        send(ws, { type: "error", data: "missing actor" });
        ws.close();
        return;
      }
      const topic = topics.get(topicName);
      if (!topic) {
        send(ws, { type: "error", data: "topic not found" });
        return;
      }

      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", data: "invalid json" });
        return;
      }

      switch (msg.type) {
        case "submit_run": {
          const text = String(msg.text ?? "").trim();
          if (!text) {
            send(ws, { type: "error", data: "text required" });
            return;
          }
          await submitRun(topic, actor, text, typeof msg.position === "number" ? msg.position : undefined);
          return;
        }
        case "inject": {
          const run = activeRun(topic);
          if (!run) {
            send(ws, { type: "inject_status", status: "rejected", reason: "no active run" });
            return;
          }
          send(ws, {
            type: "inject_status",
            injectId: randomId("inj"),
            runId: run.runId,
            status: "rejected",
            reason: "inject unsupported by ACP runtime",
          });
          return;
        }
        case "interrupt": {
          const run = activeRun(topic);
          if (!run) {
            send(ws, { type: "interrupt_status", status: "rejected", reason: "no active run" });
            return;
          }
          run.reason = String(msg.reason ?? "").trim() || "interrupted";
          run.interruptedBy = actor;
          await topic.connection.cancel({ sessionId: topic.sessionId });
          send(ws, {
            type: "interrupt_status",
            runId: run.runId,
            status: "accepted",
          });
          return;
        }
        default:
          send(ws, { type: "error", data: `unsupported message type: ${msg.type}` });
      }
    },

    close(ws) {
      const topicName = String(ws.data.topicName);
      const topic = topics.get(topicName);
      if (topic) {
        topic.sockets.delete(ws);
      }
    },
  },
});

// Check if Claude credentials exist locally
function hasClaudeCredentials(): boolean {
  // Check env var first (setup-token flow)
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  // Check credentials file
  const home = HOME_DIR;
  const credPath = join(home, ".claude", ".credentials.json");
  try {
    const content = readFileSync(credPath, "utf-8");
    const creds = JSON.parse(content);
    return !!(creds?.claudeAiOauth?.accessToken);
  } catch {
    return false;
  }
}

// No auto-provisioning — users log in via claude login inside the container
// Load persisted token from credentials file into env if not already set
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN && hasClaudeCredentials()) {
  try {
    const home = HOME_DIR;
    const creds = JSON.parse(readFileSync(join(home, ".claude", ".credentials.json"), "utf-8"));
    if (creds?.claudeAiOauth?.accessToken) {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = creds.claudeAiOauth.accessToken;
      wmLog("[wmlet] loaded token from persisted credentials");
    }
  } catch {}
}

if (hasClaudeCredentials()) {
  wmLog("[wmlet] credentials present");
} else {
  wmLog("[wmlet] no credentials — use login to authenticate");
}

wmLog(`[wmlet] listening on :${PORT}`);
wmLog(`[wmlet] workspace: ${WORKSPACE_DIR}`);

// Restore persisted topics
if (hasClaudeCredentials()) {
  restoreTopics().catch((e) => wmLog(`[restore] error: ${e}`));
}

} // end if (isMainModule)
