# Architecture

## Components

```text
VS Code extension
  ├─ TaskService: task/revision lifecycle and persistence
  ├─ AnchorRange: offset transformation and overlap detection
  ├─ EditorController: multiline prompt, task panel, CodeLens, review, atomic apply
  ├─ LocalBridge: authenticated loopback HTTP API
  └─ TaskTreeProvider: task status UI
               │
               │ ~/.anchor-agent/connections/*.json
               ▼
stdio MCP bridge
  ├─ discovers the active extension endpoint
  ├─ maps MCP tools to LocalBridge requests
  ├─ leases pending task instructions
  ├─ requests client sampling when supported
  └─ never accesses workspace files directly
               │
               ▼
MCP-capable agent host
```

## Trust boundary

The extension is the authority for editor state. The MCP bridge has a short-lived bearer token and binds only to `127.0.0.1`. Agents receive read capabilities and a candidate-submission capability, not editor mutation capabilities.

Connection descriptors are user-readable only and stored per extension host under `~/.anchor-agent/connections/`. Focused windows update a compatibility pointer, while MCP processes select and cache one live connection by explicit ID, workspace hint, focus, or recency.

## Anchor model

A task stores a half-open offset range `[start, end)` against its latest observed document. Changes strictly before the range shift both offsets. Changes after the range do nothing. A change intersecting the range marks it modified and transforms its boundaries so the visual anchor follows the edited text.

Insertion exactly at the start is treated as outside/before the anchor; insertion exactly at the end is treated as outside/after it. This prevents typing at boundaries from unexpectedly expanding a task.

Acceptance compares current anchored text with `baseText`. A clean equality permits replacement. Any mismatch enters conflict handling, regardless of the stored state, which protects against missed editor events.

Under `regenerateOnChange`, the extension rebases the immutable task snapshot and adds a pending follow-up instruction. Under `autoMergeAndReview`, a token-preserving three-way merge combines non-overlapping Local and Remote edits derived from Base. The merged text becomes a new candidate against the rebased Local text and must still be reviewed; overlapping changes remain conflicted.

## Editor panels

The initial instruction uses a CSP-restricted Webview textarea. A temporary in-memory anchor follows document changes while this dialog is open, so edits before the selection do not invalidate task creation. The task-details Webview receives state through `postMessage`, renders task values with `textContent`, and shows Base, current Local, and Candidate text. Review actions are accept, reject, copy, Diff, retry, cancel, and multiline follow-up. Rejecting or cancelling a task is terminal: pending instruction leases are invalidated, and later Agent progress or revisions are refused.

The **Anchor Agent Tasks** tree view right-click menu wires the same review commands (`openDiff`, `copyCandidate`, `rejectTask`, `cancelTask`). Menu visibility uses TreeItem `contextValue` flags (`hasCandidate`, `cancellable`, `rejectable`) that mirror panel `canAccept` / `canReject` style gates.

## Stable and current reads

The task-time full document snapshot is immutable and supports reproducible agent reasoning. A current read reflects unsaved editor contents and returns the current document version. Candidate revisions record the version on which they were based.

Each task stores instruction turns separately from candidate revisions. A follow-up instruction references the active revision and remains `pending` until `anchor.submit_revision` links a response, providing the fallback logical branch for hosts without native conversation forks.

## MCP compatibility

MCP standardizes tools and resources, not universal agent invocation or conversation forks. Anchor Agent therefore distinguishes:

1. basic MCP tool compatibility through `anchor.claim_task`;
2. automatic dispatch through client sampling;
3. sampling with read-only tools;
4. native session branching supplied by a host adapter.

The MCP process polls for pending instructions only after the host advertises sampling. Claims have expiring leases so multiple clients cannot process the same turn. Failures back off and retry three times. A sampling host without tool support sees only the selected text; one with sampling tools may read the task snapshot/current file and search the workspace through the extension.

Missing native branching degrades to persisted task-local instruction/revision history without changing the editor UX. Sampling itself does not expose the active host conversation ancestry.
