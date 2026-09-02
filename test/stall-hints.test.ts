import { describe, expect, it } from "vitest";
import {
  STALL_HINT_CHECKLIST,
  STALL_HINT_DELAY_MS,
  getWaitingInstruction,
  isDispatchNeverStarted,
  shouldShowStallHints,
  stallHintDelayRemaining,
} from "../src/stall-hints.js";
import type { EditTask, TaskInstruction } from "../src/types.js";

function instruction(
  overrides: Partial<TaskInstruction> = {},
): TaskInstruction {
  return {
    id: "inst-1",
    text: "Rewrite greeting",
    status: "pending",
    dispatchAttempts: 0,
    createdAt: 1_000,
    ...overrides,
  };
}

function task(overrides: Partial<EditTask> = {}): EditTask {
  return {
    id: "task-1",
    title: "Rewrite greeting",
    instruction: "Rewrite greeting",
    documentUri: "file:///workspace/example.txt",
    languageId: "plaintext",
    baseDocumentVersion: 1,
    baseStart: 0,
    baseEnd: 5,
    currentStart: 0,
    currentEnd: 5,
    baseText: "hello",
    baseTextHash: "hash",
    documentSnapshot: "hello world",
    anchorState: "clean",
    taskState: "created",
    branchId: "branch-1",
    instructions: [instruction()],
    revisions: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("stall hints", () => {
  it("uses a 12s delay within the 10–15s window", () => {
    expect(STALL_HINT_DELAY_MS).toBe(12_000);
  });

  it("exposes an actionable checklist covering MCP, reload, sampling, and claim", () => {
    const joined = STALL_HINT_CHECKLIST.join("\n");
    expect(joined).toMatch(/MCP may not be connected/i);
    expect(joined).toMatch(/\/reload/);
    expect(joined).toMatch(/Sampling/i);
    expect(joined).toMatch(/anchor\.claim_task/);
  });

  it("detects a created task whose latest instruction never started dispatch", () => {
    const created = task();
    expect(getWaitingInstruction(created)?.id).toBe("inst-1");
    expect(isDispatchNeverStarted(created)).toBe(true);
    expect(shouldShowStallHints(created, 1_000 + 11_999)).toBe(false);
    expect(stallHintDelayRemaining(created, 1_000 + 11_999)).toBe(1);
    expect(shouldShowStallHints(created, 1_000 + 12_000)).toBe(true);
    expect(stallHintDelayRemaining(created, 1_000 + 12_000)).toBe(0);
  });

  it("hides hints once a claim increments dispatchAttempts", () => {
    const claimed = task({
      taskState: "queued",
      instructions: [
        instruction({
          status: "dispatching",
          dispatchAttempts: 1,
          dispatcherId: "mcp-1",
          leaseUntil: 50_000,
        }),
      ],
    });
    expect(isDispatchNeverStarted(claimed)).toBe(false);
    expect(shouldShowStallHints(claimed, 100_000)).toBe(false);
    expect(stallHintDelayRemaining(claimed, 100_000)).toBeUndefined();
  });

  it("uses the latest waiting instruction createdAt after continue", () => {
    const continued = task({
      instructions: [
        instruction({
          id: "inst-old",
          status: "completed",
          dispatchAttempts: 1,
          createdAt: 1_000,
        }),
        instruction({
          id: "inst-new",
          status: "pending",
          dispatchAttempts: 0,
          createdAt: 20_000,
        }),
      ],
      createdAt: 1_000,
      updatedAt: 20_000,
    });
    expect(getWaitingInstruction(continued)?.id).toBe("inst-new");
    expect(shouldShowStallHints(continued, 20_000 + 11_999)).toBe(false);
    expect(shouldShowStallHints(continued, 20_000 + 12_000)).toBe(true);
  });

  it("does not treat completed or failed instructions as stalled", () => {
    const ready = task({
      taskState: "ready",
      instructions: [
        instruction({ status: "completed", dispatchAttempts: 1 }),
      ],
    });
    const failed = task({
      taskState: "failed",
      instructions: [instruction({ status: "failed", dispatchAttempts: 3 })],
    });
    expect(isDispatchNeverStarted(ready)).toBe(false);
    expect(isDispatchNeverStarted(failed)).toBe(false);
  });
});
