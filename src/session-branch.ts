/**
 * Session branch adapter: native host fork when available, otherwise Anchor's
 * logical task branch (branchId + instruction/revision history).
 *
 * Parent writeback policy (enforced by design):
 * - Task results and completion summaries are NEVER written back to the parent
 *   host conversation.
 * - Sampling and Agents submit candidates only through Anchor revision APIs
 *   (`anchor.submit_revision` / LocalBridge `/v1/tasks/:id/revisions`).
 * - Hosts must not treat a forked session as a channel for merging results into
 *   the parent thread in v0.x.
 */

import { randomUUID } from "node:crypto";

export type SessionBranchMode = "native" | "logical";

/**
 * Injectable native fork. A Pi (or other) host plugs in its real session-fork
 * RPC here. Anchor does not invent undocumented Pi APIs; without this function,
 * branching stays logical.
 */
export type NativeSessionFork = (input: {
  currentSessionId: string;
  currentNodeId: string;
  reason?: string;
}) => Promise<{
  sessionId: string;
  nodeId: string;
}>;

export interface SessionForkCapability {
  /** True only when the host can actually fork a conversation session. */
  hasNativeFork: boolean;
  currentSessionId?: string;
  currentNodeId?: string;
  /** Required for native mode; ignored when hasNativeFork is false. */
  forkFromCurrentNode?: NativeSessionFork;
}

export interface ExistingTaskBranch {
  branchId: string;
  sourceSessionId?: string;
  sourceNodeId?: string;
  branchMode?: SessionBranchMode;
}

export interface SessionBranchBinding {
  mode: SessionBranchMode;
  branchId: string;
  sourceSessionId?: string;
  sourceNodeId?: string;
}

export interface EnsureTaskBranchInput {
  hasNativeFork: boolean;
  forkFromCurrentNode?: NativeSessionFork;
  currentSessionId?: string;
  currentNodeId?: string;
  existing: ExistingTaskBranch;
  /**
   * Optional IDs from `anchor.claim_task` that associate a logical branch with
   * host context without performing a native fork.
   */
  requested?: {
    sourceSessionId?: string;
    sourceNodeId?: string;
  };
}

/** Documented invariant: never write task outcomes into the parent conversation. */
export const PARENT_WRITEBACK_POLICY = {
  writeCompletionSummaryToParent: false,
  writeCandidateToParent: false,
  candidateSubmissionChannel: "anchor.submit_revision",
} as const;

/**
 * Decide native fork vs logical branch and return binding metadata for the task.
 *
 * Native: forks from the **current** session node when capability reports support
 * and current IDs are present. Stores real forked IDs only.
 *
 * Logical: keeps `existing.branchId` and optional requested source IDs. Does
 * **not** invent fake native session/node IDs.
 */
export async function ensureTaskBranch(
  input: EnsureTaskBranchInput,
): Promise<SessionBranchBinding> {
  const { existing, requested } = input;
  const alreadyBoundNative =
    existing.branchMode === "native" &&
    Boolean(existing.sourceSessionId) &&
    Boolean(existing.sourceNodeId);

  if (alreadyBoundNative) {
    return {
      mode: "native",
      branchId: existing.branchId,
      ...(existing.sourceSessionId
        ? { sourceSessionId: existing.sourceSessionId }
        : {}),
      ...(existing.sourceNodeId ? { sourceNodeId: existing.sourceNodeId } : {}),
    };
  }

  const canNativeFork =
    input.hasNativeFork &&
    typeof input.forkFromCurrentNode === "function" &&
    Boolean(input.currentSessionId) &&
    Boolean(input.currentNodeId);

  if (canNativeFork && input.forkFromCurrentNode && input.currentSessionId && input.currentNodeId) {
    const forked = await input.forkFromCurrentNode({
      currentSessionId: input.currentSessionId,
      currentNodeId: input.currentNodeId,
      reason: "anchor-agent-task-branch",
    });
    if (!forked.sessionId || !forked.nodeId) {
      // Host returned incomplete IDs — fall back to logical; do not invent IDs.
      return logicalBinding(existing, requested);
    }
    return {
      mode: "native",
      branchId: existing.branchId,
      sourceSessionId: forked.sessionId,
      sourceNodeId: forked.nodeId,
    };
  }

  return logicalBinding(existing, requested);
}

function logicalBinding(
  existing: ExistingTaskBranch,
  requested?: EnsureTaskBranchInput["requested"],
): SessionBranchBinding {
  const sourceSessionId =
    requested?.sourceSessionId ?? existing.sourceSessionId;
  const sourceNodeId = requested?.sourceNodeId ?? existing.sourceNodeId;
  return {
    mode: "logical",
    branchId: existing.branchId,
    ...(sourceSessionId ? { sourceSessionId } : {}),
    ...(sourceNodeId ? { sourceNodeId } : {}),
  };
}

