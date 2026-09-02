# Anchor MCP contract

The stdio server uses the `anchor.*` namespace. All tools proxy through the active editor extension.

## `anchor.list_connections`

No input. Lists live VS Code extension connections without exposing bearer tokens. The selected entry is marked with `selected: true`.

## `anchor.use_connection`

Input: `{ connectionId: string }`

Pins subsequent tools and automatic dispatch to one VS Code window. Hosts may instead set `ANCHOR_AGENT_WORKSPACE` to a workspace path or URI before starting the stdio server.

## `anchor.list_tasks`

No input. Returns tasks exposed by the active VS Code window so an agent or adapter can discover newly created work.

## `anchor.claim_task`

Input: `{ taskId?, sourceSessionId?, sourceNodeId? }`

Claims the oldest pending instruction, or one from `taskId`, with an expiring lease. Use this from the current Agent conversation when the host does not support automatic MCP Sampling. Optional source IDs associate the logical Anchor branch with native host context. When a host adapter has configured native session fork, automatic dispatch / claim may bind `branchMode: "native"` to a forked session/node; otherwise `branchMode: "logical"` keeps task-local history only. Task results are never written back to the parent conversation.

## `anchor.get_task`

Input: `{ taskId: string }`

Returns selection, language, base document version, task state, revision metadata, and the task's instruction history. Instructions with `status: "pending"` are the turns awaiting an Agent response. It does not include the full document snapshot.

## `anchor.read_document`

Input:

```json
{
  "taskId": "task-id",
  "uri": "file:///workspace/main.tex",
  "mode": "snapshot"
}
```

Modes:

- `snapshot`: immutable task-time snapshot; available for the task document.
- `current`: current unsaved editor content when open, otherwise workspace content.

Workspace settings govern reads outside the task document.

## `anchor.search_workspace`

Input: `{ taskId, query, include?, maxResults? }`

Returns bounded read-only text matches. Workspace settings may disable this tool.

## `anchor.report_progress`

Input: `{ taskId, stage, message, percentage? }`

Updates the anchor and task view. It does not create a conversation revision.

## `anchor.submit_revision`

Input:

```json
{
  "taskId": "task-id",
  "parentRevisionId": "optional-parent",
  "instructionId": "pending-instruction-being-answered",
  "replacement": "candidate text",
  "summary": "optional explanation",
  "warnings": [],
  "basedOnDocumentVersion": 42
}
```

Creates an immutable candidate and completes the referenced pending instruction. If `instructionId` is omitted, the most recent pending instruction is used. It never edits the document.

## `anchor.request_clarification`

Input: `{ taskId, question, options? }`

Marks the task as `waitingForUser` and stores the question (and optional choices) for the editor task-details panel. Instruction claiming is paused while the task waits.

**User reply channel (instruction continuation):** the user answers in the task details UI. Anchor queues that answer as a pending instruction turn—reusing the open dispatching/pending turn when present—so the Agent receives it through `anchor.claim_task` or automatic sampling. The answer is not returned as a deferred `request_clarification` tool result.

`anchor.get_task` exposes `clarification` and `taskState: "waitingForUser"` until the user replies.

## Automatic sampling

After MCP initialization, the stdio server checks client capabilities. A client with `sampling/createMessage` receives pending instructions automatically. When `sampling.tools` is also available, the model may call read-document and search-workspace during the sampling loop. Invalid output or rejected sampling is retried with a lease-backed exponential delay, up to three attempts.

Sampling without tool support receives only the selected Base text and task-local revision history. Basic MCP clients remain usable through `anchor.claim_task`.

Automatic sampling attaches branch metadata through the session-fork adapter: native fork from the current node when the host injected `NativeSessionFork`, otherwise the logical `branchId` history. Sampling uses `includeContext: "none"` and never writes completion summaries into the parent conversation.

## Explicit exclusions

The server does not expose write-file, apply-patch, delete, shell, or Git mutation tools.

## Connection discovery

Each VS Code window registers under `~/.anchor-agent/connections/`. Resolution prefers an explicit descriptor, explicit connection selection, workspace hint, focused-window hint, then the newest live connection. The chosen descriptor is cached so a focus change cannot reroute an in-flight task. `connection.json` remains as a compatibility pointer.
