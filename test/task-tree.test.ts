import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));
import { contextValueFor } from "../src/task-tree.js";
import type { EditTask, Revision } from "../src/types.js";

function revision(overrides: Partial<Revision> = {}): Revision {
  return {
    id: "rev-1",
    replacement: "new text",
    warnings: [],
    createdAt: 1,
    ...overrides,
  };
}

function task(overrides: Partial<EditTask> = {}): EditTask {
  return {
    id: "task-1",
    title: "Rewrite",
    instruction: "Do it",
    documentUri: "file:///tmp/a.ts",
    languageId: "typescript",
    baseDocumentVersion: 1,
    baseStart: 0,
    baseEnd: 4,
    currentStart: 0,
    currentEnd: 4,
    baseText: "old",
    baseTextHash: "hash",
    documentSnapshot: "old",
    anchorState: "clean",
    taskState: "ready",
    branchId: "branch-1",
    instructions: [],
    revisions: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("contextValueFor", () => {
  it("marks ready tasks with a candidate as hasCandidate, cancellable, and rejectable", () => {
    const value = contextValueFor(
      task({
        taskState: "ready",
        revisions: [revision()],
        activeRevisionId: "rev-1",
      }),
    );
    expect(value).toContain("anchorTask.ready");
    expect(value).toContain("hasCandidate");
    expect(value).toContain("cancellable");
    expect(value).toContain("rejectable");
  });

  it("omits rejectable and hasCandidate when no revision exists", () => {
    const value = contextValueFor(task({ taskState: "running", revisions: [] }));
    expect(value).toContain("anchorTask.running");
    expect(value).toContain("cancellable");
    expect(value).not.toContain("hasCandidate");
    expect(value).not.toContain("rejectable");
  });

  it("keeps hasCandidate on terminal tasks but omits cancel/reject flags", () => {
    const value = contextValueFor(
      task({
        taskState: "applied",
        revisions: [revision()],
        activeRevisionId: "rev-1",
      }),
    );
    expect(value).toContain("anchorTask.applied");
    expect(value).toContain("hasCandidate");
    expect(value).not.toContain("cancellable");
    expect(value).not.toContain("rejectable");
  });

  it("treats applying like non-actionable for cancel/reject", () => {
    const value = contextValueFor(
      task({
        taskState: "applying",
        revisions: [revision()],
      }),
    );
    expect(value).toContain("hasCandidate");
    expect(value).not.toContain("cancellable");
    expect(value).not.toContain("rejectable");
  });
});
