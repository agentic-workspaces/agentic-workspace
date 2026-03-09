# Agent Workspace Protocol

**Status:** Draft
**Date:** March 2026
**Working Group:** Agent-Workspace-Protocol / working-draft

---

## 1. Problem

Today's agent experience is single-player. One human, one agent, one session — running locally on a developer's machine. This creates several problems:

**No collaboration.** If an agent is debugging a production issue, a colleague cannot join the session to observe, help, or take over. There is no way to have two agents work on different parts of the same codebase in parallel while sharing context. Every agent session is an island.

**Ephemeral context.** Close the terminal and the session is gone. There is no way to snapshot the state of a working session, roll back to an earlier point, or fork it to try a different approach. Handing off work to another person means copy-pasting conversation fragments.

**All-or-nothing access.** An agent either has full access to everything or nothing at all. There is no way to say "you can read emails from this sender but need my approval to send" or "you can create pull requests but not push to main". Delegation and approval workflows do not exist.

**Not addressable.** An agent session cannot receive a webhook, respond to an email, or be triggered by a CI event. It has no identity, no inbox, and cannot participate in automated workflows.

**No standard for the environment.** MCP defines tool access. ACP defines how an IDE talks to an agent. A2A defines agent-to-agent collaboration. But there is no specification for the shared environment where humans and agents work together — the workspace itself.

This protocol defines that environment.

---

## 2. A Day with Workspaces

Imagine all of this already exists. What does a typical day look like?

It's Monday morning. Alice is the on-call engineer for the payments team at Acme.

**9:02 AM** — A PagerDuty alert fires: payment timeouts are spiking. Alice opens her terminal and creates a workspace:

```
ws create payments-outage debug-timeout investigate-logs
```

A workspace spins up with the payments repo mounted at `/code`, two topics ready — `debug-timeout` with a Claude agent, and `investigate-logs` with another. Both agents share the same codebase but work independently.

**9:04 AM** — Alice connects to `debug-timeout` and types: "Payment API response times jumped from 200ms to 5s in the last 10 minutes. Find the root cause." The agent starts reading code, checking recent commits, and running queries. Meanwhile, the agent in `investigate-logs` is already analyzing log patterns — Alice had pre-configured it with a system prompt to look for anomalies.

**9:12 AM** — Bob, another engineer, sees the incident channel and joins the same workspace from his IDE. He opens `investigate-logs` to see what that agent found, then creates a new topic: "Bob here, check if the connection pool config changed recently." A fresh agent picks this up.

**9:18 AM** — The agent in `debug-timeout` reports: "Found it. PR #847 merged Friday changed the connection pool timeout from 30s to 3s. Under load, connections are being dropped before queries complete." Alice reviews the evidence, then types: "Prepare a revert PR."

**9:20 AM** — The agent needs to push to GitHub. Alice's workspace has GitHub connected with a policy: creating PRs is allowed, but pushing requires approval. The agent creates the PR and Alice approves the push with one click.

**9:25 AM** — CI passes. Alice merges. The timeout spike starts recovering.

**9:30 AM** — Alice commits the workspace state — a snapshot of the full conversation, agent actions, and files. Now anyone investigating the incident later can clone this workspace and see exactly what happened, what the agents found, and why decisions were made.

**Later** — The incident postmortem links to the workspace. New team members can clone it as a training exercise. The workspace identity `payments-outage.acme@relay.example.com` is in the audit log, showing every tool call, every approval, every action taken.

This is what a multiplayer agent environment looks like.

---

## 3. What is a Workspace

A workspace is an environment for humans and agents to collaborate on shared resources — code, documents, data, or any other resources relevant to the task at hand.

A workspace is organized into topics — named conversation threads focused on specific tasks. Agents live inside topics as persistent instances. Humans connect to the workspace and can participate in any topic. Every action is visible to everyone: who did what, why, and when.

Tools are governed by granular access control: each tool can be freely available, restricted by role, or require explicit approval for every use. Participants can delegate specific permissions to each other — a human can grant an agent the right to deploy, or an agent can request shell access for a particular task. This makes a workspace a controlled operational environment, not just a shared folder.

