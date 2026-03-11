# Agentic Workspace — Reference Implementation

Minimal reference implementation of the Agentic Workspace protocol.
Runs Claude inside Docker containers, exposes ACP over WebSocket.

## Architecture

```
┌──────────────┐    REST API     ┌──────────────────────────────┐
│  CLI (cli.ts)│───────────────→ │  wsmanager (wsmanager.ts)    │
│              │                 │  :31337                       │
│  ws create   │                 │  - POST/GET/DELETE /workspaces│
│  ws list     │                 │  - reads token from keychain  │
│  ws topics   │                 │  - docker run per workspace   │
│  ws connect  │                 │  - pre-creates topics         │
└──────┬───────┘                 └──────────┬───────────────────┘
       │                                    │ docker run
       │ WebSocket                          ▼
       │                         ┌──────────────────────────┐
       └────────────────────────→│  wmlet container         │
                                 │  :52001 (per workspace)  │
                                 │                          │
                                 │  Topics:                 │
                                 │  ┌─ general ──→ claude  │
                                 │  ├─ debug    ──→ claude  │
                                 │  └─ refactor ──→ claude  │
                                 │                          │
                                 │  Each topic = separate   │
                                 │  claude-agent-acp process│
                                 │  with own ACP session    │
                                 │                          │
                                 │  /workspace/ (files+git) │
                                 └──────────────────────────┘
```

**Agents** live inside topics — each topic runs a separate `claude-agent-acp`
process with its own conversation context, sharing workspace resources.

**Humans** connect to the workspace and can participate in any topic.

**wsmanager** — runs on the host, manages workspace lifecycle via Docker.
Reads Claude OAuth token from macOS keychain and injects it into containers.

**wmlet** — runs inside each container. Manages topics, spawns agent processes,
translates between ACP (JSON-RPC over stdio) and WebSocket.

**cli** — command-line client to create workspaces, manage topics, connect.

## Quick Start

```bash
# 1. Build the workspace container image
docker build -t agrp-wmlet .

# 2. Start the workspace manager
bun run wsmanager.ts

# 3. Create a workspace with topics
bun run ws create my-task general debug-timeout refactor-api

# 4. Connect to a topic
bun run ws connect my-task debug-timeout
```

## CLI Commands

```
bun run ws list                          List all workspaces
bun run ws create <name> [topics...]     Create workspace (optionally with topics)
bun run ws delete <name>                 Delete workspace (stops container)
bun run ws topics <name>                 List topics in workspace
bun run ws connect <name> [topic]        Connect to topic (default: general)
bun run ws health                        Show manager status
```

Inside a connected topic, type a message and press Enter.
Type `/quit` to disconnect.

## API

### Workspace Manager — wsmanager (REST, :31337)

```
POST   /workspaces          Create workspace  { "name": "x", "topics": ["a","b"] }
GET    /workspaces          List workspaces
GET    /workspaces/:name    Get workspace details + ACP endpoint
DELETE /workspaces/:name    Delete workspace
GET    /health              Manager health
```

### Workspace — wmlet (REST + WebSocket, per container)

Topics REST:
```
GET    /topics              List topics
POST   /topics              Create topic  { "name": "debug" }
GET    /topics/:name        Get topic details
DELETE /topics/:name        Archive topic
GET    /health              Workspace health
```

Topic ACP (WebSocket):
```
WS     /acp/:topic          Connect to topic
```

Messages from client:
```json
{ "type": "prompt", "data": "your message here" }
```

Messages from server:
```json
{ "type": "connected", "topic": "debug" }
{ "type": "text", "data": "response chunk" }
{ "type": "tool_call", "title": "Read", "status": "running" }
{ "type": "tool_update", "toolCallId": "...", "status": "completed" }
{ "type": "done" }
{ "type": "error", "data": "error message" }
{ "type": "system", "data": "starting agent..." }
```

## Files

| File | Runs | Purpose |
|------|------|---------|
| `wsmanager.ts` | Host | REST API, manages Docker containers |
| `wmlet.ts` | Container | Topic manager, ACP bridge per topic |
| `cli.ts` | Host | CLI client |
| `Dockerfile` | — | Container image: bun + node + claude-agent-acp |

## Requirements

- [Bun](https://bun.sh) runtime
- Docker
- Claude subscription (token read from macOS keychain)
