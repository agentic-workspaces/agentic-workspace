/**
 * Basic smoke script for the Bun reference implementation.
 *
 * Usage: bun run test.ts
 * Requires: wsmanager running on :31337 and the workspace image built.
 */

import { mintUnsignedJWT } from "./auth.ts";

const MANAGER = process.env.WS_MANAGER || "http://localhost:31337";
const WORKSPACE_NAME = "test-ws";
const TOPIC_NAME = "general";
const TOKEN = mintUnsignedJWT("reference-test", "Reference Test");

function authHeaders(extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${TOKEN}`,
    ...extra,
  };
}

async function managerNamespace(): Promise<string> {
  const response = await fetch(`${MANAGER}/health`);
  const health = await response.json() as { namespace?: string };
  return health.namespace || "default";
}

async function cleanup(namespace: string) {
  await fetch(
    `${MANAGER}/apis/v1/namespaces/${encodeURIComponent(namespace)}/workspaces/${encodeURIComponent(WORKSPACE_NAME)}`,
    { method: "DELETE", headers: authHeaders() },
  ).catch(() => undefined);
}

async function main() {
  const namespace = await managerNamespace();
  await cleanup(namespace);

  const workspaceBase = `${MANAGER}/apis/v1/namespaces/${encodeURIComponent(namespace)}/workspaces/${encodeURIComponent(WORKSPACE_NAME)}`;
  const createResponse = await fetch(`${MANAGER}/apis/v1/namespaces/${encodeURIComponent(namespace)}/workspaces`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      name: WORKSPACE_NAME,
      topics: [{ name: TOPIC_NAME }],
    }),
  });

  if (!createResponse.ok) {
    throw new Error(`create failed: ${await createResponse.text()}`);
  }

  const workspace = await createResponse.json() as {
    name: string;
    topics: Array<{ name: string; events?: string }>;
  };
  console.log("[test] workspace created:", workspace.name);

  const topicStateResponse = await fetch(`${workspaceBase}/topics/${encodeURIComponent(TOPIC_NAME)}`, {
    headers: authHeaders(),
  });
  if (!topicStateResponse.ok) {
    throw new Error(`topic fetch failed: ${await topicStateResponse.text()}`);
  }
  const topicState = await topicStateResponse.json() as { events?: string };
  const eventsURL = topicState.events;
  if (!eventsURL) {
    throw new Error("topic state missing events URL");
  }

  const ws = new WebSocket(eventsURL);
  let authenticated = false;
  let connected = false;
  let sawRunning = false;
  let sawAssistant = false;
  let terminalState: string | null = null;

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "authenticate", token: TOKEN }));
  };

  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "authenticated") {
      authenticated = true;
      return;
    }
    if (message.type === "connected") {
      connected = true;
      ws.send(JSON.stringify({ type: "prompt", data: "say hello in one word" }));
      return;
    }
    if (message.type === "run_updated" && message.state === "running") {
      sawRunning = true;
      return;
    }
    if (message.type === "run_updated" && ["completed", "cancelled", "failed"].includes(message.state)) {
      terminalState = message.state;
      return;
    }
    if (message.type === "message" && message.role === "assistant") {
      sawAssistant = true;
      console.log("[assistant]", message.text);
    }
  };

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && (!authenticated || !connected || !sawRunning || !terminalState || !sawAssistant)) {
    await Bun.sleep(250);
  }

  ws.close();
  await cleanup(namespace);

  if (!authenticated || !connected || !sawRunning || terminalState !== "completed" || !sawAssistant) {
    throw new Error(
      `reference impl smoke did not observe successful run lifecycle `
      + `(authenticated=${authenticated} connected=${connected} `
      + `sawRunning=${sawRunning} terminalState=${terminalState} sawAssistant=${sawAssistant})`,
    );
  }

  console.log("[test] ok");
}

main().catch(async (error) => {
  console.error("[test] error:", error);
  const namespace = await managerNamespace().catch(() => "default");
  await cleanup(namespace);
  process.exit(1);
});
