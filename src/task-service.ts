import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { transformAnchor } from "./anchor-tracker.js";
import { sha256 } from "./hash.js";
import type { EditTask, Revision, TaskProgress, TextChange } from "./types.js";

const STORAGE_KEY = "anchorAgent.tasks.v1";
const TERMINAL_STATES = new Set([
  "applied",
  "rejected",
  "cancelled",
  "archived",
]);

export class TaskService implements vscode.Disposable {
  private readonly tasks = new Map<string, EditTask>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly state: vscode.Memento) {
    for (const task of state.get<EditTask[]>(STORAGE_KEY, [])) {
      this.tasks.set(task.id, task);
    }
  }

  list(): EditTask[] {
    return [...this.tasks.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
  }

  get(taskId: string): EditTask | undefined {
    return this.tasks.get(taskId);
  }

  async create(
    document: vscode.TextDocument,
    selection: vscode.Selection,
    instruction: string,
    branch?: { sourceSessionId?: string; sourceNodeId?: string },
  ): Promise<EditTask> {
    const now = Date.now();
    const baseText = document.getText(selection);
    const task: EditTask = {
      id: randomUUID(),
      title: instruction.split(/\r?\n/, 1)[0]?.slice(0, 80) || "Local edit",
      instruction,
      documentUri: document.uri.toString(),
      languageId: document.languageId,
      baseDocumentVersion: document.version,
      baseStart: document.offsetAt(selection.start),
      baseEnd: document.offsetAt(selection.end),
      currentStart: document.offsetAt(selection.start),
      currentEnd: document.offsetAt(selection.end),
      baseText,
      baseTextHash: sha256(baseText),
      documentSnapshot: document.getText(),
      anchorState: "clean",
      taskState: "created",
      branchId: `branch-${randomUUID()}`,
      revisions: [],
      createdAt: now,
      updatedAt: now,
      ...(branch?.sourceSessionId
        ? { sourceSessionId: branch.sourceSessionId }
        : {}),
      ...(branch?.sourceNodeId ? { sourceNodeId: branch.sourceNodeId } : {}),
    };
    this.tasks.set(task.id, task);
    await this.changed();
    return task;
  }

  async applyDocumentChanges(
    documentUri: string,
    changes: readonly TextChange[],
  ): Promise<void> {
    let didChange = false;
    for (const task of this.tasks.values()) {
      if (
        task.documentUri !== documentUri ||
        TERMINAL_STATES.has(task.taskState) ||
        task.taskState === "applying"
      ) {
        continue;
      }
      const transformed = transformAnchor(
        {
          start: task.currentStart,
          end: task.currentEnd,
          state: task.anchorState,
        },
        changes,
      );
      task.currentStart = transformed.start;
      task.currentEnd = transformed.end;
      task.anchorState = transformed.state;
      if (transformed.state === "orphaned") {
        task.taskState = "orphaned";
      } else if (
        transformed.state === "modified" &&
        task.taskState === "ready"
      ) {
        task.taskState = "conflicted";
      }
      task.updatedAt = Date.now();
      didChange = true;
    }
    if (didChange) {
      await this.changed();
    }
  }

  async reportProgress(
    taskId: string,
    progress: TaskProgress,
  ): Promise<EditTask> {
    const task = this.require(taskId);
    task.progress = progress;
    task.taskState = "running";
    task.updatedAt = Date.now();
    await this.changed();
    return task;
  }

  async submitRevision(
    taskId: string,
    candidate: Omit<Revision, "id" | "createdAt" | "warnings"> & {
      warnings?: string[];
    },
  ): Promise<Revision> {
    const task = this.require(taskId);
    const revision: Revision = {
      id: randomUUID(),
      replacement: candidate.replacement,
      warnings: candidate.warnings ?? [],
      createdAt: Date.now(),
      ...(candidate.parentRevisionId
        ? { parentRevisionId: candidate.parentRevisionId }
        : {}),
      ...(candidate.instruction ? { instruction: candidate.instruction } : {}),
      ...(candidate.summary ? { summary: candidate.summary } : {}),
      ...(candidate.basedOnDocumentVersion === undefined
        ? {}
        : { basedOnDocumentVersion: candidate.basedOnDocumentVersion }),
    };
    task.revisions.push(revision);
    task.activeRevisionId = revision.id;
    task.progress = {
      stage: "completed",
      message: "Candidate revision ready for review",
      percentage: 100,
    };
    task.taskState =
      task.anchorState === "modified" || task.anchorState === "orphaned"
        ? "conflicted"
        : "ready";
    task.updatedAt = Date.now();
    await this.changed();
    return revision;
  }

  async requestClarification(
    taskId: string,
    question: string,
    options?: string[],
  ): Promise<EditTask> {
    const task = this.require(taskId);
    task.clarification = { question, ...(options?.length ? { options } : {}) };
    task.taskState = "waitingForUser";
    task.updatedAt = Date.now();
    await this.changed();
    return task;
  }

  async setState(
    taskId: string,
    taskState: EditTask["taskState"],
  ): Promise<EditTask> {
    const task = this.require(taskId);
    task.taskState = taskState;
    task.updatedAt = Date.now();
    await this.changed();
    return task;
  }

  publicView(task: EditTask): Omit<EditTask, "documentSnapshot"> {
    const { documentSnapshot: _, ...publicTask } = task;
    return publicTask;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private require(taskId: string): EditTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    return task;
  }

  private async changed(): Promise<void> {
    await this.state.update(STORAGE_KEY, this.list());
    this.changeEmitter.fire();
  }
}
