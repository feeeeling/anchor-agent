import type { EditTask, TaskInstruction } from "./types.js";

/** Delay before surfacing stall hints in the task details panel (within 10–15s). */
export const STALL_HINT_DELAY_MS = 12_000;

const WAITING_INSTRUCTION_STATUSES = new Set<TaskInstruction["status"]>([
  "pending",
  "dispatching",
]);

/** Combined checklist when MCP connection / sampling state is not knowable. */
export const STALL_HINT_CHECKLIST: readonly string[] = [
  "MCP may not be connected — confirm Pi (or your host) shows the `anchor-agent` server.",
  "Run `/reload` in Pi (or reload the MCP host) so it can observe newly created tasks.",
  "Approve Sampling when prompted — automatic dispatch needs Sampling authorization.",
  "Or claim manually with `anchor.claim_task`, then submit a revision.",
];

/**
 * Latest instruction that is still waiting for Agent work
 * (`pending` / `dispatching`).
 */
export function getWaitingInstruction(
  task: EditTask,
): TaskInstruction | undefined {
  for (let index = task.instructions.length - 1; index >= 0; index -= 1) {
    const instruction = task.instructions[index];
    if (
      instruction &&
      WAITING_INSTRUCTION_STATUSES.has(instruction.status)
    ) {
      return instruction;
    }
  }
  return undefined;
}

/**
 * True when a task is still waiting and no successful claim/dispatch has begun
 * (`dispatchAttempts === 0`).
 */
export function isDispatchNeverStarted(task: EditTask): boolean {
  const instruction = getWaitingInstruction(task);
  if (!instruction || instruction.dispatchAttempts !== 0) {
    return false;
  }
  // Match "created / pending-like" waiting: created, or still pending with 0 attempts.
  if (task.taskState === "created") {
    return true;
  }
  return (
    instruction.status === "pending" || instruction.status === "dispatching"
  );
}

/** Milliseconds until stall hints should appear, or 0 if already due / not applicable. */
export function stallHintDelayRemaining(
  task: EditTask,
  now = Date.now(),
): number | undefined {
  if (!isDispatchNeverStarted(task)) {
    return undefined;
  }
  const instruction = getWaitingInstruction(task);
  if (!instruction) {
    return undefined;
  }
  const elapsed = now - instruction.createdAt;
  if (elapsed >= STALL_HINT_DELAY_MS) {
    return 0;
  }
  return STALL_HINT_DELAY_MS - elapsed;
}

export function shouldShowStallHints(
  task: EditTask,
  now = Date.now(),
): boolean {
  return stallHintDelayRemaining(task, now) === 0;
}
