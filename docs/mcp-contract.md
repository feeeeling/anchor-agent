# Anchor MCP contract

The stdio server uses the `anchor.*` namespace. All tools proxy through the active editor extension.

## `anchor.list_tasks`

No input. Returns tasks exposed by the active VS Code window so an agent or adapter can discover newly created work.

## `anchor.get_task`

Input: `{ taskId: string }`

Returns instruction, selection, language, base document version, task state, and revision metadata. It does not include the full document snapshot.

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
  "replacement": "candidate text",
  "summary": "optional explanation",
  "warnings": [],
  "basedOnDocumentVersion": 42
}
```

Creates an immutable candidate. It never edits the document.

## `anchor.request_clarification`

Input: `{ taskId, question, options? }`

Marks the task as waiting for user input. Interactive response transport is planned after the initial bridge.

## Explicit exclusions

The server does not expose write-file, apply-patch, delete, shell, or Git mutation tools.
