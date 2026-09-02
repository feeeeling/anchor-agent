import { describe, expect, it } from "vitest";
import { renderTaskDetailsHtml } from "../src/task-details-html.js";
import {
  buildTaskDetailsViewModel,
  decodeTaskDetailsMessage,
} from "../src/task-details-messages.js";
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

describe("decodeTaskDetailsMessage", () => {
  it("accepts supported inbound types and optional string fields", () => {
    expect(decodeTaskDetailsMessage({ type: "ready" })).toEqual({
      type: "ready",
    });
    expect(
      decodeTaskDetailsMessage({
        type: "continue",
        instruction: "next",
      }),
    ).toEqual({ type: "continue", instruction: "next" });
    expect(
      decodeTaskDetailsMessage({
        type: "answerClarification",
        answer: "yes",
      }),
    ).toEqual({ type: "answerClarification", answer: "yes" });
  });

  it("rejects unknown types and non-string optional fields", () => {
    expect(decodeTaskDetailsMessage(undefined)).toBeUndefined();
    expect(decodeTaskDetailsMessage({ type: "explode" })).toBeUndefined();
    expect(
      decodeTaskDetailsMessage({ type: "continue", instruction: 1 }),
    ).toBeUndefined();
    expect(
      decodeTaskDetailsMessage({ type: "answerClarification", answer: 1 }),
    ).toBeUndefined();
  });
});

describe("buildTaskDetailsViewModel", () => {
  it("exposes failure banner and retry when an instruction failed", () => {
    const view = buildTaskDetailsViewModel(
      task({
        taskState: "failed",
        instructions: [
          instruction({
            status: "failed",
            lastError: "Sampling was rejected",
            dispatchAttempts: 3,
          }),
        ],
        revisions: [
          {
            id: "rev-1",
            replacement: "Hello",
            summary: "greet",
            warnings: [],
            createdAt: 2_000,
          },
        ],
        activeRevisionId: "rev-1",
      }),
      { localText: "hello", currentDocumentVersion: 1 },
    );

    expect(view.showFailureError).toBe(true);
    expect(view.lastError).toBe("Sampling was rejected");
    expect(view.canRetry).toBe(true);
    // failed is not terminal: a prior candidate remains accept/reject-able
    expect(view.canAccept).toBe(true);
    expect(view.canReject).toBe(true);
    expect(view.hasCandidate).toBe(true);
  });

  it("enables clarification answering only while waitingForUser", () => {
    const waiting = buildTaskDetailsViewModel(
      task({
        taskState: "waitingForUser",
        clarification: {
          question: "Which tone?",
          options: ["formal", "casual"],
        },
      }),
      { localText: "hello", currentDocumentVersion: 1 },
    );
    expect(waiting.waitingForUser).toBe(true);
    expect(waiting.canAnswerClarification).toBe(true);
    expect(waiting.clarificationOptions).toEqual(["formal", "casual"]);

    const queued = buildTaskDetailsViewModel(task({ taskState: "queued" }), {
      localText: "hello",
      currentDocumentVersion: 1,
    });
    expect(queued.canAnswerClarification).toBe(false);
  });

  it("surfaces stall hints when dispatch never started past the delay", () => {
    const view = buildTaskDetailsViewModel(
      task({
        taskState: "created",
        instructions: [instruction({ status: "pending", createdAt: 1_000 })],
      }),
      { localText: "hello", currentDocumentVersion: 1, now: 1_000 + 13_000 },
    );
    expect(view.showStallHints).toBe(true);
    expect(view.stallHints.length).toBeGreaterThan(0);
  });
});

describe("renderTaskDetailsHtml message UI", () => {
  it("includes stall, failure banner, Retry, and clarification reply controls", () => {
    const html = renderTaskDetailsHtml("test-nonce");
    expect(html).toContain('id="stall"');
    expect(html).toContain('id="failure"');
    expect(html).toContain('id="retry"');
    expect(html).toContain("send('retry')");
    expect(html).toContain('id="clarification"');
    expect(html).toContain("answerClarification");
    expect(html).toContain("clarificationAnswered");
    expect(html).toContain("showStallHints");
    expect(html).toContain("showFailureError");
  });
});
