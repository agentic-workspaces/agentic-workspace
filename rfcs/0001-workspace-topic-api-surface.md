# RFC 0001: Workspace Topic API Surface

- Status: draft
- Date: 2026-03-11

## 1. Scope

This document defines the public API that a client uses to work with
namespaced workspaces, topic-based agent collaboration, queue management,
managed MCP tools, and namespace lifecycle events.

It is intentionally opinionated. It describes the clean public contract that
multiple implementations should share. It does not preserve historical alias
routes, manager-only helper APIs, or internal runtime details.

In particular, this document does not standardize:

- `/acp/...` compatibility routes
- `/workspaces/...` compatibility routes
- internal Shelley runtime routes such as `/ws/...`
- the manager-local tool catalog used by the current web UI

## 2. Resource Model

The public hierarchy is:

```text
namespace -> workspace -> topic
```

The canonical REST base is:

```text
/apis/v1/namespaces/{namespace}/...
```

The canonical WebSocket endpoints live under the same hierarchy:

```text
wss://.../apis/v1/namespaces/{namespace}/...
```

There are two public streams:

- a topic event stream for live topic participation
- a namespace event stream for manager lifecycle notifications

## 3. Common Rules

- JSON timestamps use RFC3339 UTC.
- `eventId`, `promptId`, `injectId`, `toolCallId`, `grantId`, and `logId`
  are opaque strings.
- Clients MUST ignore unknown response fields.
- Topic WebSockets use a custom JSON message protocol. They are not JSON-RPC.
- `promptId` and `injectId` are server-assigned. Clients do not mint them.

## 4. Authentication And Actor Identity

This API assumes bearer JWTs.

HTTP requests carry the token in:

```text
Authorization: Bearer <jwt>
```

WebSocket clients carry the same token as:

```text
{ "type": "authenticate", "token": "<jwt>" }
```

The socket opens first. The client then sends `authenticate` as its first
message. The server replies with `authenticated`, and only then begins the
normal event stream.

For public contract purposes:

- `sub` identifies the caller and is required
- `name` is the preferred display name
- implementations MAY also fall back to `preferred_username` or `email`

The checked-in demo profile currently accepts unsecured JWTs (`alg: none`) so
the smoke tests and browser demo can run without key management. Real
deployments SHOULD validate signatures and standard JWT claims.

Servers derive actor identity from the JWT. Clients do not provide:

- ad hoc client-id headers
- participant cookies
- `submittedBy`
- `interruptedBy`
- approver identity strings as an access-control primitive

Those fields are server-emitted attribution only.

## 5. Workspaces

### 5.1 GET `/apis/v1/namespaces/{namespace}/workspaces`

Returns workspace summaries.

Example:

```json
[
  {
    "id": "payments-debug.acme@shelleymanager",
    "namespace": "acme",
    "name": "payments-debug",
    "status": "running",
    "createdAt": "2026-03-11T12:00:00Z"
  }
]
```

### 5.2 POST `/apis/v1/namespaces/{namespace}/workspaces`

Creates a workspace.

Example request:

```json
{
  "name": "payments-debug",
  "template": "acme-rpm-ig",
  "topics": [
    { "name": "general" },
    { "name": "debug-timeout" }
  ]
}
```

Rules:

- `name` is required.
- `template` is optional.
- `topics` is optional.
- topic names in the create request are pre-created before the workspace is
  returned.
- duplicate workspace names return `409 Conflict`.

Example response:

```json
{
  "id": "payments-debug.acme@shelleymanager",
  "namespace": "acme",
  "name": "payments-debug",
  "status": "running",
  "createdAt": "2026-03-11T12:00:00Z",
  "topics": [
    { "name": "general" },
    { "name": "debug-timeout" }
  ]
}
```

### 5.3 GET `/apis/v1/namespaces/{namespace}/workspaces/{workspace}`

Returns a workspace record.

Example:

```json
{
  "id": "payments-debug.acme@shelleymanager",
  "namespace": "acme",
  "name": "payments-debug",
  "status": "running",
  "createdAt": "2026-03-11T12:00:00Z",
  "topics": [
    {
      "name": "general",
      "events": "wss://relay.example.com/apis/v1/namespaces/acme/workspaces/payments-debug/topics/general/events"
    }
  ]
}
```

Implementations MAY include additional workspace metadata. The checked-in
Shelley manager currently includes local-runtime metadata under `runtime`, but
that is not part of the interoperable base contract.

### 5.4 DELETE `/apis/v1/namespaces/{namespace}/workspaces/{workspace}`

Deletes a workspace.

Example:

```json
{
  "name": "payments-debug",
  "status": "deleted"
}
```

### 5.5 Workspace Patch

