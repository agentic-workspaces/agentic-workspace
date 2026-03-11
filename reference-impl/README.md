# Agentic Workspace Reference Implementation

This directory contains a Bun-based reference implementation for the
workspace/topic API in [RFC 0001](../rfcs/0001-workspace-topic-api-surface.md).

It is split into:

- `wsmanager.ts`
  The public API server. It owns authentication, the canonical
  `/apis/v1/namespaces/{namespace}/...` surface, and public WebSocket
  endpoints.
- `wmlet.ts`
  The per-workspace runtime inside a container. It speaks an internal API to
  `wsmanager` and uses ACP only as its private execution engine.
- `cli.ts`
  A small client for creating workspaces, managing queues, and connecting to
  topic event streams.

## Status

The current Bun reference implementation now follows the run-centric public
model:

- one active run per topic
- queued future runs
- `topic_state` as authoritative current state
- `run_updated` and `message` on the topic WebSocket
- canonical manager routes under `/apis/v1/namespaces/{namespace}/...`

Current limitations:

- `inject` is exposed, but this runtime rejects it because the ACP runtime used
  underneath does not currently provide a true mid-run append primitive.
- managed tool CRUD is implemented as manager-side state only; it is not yet
  wired into runtime tool execution.
- the file API is implemented and proxied through the manager, but it is still
  a lightweight reference profile, not a hardened storage service.

## Architecture

```text
CLI / Browser
    |
    |  HTTP + WebSocket
    v
wsmanager.ts
    |
    |  internal HTTP + internal WebSocket
    v
wmlet.ts (one per workspace container)
    |
    |  ACP over stdio
    v
claude-agent-acp
```

The public contract is owned by `wsmanager.ts`. `wmlet.ts` is an internal
runtime, not a second public API surface.

## Quick Start

```bash
# Build the runtime image
docker build -t agrp-wmlet .

# Start the public manager
bun run wsmanager.ts

# Create a workspace
bun run ws create my-workspace general debug-timeout

# Connect to a topic
bun run ws connect my-workspace debug-timeout
```

## CLI

```text
bun run ws list
bun run ws create <name> [topics...]
bun run ws delete <name>
bun run ws topics <name>
bun run ws queue <name> <topic>
bun run ws edit-queue <name> <topic> <runId> <text...>
bun run ws move-queue <name> <topic> <runId> <up|down|top|bottom>
bun run ws clear-queue <name> <topic>
bun run ws inject <name> <topic> <text...>
bun run ws interrupt <name> <topic> <reason...>
bun run ws connect <name> [topic]
bun run ws health
```

Inside `connect`, plain text submits a run. `/next` queues at the front.

## Public Surface

The manager exposes the canonical route family:

```text
/apis/v1/namespaces/{namespace}/workspaces
/apis/v1/namespaces/{namespace}/workspaces/{workspace}
/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics
/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}
/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}/events
/apis/v1/namespaces/{namespace}/events
```

Supported REST areas in this reference profile:

- workspaces
- topics
- queue mutation
- interrupt
- managed tool CRUD
- provisional file API

Topic WebSockets use the RFC 0001 message model:

- client:
  - `authenticate`
  - `prompt`
  - `inject`
  - `interrupt`
- server:
  - `authenticated`
  - `connected`
  - `topic_state`
  - `run_updated`
  - `message`
  - `tool_call`
  - `tool_update`
  - `inject_status`
  - `interrupt_status`
  - `error`

## Authentication

HTTP requests use:

```text
Authorization: Bearer <jwt>
```

Topic and namespace WebSockets authenticate with:

```json
{ "type": "authenticate", "token": "<jwt>" }
```

For the demo profile, unsigned JWTs (`alg: none`) are accepted so local runs
do not require key management.

## Sanity Checks

Static check:

```bash
bunx tsc --noEmit
```

Basic runtime smoke against a running manager:

```bash
bun run test.ts
```
