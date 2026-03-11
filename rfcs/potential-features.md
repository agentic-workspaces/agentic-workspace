# Potential Future Features

- Status: non-normative
- Date: 2026-03-11

This document lists plausible next features for the workspace protocol. It is
not itself a specification. It is a prioritized design backlog intended to
help guide discussion about what should come next after the core API settles.

## Priority 1

### 1. Partial Turn Streaming

What:
Stream assistant output incrementally while a turn is still in progress.

Why:
This makes the protocol feel alive, reduces latency for users, and matches how
modern agent systems actually behave.

How:
Add explicit partial-output events, followed by a final completion event that
closes or supersedes the partial stream.

### 2. Multipart Turn Content

What:
Allow a single turn to contain multiple typed parts rather than only plain
text.

Why:
Real agent work includes text, images, audio, structured data, and references
to files or generated artifacts.

How:
Represent turn content as an ordered array of parts such as `text`, `image`,
`audio`, `json`, or `artifact_ref`.

### 3. Event Resume And Replay Cursors

What:
Let a client reconnect and continue from a known point in the event stream.

Why:
Without resumability, reconnects are fragile and clients either miss events or
have to replay too much state.

How:
Assign stable stream positions and allow reconnect with a cursor such as
`after=<event-id>` or `after=<sequence>`.

### 4. A Clear Turn State Machine

What:
Make turn lifecycle states explicit and consistent across prompts, injections,
tools, approvals, and interrupts.

Why:
Clients need a stable model for what is queued, active, partially delivered,
completed, interrupted, failed, or rejected.

How:
Define a small finite set of states and the legal transitions among them.

## Priority 2

### 5. Capability Discovery

What:
Allow clients to learn which optional features a server supports.

Why:
Different implementations will evolve at different speeds. Clients need a clean
way to know whether multipart content, partial streaming, approvals, or queue
mutation are available.

How:
Expose a small capability document or handshake payload listing supported
features and versions.

### 6. Tool Streaming And Structured Tool Results

What:
Treat tool execution as a richer protocol object rather than as a single opaque
blob of output.

Why:
Tool calls often produce progress, partial stdout, stderr, warnings, final
results, and machine-readable data.

How:
Emit tool lifecycle events and allow final results to include both human text
and structured payloads.

### 7. Idempotent Client Operations

What:
Give clients a way to safely retry submissions and mutations after network
failure.

Why:
Without idempotency, reconnects and retries can easily create duplicate turns
or repeated queue operations.

How:
Allow clients to attach an idempotency key to submissions, with the server
deduplicating repeated requests.

## Priority 3

### 8. History Access And Pagination

What:
Provide a first-class way to fetch older turns and not rely only on live event
streams.

Why:
Clients need transcript access for browsing, indexing, auditing, and late join.

How:
Add paginated history endpoints keyed by topic and ordered by durable event or
turn position.

### 9. Artifact Model

What:
Represent generated outputs as first-class protocol objects rather than as
inline text fragments.

Why:
Agents often produce files, reports, images, patches, notebooks, and other
durable outputs that deserve stable references.

How:
Define artifact identifiers plus metadata and allow turns to refer to them.

### 10. Branching And Regeneration

What:
Allow work to fork from a previous point instead of assuming a single linear
thread forever.

Why:
Collaborative agent work often needs retries, alternate approaches, and
side-by-side exploration.

How:
Introduce optional parent references so a new turn or topic branch can point to
the earlier state from which it diverged.