This document does not standardize:

```text
PATCH /apis/v1/namespaces/{namespace}/workspaces/{workspace}
```

Specific deployments may expose patch semantics, but no cross-implementation
shape is committed here.

## 6. Topics

### 6.1 GET `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics`

Returns the topics in a workspace.

Example:

```json
[
  {
    "name": "debug-timeout",
    "busy": true,
    "createdAt": "2026-03-11T12:00:00Z",
    "events": "wss://relay.example.com/apis/v1/namespaces/acme/workspaces/payments-debug/topics/debug-timeout/events"
  }
]
```

### 6.2 POST `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics`

Creates a topic.

Example request:

```json
{ "name": "debug-timeout" }
```

Example response:

```json
{
  "name": "debug-timeout",
  "busy": false,
  "createdAt": "2026-03-11T12:00:00Z",
  "events": "wss://relay.example.com/apis/v1/namespaces/acme/workspaces/payments-debug/topics/debug-timeout/events"
}
```

Creating an already-active topic returns `409 Conflict`.

### 6.3 GET `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}`

Returns a single topic record in the same shape.

### 6.4 DELETE `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}`

Archives a topic.

Example:

```json
{
  "name": "debug-timeout",
  "status": "archived"
}
```

If a topic is later recreated with the same name, prior conversation history
may be restored.

## 7. Topic Event Stream

### 7.1 GET `wss://.../apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}/events`

This is the live participation channel for a single topic.

The client MUST send `authenticate` as its first message.

Example:

```json
{
  "type": "authenticate",
  "token": "<jwt>"
}
```

On successful authentication, the server sends `authenticated`, then
`connected`, replays transcript-derived state, and then sends a
`queue_snapshot`.

Example auth acknowledgement:

```json
{
  "type": "authenticated",
  "actor": {
    "id": "user_123",
    "displayName": "Alice Example"
  }
}
```

Example initial message:

```json
{
  "type": "connected",
  "topic": "debug-timeout",
  "protocolVersion": "workspace-topic-v1",
  "replay": true
}
```

### 7.2 Client Message: `prompt`

Path:

```text
wss://.../apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}/events
```

Example:

```json
{
  "type": "prompt",
  "data": "Please debug the timeout."
}
```

Rules:

- `data` is required.
- clients do not send `promptId`.
- `position: 0` MAY be used to place a prompt at the front of the queue.
- without `position`, prompts append after any active turn and queued work.

### 7.3 Server Message: `prompt_status`

`prompt_status` is the authoritative prompt lifecycle signal.

Example:

```json
{
  "type": "prompt_status",
  "promptId": "p_123",
  "status": "queued",
  "data": "Please debug the timeout.",
  "position": 1,
  "submittedBy": {
    "id": "user_123",
    "displayName": "Alice Example"
  }
}
```

Defined prompt status values:

- `accepted`
- `queued`
- `started`
- `completed`
- `cancelled`
- `failed`

Clients learn `promptId` from `accepted` or from a queue snapshot, and use it
later for queue mutation APIs.

### 7.4 Transcript And Tool Messages

The topic stream also carries transcript and tool execution events.

Examples:

```json
{ "type": "user", "data": "Please debug the timeout." }
```

```json
{ "type": "text", "data": "I found the issue..." }
```

```json
{
  "type": "tool_call",
  "toolCallId": "call_123",
  "title": "workspace_github",
  "tool": "workspace_github",
  "status": "pending"
}
```

```json
{
  "type": "tool_update",
  "toolCallId": "call_123",
  "title": "workspace_github",
  "tool": "workspace_github",
  "status": "completed",
  "data": "Pull request created"
}
```

### 7.5 Approval Messages

Path:

```text
wss://.../apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}/events
```

Server request:

```json
{
  "type": "approval_request",
  "toolCallId": "call_123",
  "tool": "github",
  "action": "repo.push",
  "data": "{\"repo\":\"acme/demo\",\"branch\":\"fix-timeout\"}",
  "approvers": ["alice@example.com"]
}
```

Client response:

```json
{
  "type": "approval_response",
  "toolCallId": "call_123",
  "approved": true
}
```

Rules:

- approval is keyed by `toolCallId`
- there is no standalone approval resource
- the approving actor is derived from the JWT-backed connection context

### 7.6 Inject Messages

Path:

```text
wss://.../apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}/events
```

Client request:

```json
{
  "type": "inject",
  "data": "Also check the retry path."
}
```

Server status:

```json
{
  "type": "inject_status",
  "injectId": "inj_123",
  "promptId": "p_123",
  "status": "accepted"
}
```

Defined inject status values:

- `accepted`
- `delivered`
- `rejected`

Rules:

