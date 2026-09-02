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

import { releaseInFlightDispatchLeases } from "../src/task-recovery.js";
import { TaskService } from "../src/task-service.js";

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
    expect(service.get(sibling.id)).toBeDefined();
    expect(service.list()).toHaveLength(2);
  });

  it("still keeps tasks after simulated dispose + reconstruct", async () => {
    const state = new MemoryState();
    const live = new TaskService(state as never);
    const uri = "file:///workspace/keep-me.md";
    const task = await createTask(live, uri, "Keep across close");

    live.handleDocumentClosed(uri);
    live.dispose();

    const recovered = new TaskService(state as never);
    expect(recovered.get(task.id)?.instruction).toBe("Keep across close");
    expect(recovered.handleDocumentClosed(uri).map((item) => item.id)).toEqual([
      task.id,
    ]);
    expect(recovered.list()).toHaveLength(1);
  });
});

describe("QA: extension recovery releases leases and continuable tasks are discoverable", () => {
  it("releases in-flight dispatch leases on restore so reclaim works", async () => {
    const state = new MemoryState();
    const service = new TaskService(state as never);
    const task = await createTask(service, "file:///workspace/recover.txt", "Recover me");

    const claim = await service.claimInstruction({
      dispatcherId: "agent-a",
      leaseMs: 30_000,
      taskId: task.id,
    });
    expect(claim?.instruction.status).toBe("dispatching");

    service.dispose();
    const recovered = new TaskService(state as never);
    const restored = recovered.get(task.id);

    expect(restored?.instructions[0]?.status).toBe("pending");
    expect(restored?.instructions[0]?.dispatcherId).toBeUndefined();
    expect(restored?.taskState).toBe("created");

    const reclaim = await recovered.claimInstruction({
      dispatcherId: "agent-b",
      leaseMs: 30_000,
      taskId: task.id,
    });
    expect(reclaim?.instruction.id).toBe(task.instructions[0]?.id);
    expect(reclaim?.instruction.dispatcherId).toBe("agent-b");
  });

  it("listContinuable includes waiting/ready and excludes cancelled/orphaned", async () => {
    const state = new MemoryState();
    const service = new TaskService(state as never);

    const waiting = await createTask(service, "file:///workspace/waiting.txt", "Need answer");
    await service.requestClarification(waiting.id, "Choose one?");

    const ready = await createTask(service, "file:///workspace/ready.txt", "Draft candidate");
    const readyInstruction = ready.instructions[0];
    if (!readyInstruction) {
      throw new Error("Missing initial instruction");
    }
    await service.submitRevision(ready.id, {
      instructionId: readyInstruction.id,
      replacement: "Ready text",
    });

    const pending = await createTask(service, "file:///workspace/pending.txt", "Still pending");

    const cancelled = await createTask(service, "file:///workspace/cancelled.txt", "Cancel me");
    await service.cancelTask(cancelled.id);

    const orphaned = await createTask(service, "file:///workspace/orphaned.txt", "Orphan me");
    await service.setState(orphaned.id, "orphaned");

    const continuableIds = new Set(service.listContinuable().map((task) => task.id));

    expect(continuableIds.has(waiting.id)).toBe(true);
    expect(continuableIds.has(ready.id)).toBe(true);
    expect(continuableIds.has(pending.id)).toBe(true);
    expect(continuableIds.has(cancelled.id)).toBe(false);
    expect(continuableIds.has(orphaned.id)).toBe(false);
  });

  it("release helper converts dispatching lease to pending", async () => {
    const state = new MemoryState();
    const service = new TaskService(state as never);
    const task = await createTask(service, "file:///workspace/helper.txt", "Use helper");
    const claim = await service.claimInstruction({
      dispatcherId: "helper-agent",
      leaseMs: 30_000,
      taskId: task.id,
    });
    if (!claim) {
      throw new Error("Expected instruction claim");
    }

    const released = releaseInFlightDispatchLeases(task);

    expect(released).toBe(true);
    expect(task.instructions[0]?.status).toBe("pending");
    expect(task.instructions[0]?.dispatcherId).toBeUndefined();
  });
});

describe("QA: multi-task isolation", () => {
  it("keeps branch/progress/instructions/revisions isolated across tasks", async () => {
    const state = new MemoryState();
    const service = new TaskService(state as never);

    const left = await createTask(service, "file:///workspace/left.txt", "Edit left", 4);
    const right = await createTask(service, "file:///workspace/right.txt", "Edit right", 5);

    expect(left.branchId).not.toBe(right.branchId);

    const leftClaim = await service.claimInstruction({
      dispatcherId: "left-agent",
      leaseMs: 30_000,
      taskId: left.id,
    });
    if (!leftClaim) {
      throw new Error("Expected left task claim");
    }

    await service.reportProgress(left.id, {
      stage: "running",
      message: "left only",
    });
    await service.submitRevision(left.id, {
      instructionId: leftClaim.instruction.id,
      replacement: "LEFT",
    });
    await service.continueTask(left.id, "Refine left again");

    expect(service.get(left.id)?.revisions).toHaveLength(1);
    expect(service.get(right.id)?.revisions).toHaveLength(0);
    expect(service.get(left.id)?.instructions).toHaveLength(2);
    expect(service.get(right.id)?.instructions).toHaveLength(1);
    expect(service.get(right.id)?.progress).toBeUndefined();

    const rightBefore = service.get(right.id);
    await service.applyDocumentChanges("file:///workspace/left.txt", [
      { rangeOffset: 0, rangeLength: 0, text: "xx" },
    ]);
    const rightAfter = service.get(right.id);
    expect(rightAfter?.currentStart).toBe(rightBefore?.currentStart);
    expect(rightAfter?.currentEnd).toBe(rightBefore?.currentEnd);
    expect(rightAfter?.updatedAt).toBe(rightBefore?.updatedAt);

    const leftFollowup = await service.claimInstruction({
      dispatcherId: "left-agent-2",
      leaseMs: 30_000,
      taskId: left.id,
    });
    if (!leftFollowup) {
      throw new Error("Expected left follow-up claim");
    }
    await service.failInstruction(
      leftFollowup.instruction.id,
      "left-agent-2",
      "left side failed",
    );

    const rightStable = service.get(right.id);
    expect(rightStable?.taskState).toBe("created");
    expect(rightStable?.instructions[0]?.status).toBe("pending");
    expect(rightStable?.instructions[0]?.dispatchAttempts).toBe(0);
    expect(rightStable?.instructions[0]?.lastError).toBeUndefined();
    expect(rightStable?.progress).toBeUndefined();
  });
});