A workspace has an email-like identity (e.g. `payments-debug.acme@relay.example.com`). This identity serves multiple purposes: it is the address for receiving external events (webhooks, emails, scheduled triggers), the subject for access control (granting permissions to a workspace as a whole), and the principal for workload identity when accessing external services. A workspace is not an isolated bubble but an addressable, authenticatable participant in broader workflows.

A workspace is defined by a declarative specification and is not tied to a specific machine or platform. The same workspace can run locally, in a private cloud, or in a public cloud — any compliant runtime can host it.

The entire workspace state — resources, conversation, configuration — is versioned. Participants can commit a snapshot, roll back to any previous point, or clone the workspace to experiment safely.

---

## 4. Workspace Manager

Workspace Manager is a service that manages workspace lifecycle — creating, listing, connecting, suspending, and terminating workspaces. It exposes a REST API that clients use before establishing an ACP connection.

The typical flow: a client calls the Manager API to create or find a workspace, receives a connection endpoint, and then connects via ACP to participate.

### API

All resources are scoped to a namespace, following the Kubernetes convention.

```
POST   /apis/v1/namespaces/{ns}/workspaces                — create a workspace
GET    /apis/v1/namespaces/{ns}/workspaces                — list workspaces
GET    /apis/v1/namespaces/{ns}/workspaces/{name}         — get workspace details and connection endpoint
DELETE /apis/v1/namespaces/{ns}/workspaces/{name}         — terminate a workspace
PUT    /apis/v1/namespaces/{ns}/workspaces/{name}/suspend — suspend a workspace
PUT    /apis/v1/namespaces/{ns}/workspaces/{name}/resume  — resume a suspended workspace
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/clone   — clone a workspace
```

Workspace state versioning:

```
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/commits              — list commits
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/commits              — create a commit (snapshot)
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/commits/{commit}     — get commit details
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/commits/{commit}/rollback — rollback to this commit
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/commits/{commit}/clone    — clone workspace from this commit
```

Each workspace also exposes a Resource API for direct access to files:

```
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/files/{path}  — read file content
PUT    /apis/v1/namespaces/{ns}/workspaces/{name}/files/{path}  — write file content
DELETE /apis/v1/namespaces/{ns}/workspaces/{name}/files/{path}  — delete file
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/files/{path}/ — list directory
```

### Example

**1. Create a workspace with topics:**

```yaml
# POST /apis/v1/namespaces/acme/workspaces
name: payments-debug
participants:
  - subject: alice@acme.com
    role: owner
  - subject: bob@acme.com
    role: contributor
resources:
  - source: git://github.com/acme/payments
    path: /code
topics:
  - name: general
  - name: debug-timeout
    agents:
      - agent: claude
        harness: anthropic/claude-code
  - name: refactor-api
    agents:
      - agent: claude
        harness: anthropic/claude-code
```

Human participants (alice, bob) connect to the workspace and can read and write to any topic. Each agent instance is scoped to its topic — the claude in `debug-timeout` has a separate conversation context from the claude in `refactor-api`, but both share the same workspace resources.

**Response:**

```yaml
id: payments-debug.acme@relay.example.com
namespace: acme
name: payments-debug
status: active
endpoint: wss://relay.example.com/acp/acme/payments-debug
topics:
  - name: general
    acp: wss://relay.example.com/acp/acme/payments-debug/topics/general
  - name: debug-timeout
    acp: wss://relay.example.com/acp/acme/payments-debug/topics/debug-timeout
  - name: refactor-api
    acp: wss://relay.example.com/acp/acme/payments-debug/topics/refactor-api
```

**2. Clone a workspace:**

```yaml
# POST /apis/v1/namespaces/acme/workspaces/payments-debug/clone
name: payments-experiment
commit: c3
```

This creates a new independent workspace `payments-experiment` from the state of `payments-debug` at commit `c3`. The clone has the same resources, configuration, and conversation history up to that point. From here the two workspaces evolve independently — useful for safe experimentation, parallel approaches, or handing off context to another team.

**3. Connect via ACP:**

