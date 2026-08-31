# Anchor MCP contract

The stdio server uses the `anchor.*` namespace. All tools proxy through the active editor extension.

## `anchor.list_tasks`

No input. Returns tasks exposed by the active VS Code window so an agent or adapter can discover newly created work.

## `anchor.claim_task`

Input: `{ taskId?, sourceSessionId?, sourceNodeId? }`

Claims the oldest pending instruction, or one from `taskId`, with an expiring lease. Use this from the current Agent conversation when the host does not support automatic MCP Sampling. Optional source IDs associate the logical Anchor branch with native host context.

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

Marks the task as waiting for user input. Interactive response transport is planned after the initial bridge.

## Automatic sampling

After MCP initialization, the stdio server checks client capabilities. A client with `sampling/createMessage` receives pending instructions automatically. When `sampling.tools` is also available, the model may call read-document and search-workspace during the sampling loop. Invalid output or rejected sampling is retried with a lease-backed exponential delay, up to three attempts.

Sampling without tool support receives only the selected Base text and task-local revision history. Basic MCP clients remain usable through `anchor.claim_task`.

## Explicit exclusions

The server does not expose write-file, apply-patch, delete, shell, or Git mutation tools.
