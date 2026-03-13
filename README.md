# Agentic Workspace

A protocol for multiplayer agent environments — where humans and AI agents collaborate on shared resources.

## The Problem

Today's agent experience is single-player. One human, one agent, one session. Close the terminal and it's gone. No collaboration, no delegation, no audit trail.

Agentic Workspace defines the shared environment where multiple humans and multiple agents work together — with topics, queues, approvals, versioned state, and addressable identity.

## Relationship to ACP

[Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) (ACP) defines how a single client talks to a single agent — synchronous JSON-RPC over stdio, one prompt turn at a time. It is the "IDE ↔ agent subprocess" protocol, like LSP for agents.

ACP is inherently single-player:

- **One client** — the agent runs as a subprocess of the client (IDE)
- **Synchronous prompt turns** — send `session/prompt`, wait for response, then send the next one
- **No identity** — no concept of who is asking; the client is whoever holds the stdio pipe
- **No queue** — unnecessary when there is only one client and prompts are synchronous
- **No mid-turn input** — no way to steer the agent while it is working

Agentic Workspace builds a multiplayer layer on top of ACP:

|  | ACP | Agentic Workspace |
|---|---|---|
| Participants | 1 client | N humans + M agents |
| Prompt model | synchronous RPC | async runs with queue |
| Identity | none | JWT-based actors |
| Approval | "can I?" to the one user | workflow with designated approvers |
| Cancel | client cancels itself | interrupt with attribution |
| Mid-turn input | none | inject |
| Transport | JSON-RPC over stdio | WebSocket with fanout |

Inside the workspace runtime, each **run** maps to one ACP `session/prompt` call. The workspace protocol adds queuing, ownership, inject/interrupt, and multiplayer fanout around that single-player core.

## Repository Layout

- [agent-workspace.md](./agent-workspace.md) — the protocol spec (draft)
- [rfcs/](./rfcs/) — focused protocol design documents
- [acp/](./acp/) — Agent Client Protocol (git submodule)
- [reference-impl/](./reference-impl/) — reference implementation (Bun + Docker)
- [index.html](./index.html) — browser-rendered spec

## Quick Start

```bash
cd reference-impl && docker build -t agrp-wmlet .
bun run reference-impl/wsmanager.ts
bun run reference-impl/cli.ts create my-task general debug
bun run reference-impl/cli.ts connect my-task general
```

## Status

Draft, March 2026.

## License

MIT. See [LICENSE](./LICENSE).
