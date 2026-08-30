# Architecture

## Components

```text
VS Code extension
  ├─ TaskService: task/revision lifecycle and persistence
  ├─ AnchorTracker: offset transformation and overlap detection
  ├─ EditorController: commands, decorations, review, atomic apply
  ├─ LocalBridge: authenticated loopback HTTP API
  └─ TaskTreeProvider: task status UI
               │
               │ ~/.anchor-agent/connection.json
               ▼
stdio MCP bridge
  ├─ discovers the active extension endpoint
  ├─ maps MCP tools to LocalBridge requests
  └─ never accesses workspace files directly
               │
               ▼
MCP-capable agent host
```

## Trust boundary

The extension is the authority for editor state. The MCP bridge has a short-lived bearer token and binds only to `127.0.0.1`. Agents receive read capabilities and a candidate-submission capability, not editor mutation capabilities.

The connection descriptor is user-readable only. A later multi-window version will replace the single active descriptor with a workspace-aware registry.

## Anchor model

A task stores a half-open offset range `[start, end)` against its latest observed document. Changes strictly before the range shift both offsets. Changes after the range do nothing. A change intersecting the range marks it modified and transforms its boundaries so the visual anchor follows the edited text.

Insertion exactly at the start is treated as outside/before the anchor; insertion exactly at the end is treated as outside/after it. This prevents typing at boundaries from unexpectedly expanding a task.

Acceptance compares current anchored text with `baseText`. A clean equality permits replacement. Any mismatch enters conflict handling, regardless of the stored state, which protects against missed editor events.

## Stable and current reads

The task-time full document snapshot is immutable and supports reproducible agent reasoning. A current read reflects unsaved editor contents and returns the current document version. Candidate revisions record the version on which they were based.

## MCP compatibility

MCP standardizes tools and resources, not universal agent invocation or conversation forks. Anchor Agent therefore distinguishes:

1. basic MCP tool compatibility;
2. automatic dispatch through host sampling or an adapter;
3. native session branching.

Missing native branching degrades to task-local history replay without changing the editor UX.
