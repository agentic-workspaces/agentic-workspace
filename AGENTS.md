# Repository Guidelines

## Project Structure
This repository contains the Agentic Workspace protocol spec and a reference implementation.

- `agent-workspace.md` — protocol spec (draft)
- `index.html` — browser-rendered spec page
- `reference-impl/` — reference implementation (bun + docker)
  - `wsmanager.ts` — workspace manager, REST API, launches docker containers
  - `wmlet.ts` — runs inside container, launches claude-code, exposes ACP
  - `Dockerfile` — workspace container image (bun + claude-code + wmlet)

## Development
- `bun --hot reference-impl/dev-server.ts` to preview the spec page locally
- `cd reference-impl && bun run dev:manager` to run workspace manager
- `cd reference-impl && docker build -t agrp-wmlet .` to build workspace image

## Coding Style
Use concise RFC prose for the spec. Reference implementation uses Bun + TypeScript.

## Commit Guidelines
Short, imperative commit subjects. Keep pull requests focused on one logical change.
