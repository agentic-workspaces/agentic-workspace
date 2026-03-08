# Repository Guidelines

## Project Structure & Module Organization
This repository is a documentation-first RFC project. Keep the protocol source in `agrp-rfc.md`, the browser-rendered presentation in `index.html`, and the high-level overview in `README.md`. Root-only assets are intentional: `.nojekyll` supports GitHub Pages, and `LICENSE` covers published content.

## Build, Test, and Development Commands
There is no build pipeline or package manifest in this repo. Use a lightweight local server so `index.html` can fetch `agrp-rfc.md` correctly:

- `cd agrp-rfc && python3 -m http.server 8000` serves the RFC site locally.
- Open `http://localhost:8000` and confirm the page renders the markdown source.
- `git diff -- agrp-rfc.md index.html README.md` is the fastest review pass before committing.

Do not open `index.html` via `file://`; the page uses `fetch("./agrp-rfc.md")` and will fail without HTTP.

## Coding Style & Naming Conventions
Use concise RFC prose, sentence-case headings, and fenced code blocks for protocol examples. Follow the existing two-space indentation in `index.html`. Keep filenames descriptive and stable; this repo currently uses root-level names such as `agrp-rfc.md` and `index.html` rather than nested app directories.

## Testing Guidelines
No automated test suite is configured today. Validate changes manually by loading the local site, checking that the status line reports `Rendered from agrp-rfc.md`, and confirming Mermaid diagrams and feedback links still work. For content-only edits, review the rendered HTML and the raw markdown.

## Commit & Pull Request Guidelines
Match the current Git history: short, imperative commit subjects with a clear scope, for example `Add external standards references to AGRP RFC` or `Fix Pages diagram mapping for RFC intro`. Keep pull requests focused on one logical change, summarize the affected sections, and include screenshots when `index.html` styling or rendering changes. Link the related GitHub issue or discussion when the change responds to public feedback.
