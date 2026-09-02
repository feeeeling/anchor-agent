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

import { TaskService } from "../src/task-service.js";

class MemoryState {
  private tasks: unknown[] = [];

  get<T>(_key: string, fallback: T): T {
    return (this.tasks.length > 0 ? this.tasks : fallback) as T;
  }

  async update(_key: string, value: unknown): Promise<void> {
    this.tasks = value as unknown[];
  }
}

function createDocument(text = "hello world") {
  return {
    uri: { toString: () => "file:///workspace/example.txt" },
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

async function createTask(service: TaskService) {
  return service.create(
    createDocument() as never,
    {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    } as never,
    "Rewrite greeting",
  );
}

describe("TaskService terminal review actions", () => {
  it("rejects a candidate and blocks late Agent updates", async () => {
    const service = new TaskService(new MemoryState() as never);
    const task = await createTask(service);
    const instruction = task.instructions[0];
    if (!instruction) {
      throw new Error("Created task is missing its initial instruction");
    }
    await service.submitRevision(task.id, {
      instructionId: instruction.id,
      replacement: "Hello",
    });

    const rejected = await service.rejectTask(task.id);

    expect(rejected.taskState).toBe("rejected");
    expect(rejected.progress?.stage).toBe("rejected");
    await expect(
      service.submitRevision(task.id, { replacement: "late candidate" }),
    ).rejects.toThrow("Cannot submit a revision for a task in state rejected");
    await expect(
      service.reportProgress(task.id, { stage: "running", message: "late" }),
    ).rejects.toThrow("Cannot report progress for a task in state rejected");
  });

  it("cancels pending instructions and prevents them from being claimed", async () => {
    const service = new TaskService(new MemoryState() as never);
    const task = await createTask(service);

    const cancelled = await service.cancelTask(task.id);

    expect(cancelled.taskState).toBe("cancelled");
    expect(cancelled.instructions[0]?.status).toBe("failed");
    expect(cancelled.instructions[0]?.lastError).toBe("Task cancelled by user");
    await expect(
      service.claimInstruction({ dispatcherId: "agent", leaseMs: 30_000 }),
    ).resolves.toBeUndefined();
    await expect(service.setState(task.id, "ready")).rejects.toThrow(
      "Cannot change a task in state cancelled",
    );
  });

  it("requires a candidate before rejection", async () => {
    const service = new TaskService(new MemoryState() as never);
    const task = await createTask(service);

    await expect(service.rejectTask(task.id)).rejects.toThrow(
      "This task has no candidate to reject",
    );
  });
});