- clients do not send `injectId`
- inject is valid only while a turn is active

### 7.7 Interrupt Messages

Path:

```text
wss://.../apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}/events
```

Client request:

```json
{
  "type": "interrupt",
  "reason": "Wrong approach."
}
```

Server completion event:

```json
{
  "type": "done",
  "promptId": "p_123",
  "status": "interrupted",
  "reason": "Wrong approach.",
  "interruptedBy": {
    "id": "user_123",
    "displayName": "Alice Example"
  }
}
```

### 7.8 Queue Realtime Messages

Snapshot:

```json
{
  "type": "queue_snapshot",
  "activePromptId": "p_120",
  "entries": []
}
```

Update:

```json
{ "type": "queue_entry_updated", "promptId": "p_121" }
```

Move:

```json
{ "type": "queue_entry_moved", "promptId": "p_121", "direction": "top" }
```

Removal:

```json
{ "type": "queue_entry_removed", "promptId": "p_121" }
```

Clear acknowledgement:

```json
{ "type": "queue_cleared", "removed": ["p_121", "p_122"] }
```

### 7.9 Error And Status Text

Error:

```json
{ "type": "error", "data": "no active turn" }
```

Status text:

```json
{ "type": "system", "data": "thinking..." }
```

`system` is display-oriented status text. It is not a machine-state resource.

## 8. Queue REST API

### 8.1 GET `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}/queue`

Returns the queue snapshot.

Example:

```json
{
  "activePromptId": "p_120",
  "entries": [
    {
      "promptId": "p_121",
      "status": "queued",
      "text": "Search HL7 Jira for precedent.",
      "createdAt": "2026-03-11T12:00:01Z",
      "position": 1,
      "submittedBy": {
        "id": "user_123",
        "displayName": "Alice Example"
      }
    }
  ]
}
```

### 8.2 PATCH `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}/queue/{promptId}`

Updates a queued prompt owned by the caller.

Example request:

```json
{ "data": "Search HL7 Jira for precedent and summarize the result." }
```

Success returns the updated queue snapshot.

### 8.3 DELETE `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}/queue/{promptId}`

Deletes a queued prompt owned by the caller.

Success returns `204 No Content`.

### 8.4 POST `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}/queue/{promptId}/move`

Moves a queued prompt owned by the caller.

Example request:

```json
{ "direction": "top" }
```

Defined move directions:

- `up`
- `down`
- `top`
- `bottom`

Success returns the updated queue snapshot.

### 8.5 POST `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}/queue:clear-mine`

Clears queued prompts owned by the caller.

Example response:

```json
{
  "removed": ["p_121", "p_122"]
}
```

Queue mutation rules:

- only the submitting participant may update, move, or delete a queued prompt
- `404 Not Found` means the topic or prompt does not exist
- `403 Forbidden` means the caller does not own that queued prompt
- `409 Conflict` means the prompt is no longer cancellable or movable

## 9. File API

The Shelley-backed profile currently exposes workspace file operations at:

```text
/apis/v1/namespaces/{namespace}/workspaces/{workspace}/files/{path...}
```

This API is path-based and works today, but it is likely not the long-term
shape we would choose for a more polished multi-implementation standard.

### 9.1 GET `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/files/{path...}`

If `{path...}` resolves to a file, the response body is the raw file content
with a normal content type.

If `{path...}` resolves to a directory, the response is a JSON listing:

```json
{
  "path": "/docs",
  "entries": [
    {
      "name": "note.txt",
      "path": "docs/note.txt",
      "isDir": false,
      "size": 15,
      "modifiedAt": "2026-03-11T12:00:00Z"
    }
  ]
}
```

### 9.2 PUT `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/files/{path...}`

Writes the raw request body to the addressed workspace-relative path.

Example response:

```json
{
  "path": "docs/note.txt",
  "size": 15,
  "status": "ok"
}
```

### 9.3 DELETE `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/files/{path...}`

Deletes the addressed file or empty directory.

Example response:

```json
{
  "path": "docs/note.txt",
  "status": "deleted"
}
```

Traversal outside the workspace root returns `403 Forbidden`.

## 10. Inject And Interrupt REST API

### 10.1 POST `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}/inject`

Injects a user message into the active turn.

Example request:

```json
{ "data": "Also check the retry path." }
```

Example response:

```json
{
  "injectId": "inj_123",
  "status": "accepted"
}
```

If no turn is active, the endpoint returns `409 Conflict` with an
`inject_status`-style rejection body.

### 10.2 POST `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/topics/{topic}/interrupt`

Interrupts the active turn.

Example request:

```json
{ "reason": "Wrong approach." }
```

Success returns the corresponding `done` event body for the interrupted turn.

## 11. Tools

