import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  EventEmitter: class<T> {
    private readonly listeners: Array<(value: T) => void> = [];
    readonly event = (listener: (value: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
    fire(value: T): void {
      for (const listener of this.listeners) {
        listener(value);
      }
    }
    dispose(): void {
      this.listeners.length = 0;
    }
  },
  Range: class {
    constructor(
      readonly start: unknown,
      readonly end: unknown,
    ) {}
  },
}));

import {
  TaskService,
  releaseInFlightDispatchLeases,
} from "../src/task-service.js";
import type { EditTask } from "../src/types.js";

/** Key-aware Memento stand-in that survives TaskService dispose/reconstruct. */
class MemoryState {
  private readonly store = new Map<string, unknown>();

  get<T>(key: string, fallback: T): T {
    return (this.store.has(key) ? this.store.get(key) : fallback) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
}

function createDocument(uri: string, text = "hello world") {
  return {
    uri: { toString: () => uri },
    languageId: "plaintext",
    version: 1,
    getText: (selection?: {
      start: { character: number };
      end: { character: number };
    }) =>
      selection
        ? text.slice(selection.start.character, selection.end.character)
        : text,
    offsetAt: (position: { character: number }) => position.character,
    positionAt: (offset: number) => ({ line: 0, character: offset }),
  };
}

async function createTask(
  service: TaskService,
  uri: string,
  instruction: string,
  end = 5,
) {
  return service.create(
    createDocument(uri) as never,
    {
      start: { line: 0, character: 0 },
      end: { line: 0, character: end },
    } as never,
    instruction,
  );
}

describe("QA: document close must not lose tasks", () => {
  it("keeps tasks for a URI after handleDocumentClosed", async () => {
    const state = new MemoryState();
    const service = new TaskService(state as never);
    const uri = "file:///workspace/notes.txt";
    const task = await createTask(service, uri, "Polish the intro");
    const sibling = await createTask(
      service,
      "file:///workspace/other.txt",
      "Rewrite elsewhere",
    );

    const preserved = service.handleDocumentClosed(uri);

    expect(preserved.map((item) => item.id)).toEqual([task.id]);
    expect(service.get(task.id)?.documentUri).toBe(uri);
    expect(service.get(task.id)?.taskState).toBe("created");
    expect(service.get(sibling.id)).toBeDefined();
    expect(service.list()).toHaveLength(2);
  });

  it("still lists the task after a simulated deactivate + activate", async () => {
    const state = new MemoryState();
    const live = new TaskService(state as never);
    const uri = "file:///workspace/keep-me.md";
    const task = await createTask(live, uri, "Keep across close");
    live.handleDocumentClosed(uri);
    live.dispose();

    const recovered = new TaskService(state as never);
    expect(recovered.get(task.id)?.instruction).toBe("Keep across close");
    expect(recovered.handleDocumentClosed(uri)).toHaveLength(1);
  });
});

describe("QA: extension recovery restores continuable state", () => {
  it("reloads persisted tasks and releases in-flight dispatch leases", async () => {
    const state = new MemoryState();
    const live = new TaskService(state as never);
    const task = await createTask(
      live,
      "file:///workspace/recover.ts",
      "Continue after reload",
    );
    const claim = await live.claimInstruction({
      dispatcherId: "dead-host",
      leaseMs: 300_000,
      taskId: task.id,
      branchMode: "native",
      sourceSessionId: "session-live",
    });
    expect(claim?.instruction.status).toBe("dispatching");
    expect(live.get(task.id)?.taskState).toBe("queued");
    live.dispose();

    const recovered = new TaskService(state as never);
    const restored = recovered.get(task.id);
    expect(restored).toBeDefined();
    expect(restored?.branchMode).toBe("native");
    expect(restored?.sourceSessionId).toBe("session-live");
    expect(restored?.instructions[0]?.status).toBe("pending");
    expect(restored?.instructions[0]?.dispatcherId).toBeUndefined();
    expect(restored?.instructions[0]?.leaseUntil).toBeUndefined();
    expect(restored?.taskState).toBe("created");
    expect(restored?.progress?.message).toMatch(/Restored after extension reload/);

    const reclaim = await recovered.claimInstruction({
      dispatcherId: "new-host",
      leaseMs: 30_000,
      taskId: task.id,
    });
    expect(reclaim?.instruction.id).toBe(task.instructions[0]?.id);
    expect(reclaim?.instruction.dispatcherId).toBe("new-host");
    expect(reclaim?.instruction.dispatchAttempts).toBe(2);
  });

  it("listContinuable includes waiting and ready tasks after recovery", async () => {
    const state = new MemoryState();
    const live = new TaskService(state as never);
    const waiting = await createTask(
      live,
      "file:///workspace/a.txt",
      "Need clarification",
    );
    const ready = await createTask(
      live,
      "file:///workspace/b.txt",
      "Ready for review",
    );
    const cancelled = await createTask(
      live,
      "file:///workspace/c.txt",
      "Will cancel",
    );
    await live.requestClarification(waiting.id, "Which tone?");
    const readyInstruction = ready.instructions[0];
    if (!readyInstruction) {
      throw new Error("missing instruction");
    }
    await live.submitRevision(ready.id, {
      instructionId: readyInstruction.id,
      replacement: "Ready text",
    });
    await live.cancelTask(cancelled.id);
    live.dispose();

    const recovered = new TaskService(state as never);
    const continuableIds = recovered.listContinuable().map((task) => task.id);
    expect(continuableIds).toContain(waiting.id);
    expect(continuableIds).toContain(ready.id);
    expect(continuableIds).not.toContain(cancelled.id);
  });

  it("releaseInFlightDispatchLeases is idempotent for pending instructions", () => {
    const task = {
      taskState: "created",
      instructions: [
        {
          id: "i1",
          text: "x",
          status: "pending",
          dispatchAttempts: 0,
          createdAt: 1,
        },
      ],
      updatedAt: 1,
    } as EditTask;
    expect(releaseInFlightDispatchLeases(task)).toBe(false);
    expect(task.instructions[0]?.status).toBe("pending");
  });
});

describe("QA: multi-task isolation (no cross-contamination)", () => {
  it("keeps instruction/revision/progress/branch metadata independent", async () => {
    const service = new TaskService(new MemoryState() as never);
    const alpha = await createTask(
      service,
      "file:///workspace/alpha.ts",
      "Alpha instruction",
      5,
    );
    const beta = await createTask(
      service,
      "file:///workspace/beta.ts",
      "Beta instruction",
      5,
    );

    await service.bindBranch(alpha.id, {
      branchMode: "native",
      sourceSessionId: "alpha-session",
      sourceNodeId: "alpha-node",
    });
    await service.reportProgress(alpha.id, {
      stage: "running",
      message: "Alpha only",
      percentage: 40,
    });
    await service.continueTask(beta.id, "Beta follow-up");
    await service.bindBranch(beta.id, {
      branchMode: "logical",
      sourceSessionId: "beta-session",
    });

    const alphaClaim = await service.claimInstruction({
      dispatcherId: "agent-a",
      leaseMs: 30_000,
      taskId: alpha.id,
    });
    await service.submitRevision(alpha.id, {
      instructionId: alphaClaim!.instruction.id,
      replacement: "ALPHA",
      summary: "alpha revision",
    });

    const alphaNow = service.get(alpha.id)!;
    const betaNow = service.get(beta.id)!;

    expect(alphaNow.branchId).not.toBe(betaNow.branchId);
    expect(alphaNow.branchMode).toBe("native");
    expect(betaNow.branchMode).toBe("logical");
    expect(alphaNow.sourceSessionId).toBe("alpha-session");
    expect(betaNow.sourceSessionId).toBe("beta-session");
    expect(alphaNow.progress?.message).toContain("Candidate revision");
    expect(betaNow.progress).toBeUndefined();
    expect(alphaNow.instruction).toBe("Alpha instruction");
    expect(betaNow.instruction).toBe("Beta follow-up");
    expect(alphaNow.revisions).toHaveLength(1);
    expect(betaNow.revisions).toHaveLength(0);
    expect(alphaNow.instructions[0]?.status).toBe("completed");
    expect(betaNow.instructions.some((item) => item.status === "pending")).toBe(
      true,
    );
    expect(alphaNow.instructions.map((item) => item.id)).not.toEqual(
      betaNow.instructions.map((item) => item.id),
    );
  });

  it("document edits for one URI never mutate another task's anchors", async () => {
    const service = new TaskService(new MemoryState() as never);
    const alpha = await createTask(
      service,
      "file:///workspace/alpha.ts",
      "Alpha",
      5,
    );
    const beta = await createTask(
      service,
      "file:///workspace/beta.ts",
      "Beta",
      5,
    );
    const alphaStart = alpha.currentStart;
    const alphaEnd = alpha.currentEnd;
    const betaStart = beta.currentStart;
    const betaEnd = beta.currentEnd;

    await service.applyDocumentChanges("file:///workspace/alpha.ts", [
      { rangeOffset: 0, rangeLength: 0, text: "PREFIX-" },
    ]);

    expect(service.get(alpha.id)?.currentStart).toBe(alphaStart + 7);
    expect(service.get(alpha.id)?.currentEnd).toBe(alphaEnd + 7);
    expect(service.get(beta.id)?.currentStart).toBe(betaStart);
    expect(service.get(beta.id)?.currentEnd).toBe(betaEnd);
    expect(service.get(beta.id)?.anchorState).toBe("clean");
  });

  it("targeted claim and failInstruction never touch a sibling task", async () => {
    const service = new TaskService(new MemoryState() as never);
    const alpha = await createTask(
      service,
      "file:///workspace/alpha.ts",
      "Alpha",
    );
    const beta = await createTask(
      service,
      "file:///workspace/beta.ts",
      "Beta",
    );
    const betaSnapshot = structuredClone(service.get(beta.id));

    const claim = await service.claimInstruction({
      dispatcherId: "only-alpha",
      leaseMs: 30_000,
      taskId: alpha.id,
    });
    await service.failInstruction(
      claim!.instruction.id,
      "only-alpha",
      "transient",
    );

    expect(service.get(alpha.id)?.instructions[0]?.lastError).toBe("transient");
    expect(service.get(beta.id)).toEqual(betaSnapshot);
  });
});
