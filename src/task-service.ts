import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { transformAnchor } from "./anchor-range.js";
import { sha256 } from "./hash.js";
import type {
  EditTask,
  Revision,
  TaskInstruction,
  TaskProgress,
  TextChange,
} from "./types.js";

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
      if (!Array.isArray((task as { instructions?: unknown }).instructions)) {
        task.instructions = [
          {
            id: randomUUID(),
            text: task.instruction,
            status: task.revisions.length > 0 ? "completed" : "pending",
            ...(task.revisions[0] ? { revisionId: task.revisions[0].id } : {}),
            createdAt: task.createdAt,
          },
        ];
      }
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
      instructions: [
        {
          id: randomUUID(),
          text: instruction,
          status: "pending",
          createdAt: now,
        },
      ],
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

  async rebaseTask(
    taskId: string,
    document: vscode.TextDocument,
  ): Promise<EditTask> {
    const task = this.require(taskId);
    const range = new vscode.Range(
      document.positionAt(task.currentStart),
      document.positionAt(task.currentEnd),
    );
    const currentText = document.getText(range);
    task.baseDocumentVersion = document.version;
    task.baseStart = task.currentStart;
    task.baseEnd = task.currentEnd;
    task.baseText = currentText;
    task.baseTextHash = sha256(currentText);
    task.documentSnapshot = document.getText();
    task.anchorState = currentText.length === 0 ? "orphaned" : "clean";
    task.taskState = currentText.length === 0 ? "orphaned" : "created";
    delete task.progress;
    delete task.clarification;
    task.updatedAt = Date.now();
    await this.changed();
    return task;
  }

  async continueTask(
    taskId: string,
    instruction: string,
  ): Promise<TaskInstruction> {
    const task = this.require(taskId);
    const pending: TaskInstruction = {
      id: randomUUID(),
      text: instruction,
      status: "pending",
      createdAt: Date.now(),
      ...(task.activeRevisionId
        ? { parentRevisionId: task.activeRevisionId }
        : {}),
    };
    task.instructions.push(pending);
    task.instruction = instruction;
    delete task.progress;
    delete task.clarification;
    task.taskState =
      task.anchorState === "modified" || task.anchorState === "orphaned"
        ? "conflicted"
        : "created";
    task.updatedAt = Date.now();
    await this.changed();
    return pending;
  }

  async submitRevision(
    taskId: string,
    candidate: Omit<Revision, "id" | "createdAt" | "warnings"> & {
      warnings?: string[];
    },
  ): Promise<Revision> {
    const task = this.require(taskId);
    const pendingInstruction = candidate.instructionId
      ? task.instructions.find((item) => item.id === candidate.instructionId)
      : [...task.instructions]
          .reverse()
          .find((item) => item.status === "pending");
    if (candidate.instructionId && !pendingInstruction) {
      throw new Error(`Unknown instruction: ${candidate.instructionId}`);
    }
    const revisionInstruction =
      candidate.instruction ?? pendingInstruction?.text;
    const revision: Revision = {
      id: randomUUID(),
      replacement: candidate.replacement,
      warnings: candidate.warnings ?? [],
      createdAt: Date.now(),
      ...(candidate.parentRevisionId
        ? { parentRevisionId: candidate.parentRevisionId }
        : pendingInstruction?.parentRevisionId
          ? { parentRevisionId: pendingInstruction.parentRevisionId }
          : {}),
      ...(pendingInstruction ? { instructionId: pendingInstruction.id } : {}),
      ...(revisionInstruction ? { instruction: revisionInstruction } : {}),
      ...(candidate.summary ? { summary: candidate.summary } : {}),
      ...(candidate.basedOnDocumentVersion === undefined
        ? {}
        : { basedOnDocumentVersion: candidate.basedOnDocumentVersion }),
    };
    task.revisions.push(revision);
    if (pendingInstruction) {
      pendingInstruction.status = "completed";
      pendingInstruction.revisionId = revision.id;
    }
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