### 11.1 GET `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/tools`

Returns the tools enabled for the workspace.

Example:

```json
[
  {
    "kind": "local",
    "name": "fhir-validator",
    "description": "Validate FHIR artifacts"
  },
  {
    "kind": "mcp",
    "name": "github",
    "description": "GitHub repository operations"
  }
]
```

This is the public tool inventory surface. It is what slash-tools style UI
should use.

This document does not define how local runtime tools are selected or managed.
It commits only to their appearance in the inventory when they are enabled.

### 11.2 POST `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/tools`

Registers a managed MCP tool.

Example request:

```json
{
  "name": "github",
  "description": "GitHub repository operations",
  "provider": "alice@example.com",
  "protocol": "mcp",
  "transport": {
    "type": "streamable_http",
    "url": "https://github-mcp.example.com",
    "headers": {
      "Authorization": "Bearer secret"
    }
  }
}
```

Rules:

- `name` is required
- `protocol` defaults to `mcp`
- `transport` is required
- for MCP, clients ordinarily omit a `tools` array
- when omitted, the server may discover callable actions through MCP discovery

### 11.3 GET `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/tools/{tool}`

Returns a managed tool resource.

Example:

```json
{
  "kind": "mcp",
  "name": "github",
  "description": "GitHub repository operations",
  "provider": "alice@example.com",
  "protocol": "mcp",
  "transport": {
    "type": "streamable_http",
    "url": "https://github-mcp.example.com",
    "headers": {
      "Authorization": { "redacted": true }
    }
  },
  "grants": [],
  "log": []
}
```

Managed tool detail is where grants and audit history live. Local tools
participate only in the inventory endpoint.

### 11.4 DELETE `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/tools/{tool}`

Disconnects a managed tool from the workspace.

### 11.5 POST `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/tools/{tool}/grants`

Adds a grant for a managed tool.

Example request:

```json
{
  "subject": "agent:*",
  "tools": ["repo.read"],
  "access": "approval_required",
  "approvers": ["alice@example.com"],
  "scope": { "repo": "acme/demo" }
}
```

Defined access values:

- `allowed`
- `approval_required`
- `denied`

Example grant object:

```json
{
  "grantId": "g_123",
  "subject": "agent:*",
  "tools": ["repo.read"],
  "access": "approval_required",
  "approvers": ["alice@example.com"],
  "scope": { "repo": "acme/demo" },
  "createdAt": "2026-03-11T12:00:00Z"
}
```

### 11.6 DELETE `/apis/v1/namespaces/{namespace}/workspaces/{workspace}/tools/{tool}/grants/{grantId}`

Removes a grant.

Approval outcomes are visible both on the topic event stream and in the managed
tool log.

## 12. Namespace Event Stream

### 12.1 GET `wss://.../apis/v1/namespaces/{namespace}/events`

This is the namespace-scoped manager lifecycle stream.

Example initial message:

```json
{
  "type": "authenticated",
  "actor": {
    "id": "user_123",
    "displayName": "Alice Example"
  }
}
```

```json
{
  "type": "connected",
  "protocolVersion": "workspace-manager-v1",
  "namespace": "acme",
  "replay": true
}
```

After `authenticated` and `connected`, the server replays current workspaces as
`workspace_created` events.

### 12.2 Event Types

Workspace created:

```json
{
  "type": "workspace_created",
  "workspace": {
    "name": "payments-debug",
    "status": "running",
    "createdAt": "2026-03-11T12:00:00Z",
    "topics": [
      { "name": "general" },
      { "name": "debug-timeout" }
    ]
  }
}
```

Workspace deleted:

```json
{
  "type": "workspace_deleted",
  "workspace": {
    "name": "payments-debug"
  }
}
```

Topic created:

```json
{
  "type": "topic_created",
  "workspace": "payments-debug",
  "topic": {
    "name": "debug-timeout"
  }
}
```

Topic deleted:

```json
{
  "type": "topic_deleted",
  "workspace": "payments-debug",
  "topic": {
    "name": "debug-timeout"
  }
}
```

This stream is read-only. The protocol does not define event-id resume.

## 13. Explicitly Not Part Of The Contract

This document does not commit to:

- `/acp/...` route aliases
- `/workspaces/...` route aliases
- internal runtime `/ws/...` routes
- client-supplied prompt IDs or inject IDs
- client-supplied participant IDs in custom headers or cookies
- JSON-RPC over the topic WebSocket
- a standalone approval resource
- the manager-local `/apis/v1/local-tools` catalog
- local-runtime tool selection or provisioning APIs
- internal manager-to-runtime hosting details
- suspend, resume, clone, commit, snapshot, or rollback APIs
- operational endpoints such as `/health`
