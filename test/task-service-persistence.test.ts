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
