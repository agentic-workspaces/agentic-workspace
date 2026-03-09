# Agentic Workspace

Protocol and reference implementation for agentic workspaces — environments where humans and agents collaborate on shared resources.

## Repository Layout

- [agent-workspace.md](./agent-workspace.md) — the protocol spec (draft)
- [reference-impl/](./reference-impl/) — reference implementation (bun + docker)
- [index.html](./index.html) — browser-rendered spec
- [LICENSE](./LICENSE) — MIT license

## Reference Implementation

```bash
# Build the workspace container (bun + claude-code + wmlet)
cd reference-impl && docker build -t agrp-wmlet .

# Run the workspace manager
bun run reference-impl/wsmanager.ts

# Create a workspace
curl -X POST localhost:31337/workspaces -d '{"name":"my-task"}'
```

## Status

Draft, March 2026.

## License

MIT. See [LICENSE](./LICENSE).