/**
 * Build a capability object for Pi or other hosts. Native fork is enabled only
 * when both a fork function and current session/node IDs are supplied.
 *
 * Plug-in example (host-side):
 * ```ts
 * configureSessionForkCapability(
 *   createPiSessionForkCapability({
 *     currentSessionId,
 *     currentNodeId,
 *     nativeFork: (input) => piClient.forkSession(input),
 *   }),
 * );
 * ```
 */
export function createPiSessionForkCapability(options: {
  currentSessionId?: string;
  currentNodeId?: string;
  nativeFork?: NativeSessionFork;
}): SessionForkCapability {
  const hasNativeFork = Boolean(
    options.nativeFork && options.currentSessionId && options.currentNodeId,
  );
  return {
    hasNativeFork,
    ...(options.currentSessionId
      ? { currentSessionId: options.currentSessionId }
      : {}),
    ...(options.currentNodeId ? { currentNodeId: options.currentNodeId } : {}),
    ...(options.nativeFork ? { forkFromCurrentNode: options.nativeFork } : {}),
  };
}

/** Default for non-Pi / unknown hosts: logical branch only. */
export function createLogicalOnlyCapability(): SessionForkCapability {
  return { hasNativeFork: false };
}

/**
 * Resolve capability from an injectable override or process env hints.
 * Env alone never enables native fork (no fake RPC); it only supplies current
 * IDs when a host also injects `nativeFork` via `configureSessionForkCapability`.
 */
export function resolveSessionForkCapability(
  override?: Partial<SessionForkCapability> & {
    nativeFork?: NativeSessionFork;
  },
): SessionForkCapability {
  const currentSessionId =
    override?.currentSessionId ??
    (process.env.ANCHOR_AGENT_SESSION_ID?.trim() || undefined);
  const currentNodeId =
    override?.currentNodeId ??
    (process.env.ANCHOR_AGENT_NODE_ID?.trim() || undefined);
  const nativeFork =
    override?.forkFromCurrentNode ?? override?.nativeFork ?? undefined;
  const hasNativeFork =
    override?.hasNativeFork === true
      ? Boolean(nativeFork && currentSessionId && currentNodeId)
      : Boolean(nativeFork && currentSessionId && currentNodeId);

  return {
    hasNativeFork,
    ...(currentSessionId ? { currentSessionId } : {}),
    ...(currentNodeId ? { currentNodeId } : {}),
    ...(nativeFork ? { forkFromCurrentNode: nativeFork } : {}),
  };
}

let configuredCapability: SessionForkCapability = createLogicalOnlyCapability();

/** Host adapters call this once at MCP process startup to plug in native fork. */
export function configureSessionForkCapability(
  capability: SessionForkCapability,
): void {
  configuredCapability = capability;
}

export function getConfiguredSessionForkCapability(): SessionForkCapability {
  return configuredCapability;
}

/** Allocate a new logical branch id (used when creating tasks). */
export function newLogicalBranchId(): string {
  return `branch-${randomUUID()}`;
}

/**
 * Guard used by tests (and callable by adapters) to reject parent writeback.
 * Sampling/dispatch code paths must only record candidate submission actions.
 */
export function assertNoParentWriteback(
  actions: ReadonlyArray<{ type: string }>,
): void {
  for (const action of actions) {
    if (
      action.type === "parent_writeback" ||
      action.type === "write_parent_summary" ||
      action.type === "merge_into_parent"
    ) {
      throw new Error(
        "Parent conversation writeback is forbidden; submit candidates via Anchor revision APIs only",
      );
    }
  }
  if (PARENT_WRITEBACK_POLICY.writeCompletionSummaryToParent) {
    throw new Error("PARENT_WRITEBACK_POLICY unexpectedly enables parent writeback");
  }
}

/**
 * Build claim-body branch fields from a binding. Omits undefined IDs so callers
 * never invent placeholders.
 */
export function claimFieldsFromBinding(binding: SessionBranchBinding): {
  sourceSessionId?: string;
  sourceNodeId?: string;
  branchMode: SessionBranchMode;
} {
  return {
    branchMode: binding.mode,
    ...(binding.sourceSessionId
      ? { sourceSessionId: binding.sourceSessionId }
      : {}),
    ...(binding.sourceNodeId ? { sourceNodeId: binding.sourceNodeId } : {}),
  };
}
