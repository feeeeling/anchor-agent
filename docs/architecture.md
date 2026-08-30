# Architecture

## Components

```text
VS Code extension
  ├─ TaskService: task/revision lifecycle and persistence
  ├─ AnchorRange: offset transformation and overlap detection
  ├─ EditorController: commands, CodeLens, decorations, review, atomic apply
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

Under `regenerateOnChange`, the extension rebases the immutable task snapshot and adds a pending follow-up instruction. Under `autoMergeAndReview`, a token-preserving three-way merge combines non-overlapping Local and Remote edits derived from Base. The merged text becomes a new candidate against the rebased Local text and must still be reviewed; overlapping changes remain conflicted.

## Stable and current reads

The task-time full document snapshot is immutable and supports reproducible agent reasoning. A current read reflects unsaved editor contents and returns the current document version. Candidate revisions record the version on which they were based.

Each task stores instruction turns separately from candidate revisions. A follow-up instruction references the active revision and remains `pending` until `anchor.submit_revision` links a response, providing the fallback logical branch for hosts without native conversation forks.

## MCP compatibility

MCP standardizes tools and resources, not universal agent invocation or conversation forks. Anchor Agent therefore distinguishes:

1. basic MCP tool compatibility;
2. automatic dispatch through host sampling or an adapter;
3. native session branching.

Missing native branching degrades to task-local history replay without changing the editor UX.
