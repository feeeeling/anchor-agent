# ADR 0004: Pi session fork adapter with logical fallback

- Status: Accepted
- Date: 2026-09-02

## Context

Each Anchor task needs an isolated conversation branch derived from the active agent session node (see PRD). MCP does not standardize a native conversation-fork RPC, and Pi's fork surface is host-specific. Inventing undocumented Pi APIs inside Anchor would be fragile. At the same time, task results must never be merged back into the parent conversation in v0.x.

## Decision

1. Introduce a pure adapter module (`src/session-branch.ts`) with `ensureTaskBranch` and `SessionForkCapability`.
2. When the host reports native fork capability **and** supplies current session/node IDs plus an injectable `NativeSessionFork` function, fork from the **current** node after a successful claim and store real `sourceSessionId` / `sourceNodeId` / `branchMode: "native"` on the task.
3. When native fork is unavailable, keep the existing logical branch (`branchId` + task-local instruction/revision history). Optional `sourceSessionId` / `sourceNodeId` on `anchor.claim_task` may associate host context without inventing fake native IDs. `branchMode` remains `"logical"`.
4. Pi (or any host) plugs in by calling `configureSessionForkCapability(createPiSessionForkCapability({ ... }))` with its real fork RPC. Env hints (`ANCHOR_AGENT_SESSION_ID`, `ANCHOR_AGENT_NODE_ID`) alone never enable native fork.
5. **No parent writeback:** sampling and Agents submit candidates only through Anchor revision APIs (`anchor.submit_revision` / LocalBridge revisions). Completion summaries are not written to the parent conversation. `PARENT_WRITEBACK_POLICY` and `assertNoParentWriteback` document and guard this invariant.
6. Editor Accept UX and the Agent's inability to write files are unchanged.

## Consequences

- Automatic sampling and `anchor.claim_task` attach branch metadata through the same adapter.
- Non-Pi hosts remain on the logical branch with zero configuration.
- Hosts that later expose a stable fork RPC can inject it without changing TaskService or editor UX.
- Orphan native forks are avoided by claiming first, then forking only when work was leased.
