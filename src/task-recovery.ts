/**
 * After extension host restart the previous dispatcher is gone.
 * Convert in-flight leases back to pending so claim/continue works again.
 */
import type { EditTask } from "./types.js";

export function releaseInFlightDispatchLeases(task: EditTask): boolean {
  let released = false;
  for (const instruction of task.instructions) {
    if (instruction.status !== "dispatching") {
      continue;
    }
    instruction.status = "pending";
    delete instruction.dispatcherId;
    delete instruction.leaseUntil;
    released = true;
  }
  if (
    released &&
    (task.taskState === "queued" || task.taskState === "running")
  ) {
    task.taskState = "created";
    task.progress = {
      stage: "queued",
      message:
        "Restored after extension reload; waiting for a connected Agent",
    };
    task.updatedAt = Date.now();
  }
  return released;
}
