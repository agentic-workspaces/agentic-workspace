import type { Actor } from "./auth.ts";

export const TOPIC_PROTOCOL_VERSION = "workspace-topic-v1";
export const MANAGER_PROTOCOL_VERSION = "workspace-manager-v1";

export type RunState = "queued" | "running" | "completed" | "cancelled" | "failed";

export interface ActiveRun {
  runId: string;
  state: "running";
  interruptible: boolean;
  submittedBy: Actor;
}

export interface QueuedRun {
  runId: string;
  state: "queued";
  text: string;
  position: number;
  submittedBy: Actor;
}

export interface TopicSummary {
  name: string;
  activeRun?: ActiveRun | null;
  queuedCount: number;
  createdAt: string;
  events?: string;
}

export interface TopicState extends TopicSummary {
  queue: QueuedRun[];
}

export interface ManagedToolGrant {
  grantId: string;
  subject: string;
  tools: string[];
  access: "allowed" | "approval_required" | "denied";
  approvers?: string[];
  scope?: Record<string, unknown>;
}

export interface ManagedTool {
  kind: "mcp";
  name: string;
  description?: string;
  provider?: string;
  protocol: "mcp";
  transport: {
    type: string;
    url: string;
    headers?: Record<string, string>;
  };
  grants: ManagedToolGrant[];
}

export interface WorkspaceSummary {
  id: string;
  namespace: string;
  name: string;
  status: "starting" | "running" | "stopped" | "deleted";
  createdAt: string;
}

export interface WorkspaceDetail extends WorkspaceSummary {
  topics: TopicSummary[];
}

export function isTerminalRunState(state: RunState): boolean {
  return state === "completed" || state === "cancelled" || state === "failed";
}

export function wsURLForRequest(req: Request, path: string): string {
  const url = new URL(req.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  url.search = "";
  return url.toString();
}

export function namespaceBase(namespace: string): string {
  return `/apis/v1/namespaces/${encodeURIComponent(namespace)}`;
}

export function workspaceBase(namespace: string, workspace: string): string {
  return `${namespaceBase(namespace)}/workspaces/${encodeURIComponent(workspace)}`;
}

export function topicEventsPath(namespace: string, workspace: string, topic: string): string {
  return `${workspaceBase(namespace, workspace)}/topics/${encodeURIComponent(topic)}/events`;
}

export function topicSummary(
  namespace: string,
  workspace: string,
  req: Request,
  topic: Omit<TopicState, "events" | "queue"> & { queue?: QueuedRun[] },
): TopicSummary {
  return {
    name: topic.name,
    activeRun: topic.activeRun ?? null,
    queuedCount: topic.queue?.length ?? topic.queuedCount ?? 0,
    createdAt: topic.createdAt,
    events: wsURLForRequest(req, topicEventsPath(namespace, workspace, topic.name)),
  };
}

export function topicState(
  namespace: string,
  workspace: string,
  req: Request,
  topic: TopicState,
): TopicState {
  return {
    ...topic,
    events: wsURLForRequest(req, topicEventsPath(namespace, workspace, topic.name)),
  };
}
