# Anchor Agent Product Requirements

- Version: 0.2
- Status: Active
- Initial platform: Visual Studio Code

## Product statement

Anchor Agent is an asynchronous local-edit extension connected to agents through MCP. A user selects text, enters an instruction, and continues editing. The agent may inspect the full file or workspace, but can only return candidate replacements for the anchored selection. The user reviews and explicitly applies a candidate.

## Goals

1. Keep an edit task attached to the selected logical text while surrounding content changes.
2. Never let a task overwrite editor content without explicit approval.
3. Permit multiple asynchronous local-edit tasks.
4. Give each task an isolated conversation branch derived automatically from the active session node.
5. Detect changes inside an anchor and resolve them according to a user-configured conflict policy.
6. Support any MCP client, with capability-based fallbacks for dispatch and conversation branching.

## Non-goals

- Autonomous project-wide edits or refactors.
- Generic shell automation.
- Git commits or automatic task acceptance.
- Automatic merge-back into the parent agent conversation.
- Multi-user anchor synchronization in the MVP.

## Primary flow

1. Select one contiguous range and invoke **Anchor Agent: Rewrite Selection**.
2. Enter a multiline instruction.
3. The extension snapshots the selection and document, creates a tracked anchor, and automatically derives a task branch from the active conversation.
4. The task is exposed to the connected MCP agent. Initial context contains the instruction and selection only.
5. The agent may call read-only MCP tools for the full snapshot, current file, or workspace search.
6. The agent streams progress and submits an immutable candidate revision.
7. The user reviews the diff, asks for another revision, rejects it, or accepts it.
8. Acceptance revalidates the current document version and anchor contents before one atomic editor edit.

## Functional requirements

### Task and anchor

- Capture URI, language, document version, selected text, full task-time snapshot, offsets, and context fingerprints.
- Track shifts caused by edits before the range.
- Mark the task modified when an edit overlaps the range.
- Mark a task orphaned when its document or logical text can no longer be located.
- Persist unfinished tasks across extension restarts.
- Present task status through decorations and an Explorer task view.

### Agent branch

- Automatically use the active agent session and head node.
- Create a native fork when supported.
- Otherwise preserve a logical task branch in the extension and replay only ancestor and task-local history.
- Keep sibling tasks isolated.
- Do not write completion summaries back to the parent conversation in v0.2.

### Context and permissions

- Initial request contains only the selection and instruction.
- The agent may read the full task snapshot or latest document through MCP.
- The agent may read and search other workspace files when settings allow it.
- Every read returns a document version or content hash where possible.
- The Anchor MCP server exposes no file-write, patch, delete, or shell tools.

### Candidate review

- Candidate revisions are immutable and linked to a parent revision.
- Review shows Base, current Local text, Remote candidate, summary, warnings, and source document version.
- Actions: accept, reject, cancel, copy, regenerate, continue instruction, and open diff.
- Applying a candidate is a single undoable editor operation.

### Conflict policy

Configurable values:

- `prompt`: any overlapping local edit requires explicit conflict handling.
- `autoMergeAndReview`: attempt a three-way merge, then require review.
- `regenerateOnChange`: turn current local text into a new base and request another revision.

No mode may silently force the remote candidate over local changes.

## Task states

`created`, `queued`, `running`, `waitingForUser`, `ready`, `conflicted`, `applying`, `applied`, `rejected`, `cancelled`, `failed`, `orphaned`, `archived`.

## MVP acceptance criteria

- Editing before a clean anchor shifts it and later acceptance replaces the intended text.
- Editing inside an anchor prevents direct acceptance under the default policy.
- MCP tools can retrieve a task, read its snapshot/current document, search the workspace, report progress, and submit a revision.
- No exposed MCP operation directly modifies workspace files.
- A submitted revision appears in the task view and can be accepted as one undoable edit.
- Two non-overlapping tasks remain independent.
- Extension or agent failure leaves document contents unchanged.