Alice opens her IDE and connects to `wss://relay.example.com/acp/acme/payments-debug`. She sees all topics — `general`, `debug-timeout`, `refactor-api`. She opens `debug-timeout` and types a message — the agent in that topic responds. Bob joins later and opens `refactor-api` to work on a different task. Both share the same codebase at `/code`.

Topics can be added later without restarting the workspace:

```yaml
# POST /apis/v1/namespaces/acme/workspaces/payments-debug/topics
name: write-tests
agents:
  - agent: claude
    harness: anthropic/claude-code
```

---

## 5. Tools

Tools are first-class resources in a workspace. A tool represents a capability — reading email, creating a pull request, querying a database, executing shell commands — together with the credentials to access it and the policy governing who can use it and how.

### Tool Registry

A global registry where tools are published and discovered. Each tool in the registry describes:

```yaml
tool: gmail
version: 1.2.0
description: Read, send, and manage email via Gmail API
protocol: mcp
actions:
  - read
  - send
  - list
  - search
```

### Connecting Tools to a Workspace

When a tool is connected to a workspace, it gets a credential binding (who provides access) and a policy (who can do what). The participant who connects the tool decides what to share.

```yaml
# Alice connects her Gmail to the workspace
tool: gmail
provider: alice@acme.com
grants:
  - subject: agent:claude
    actions: [read, search]
    scope: { from: "client@example.com" }
  - subject: agent:claude
    actions: [send]
    access: approval_required
    approvers: [alice@acme.com]
  - subject: role:contributor
    actions: [read]
```

In this example, agent `claude` can read emails from a specific sender without asking, but sending requires Alice's approval. All contributors can read.

### Delegation

Participants can delegate tool access at runtime — not just at workspace creation time. Delegation is scoped and revocable:

```yaml
# Bob grants claude access to his GitHub repos for this workspace
tool: github
provider: bob@acme.com
grants:
  - subject: agent:claude
    actions: [repo.read, pr.create, pr.comment]
  - subject: agent:claude
    actions: [repo.push]
    access: approval_required
    approvers: [bob@acme.com]
```

Every delegation is recorded in the audit log. Grants can be revoked at any time.

### API

```
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/tools              — list connected tools
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/tools              — connect a tool
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/tools/{tool}       — get tool details and grants
DELETE /apis/v1/namespaces/{ns}/workspaces/{name}/tools/{tool}       — disconnect a tool
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/tools/{tool}/grants — add a grant
DELETE /apis/v1/namespaces/{ns}/workspaces/{name}/tools/{tool}/grants/{grant} — revoke a grant
```

All tool calls go through the workspace runtime, which enforces policy, checks grants, injects credentials, and logs every invocation. Agents never see raw tokens or secrets.

---

## 6. Topics

A workspace contains one or more **topics** — named conversation threads where agents work on specific tasks. Topics can be created together with the workspace or added later.

**Agents** live inside topics. Each topic has its own agent instance with a separate conversation context. An agent in `debug-timeout` knows nothing about the conversation in `refactor-api`, but both agents share the same workspace resources (files, tools, credentials).

**Humans** connect to the workspace as a whole and can participate in any topic — read messages, send prompts, observe agent work. A human can follow multiple topics simultaneously.

### API

```
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/topics              — list topics
POST   /apis/v1/namespaces/{ns}/workspaces/{name}/topics              — create a topic
GET    /apis/v1/namespaces/{ns}/workspaces/{name}/topics/{topic}      — get topic details
DELETE /apis/v1/namespaces/{ns}/workspaces/{name}/topics/{topic}      — archive a topic
```

Each topic has its own ACP endpoint:

```
wss://relay.example.com/acp/acme/payments-debug/topics/debug-timeout
```

### Lifecycle

Topics can be created in three ways:

1. **At workspace creation** — listed in the workspace spec under `topics:`
2. **Via REST API** — `POST /topics` with a name and optional agent configuration
3. **On demand** — when a human connects to a topic that doesn't exist yet, it is created automatically

Each topic maps to an ACP session. When a topic is archived, its conversation history is preserved in workspace state but the agent process is terminated.
