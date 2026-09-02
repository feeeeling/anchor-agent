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
type TerminalTaskState = "applied" | "rejected" | "cancelled" | "archived";

const TERMINAL_STATES = new Set<EditTask["taskState"]>([
  "applied",
  "rejected",
  "cancelled",
  "archived",
]);

export interface InstructionClaim {
  task: Omit<EditTask, "documentSnapshot">;
  instruction: TaskInstruction;
}

export interface ClaimInstructionRequest {
  dispatcherId: string;
  leaseMs: number;
  taskId?: string;
  sourceSessionId?: string;
  sourceNodeId?: string;
}

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
            dispatchAttempts: 0,
            createdAt: task.createdAt,
          },
        ];
      }
      for (const instruction of task.instructions) {
        instruction.dispatchAttempts ??= 0;
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
          dispatchAttempts: 0,
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
    this.ensureMutable(task, "report progress for");
    task.progress = progress;
    task.taskState = "running";
    task.updatedAt = Date.now();
    await this.changed();
    return task;
  }

  async claimInstruction(
    request: ClaimInstructionRequest,
  ): Promise<InstructionClaim | undefined> {
    const now = Date.now();
    const candidates = [...this.tasks.values()].sort(
      (left, right) => left.createdAt - right.createdAt,
    );
    for (const task of candidates) {
      if (
        (request.taskId && task.id !== request.taskId) ||
        TERMINAL_STATES.has(task.taskState) ||
        task.taskState === "orphaned"
      ) {
        continue;
      }
      for (const instruction of task.instructions) {
        if (
          instruction.status === "dispatching" &&
          (instruction.leaseUntil ?? 0) <= now
        ) {
          instruction.status = "pending";
          delete instruction.dispatcherId;
          delete instruction.leaseUntil;
        }
        if (instruction.status !== "pending") {
          continue;
        }
        instruction.status = "dispatching";
        instruction.dispatcherId = request.dispatcherId;
        instruction.leaseUntil =
          now + Math.min(Math.max(request.leaseMs, 5_000), 300_000);
        instruction.dispatchAttempts += 1;
        delete instruction.lastError;
        task.taskState = "queued";
        task.progress = {
          stage: "dispatching",
          message: "A connected Agent claimed this instruction",
        };
        if (request.sourceSessionId) {
          task.sourceSessionId = request.sourceSessionId;
        }
        if (request.sourceNodeId) {
          task.sourceNodeId = request.sourceNodeId;
        }
        task.updatedAt = now;
        await this.changed();
        return { task: this.publicView(task), instruction };
      }
    }
    return undefined;
  }

  async failInstruction(
    instructionId: string,
    dispatcherId: string,
    message: string,
  ): Promise<void> {
    for (const task of this.tasks.values()) {
      const instruction = task.instructions.find(
        (item) => item.id === instructionId,
      );
      if (!instruction) {
        continue;
      }
      this.ensureMutable(task, "fail an instruction for");
      if (
        instruction.dispatcherId &&
        instruction.dispatcherId !== dispatcherId
      ) {
        throw new Error("Instruction is leased by another dispatcher");
      }
      instruction.lastError = message;
      delete instruction.dispatcherId;
      if (instruction.dispatchAttempts < 3) {
        instruction.status = "dispatching";
        instruction.leaseUntil =
          Date.now() + 5_000 * 2 ** instruction.dispatchAttempts;
        task.taskState = "queued";
        task.progress = {
          stage: "retrying",
          message: `Agent dispatch failed; retrying (${instruction.dispatchAttempts}/3)`,
        };
      } else {
        instruction.status = "failed";
        delete instruction.leaseUntil;
        task.taskState = "failed";
        task.progress = { stage: "failed", message };
      }
      task.updatedAt = Date.now();
      await this.changed();
      return;
    }
    throw new Error(`Unknown instruction: ${instructionId}`);
  }

  async rebaseTask(
    taskId: string,
    document: vscode.TextDocument,
  ): Promise<EditTask> {
    const task = this.require(taskId);
    this.ensureMutable(task, "rebase");
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
    if (TERMINAL_STATES.has(task.taskState) || task.taskState === "applying") {
      throw new Error(`Cannot continue a task in state ${task.taskState}`);
    }
    const pending: TaskInstruction = {
      id: randomUUID(),
      text: instruction,
      status: "pending",
      dispatchAttempts: 0,
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
    this.ensureMutable(task, "submit a revision for");
    const pendingInstruction = candidate.instructionId
      ? task.instructions.find((item) => item.id === candidate.instructionId)
      : [...task.instructions]
          .reverse()
          .find(
            (item) =>
              item.status === "pending" || item.status === "dispatching",
          );
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
      delete pendingInstruction.dispatcherId;
      delete pendingInstruction.leaseUntil;
      delete pendingInstruction.lastError;
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

  async retryTask(taskId: string): Promise<TaskInstruction> {
    const task = this.require(taskId);
    this.ensureMutable(task, "retry");
    const instruction = [...task.instructions]
      .reverse()
      .find((item) => item.status === "failed");
    if (!instruction) {
      throw new Error("This task has no failed instruction to retry");
    }
    instruction.status = "pending";
    instruction.dispatchAttempts = 0;
    delete instruction.dispatcherId;
    delete instruction.leaseUntil;
    delete instruction.lastError;
    task.taskState = "created";
    task.progress = {
      stage: "queued",
      message: "Retry queued for a connected Agent",
    };
    task.updatedAt = Date.now();
    await this.changed();
    return instruction;
  }

  async requestClarification(
    taskId: string,
    question: string,
    options?: string[],
  ): Promise<EditTask> {
    const task = this.require(taskId);
    this.ensureMutable(task, "request clarification for");
    task.clarification = { question, ...(options?.length ? { options } : {}) };
    task.taskState = "waitingForUser";
    task.updatedAt = Date.now();
    await this.changed();
    return task;
  }

  async cancelTask(taskId: string): Promise<EditTask> {
    return this.terminateTask(taskId, "cancelled", "Task cancelled by user");
  }

  async rejectTask(taskId: string): Promise<EditTask> {
    const task = this.require(taskId);
    if (task.revisions.length === 0) {
      throw new Error("This task has no candidate to reject");
    }
    return this.terminateTask(taskId, "rejected", "Candidate rejected by user");
  }

  async setState(
    taskId: string,
    taskState: EditTask["taskState"],
  ): Promise<EditTask> {
    const task = this.require(taskId);
    if (TERMINAL_STATES.has(task.taskState) && task.taskState !== taskState) {
      throw new Error(`Cannot change a task in state ${task.taskState}`);
    }
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

  private ensureMutable(task: EditTask, action: string): void {
    if (TERMINAL_STATES.has(task.taskState) || task.taskState === "applying") {
      throw new Error(`Cannot ${action} a task in state ${task.taskState}`);
    }
  }

  private async terminateTask(
    taskId: string,
    taskState: Extract<TerminalTaskState, "cancelled" | "rejected">,
    message: string,
  ): Promise<EditTask> {
    const task = this.require(taskId);
    if (task.taskState === taskState) {
      return task;
    }
    this.ensureMutable(task, taskState === "rejected" ? "reject" : "cancel");
    for (const instruction of task.instructions) {
      if (
        instruction.status === "pending" ||
        instruction.status === "dispatching"
      ) {
        instruction.status = "failed";
        instruction.lastError = message;
        delete instruction.dispatcherId;
        delete instruction.leaseUntil;
      }
    }
    task.taskState = taskState;
    task.progress = { stage: taskState, message };
    delete task.clarification;
    task.updatedAt = Date.now();
    await this.changed();
    return task;
  }

  private async changed(): Promise<void> {
    await this.state.update(STORAGE_KEY, this.list());
    this.changeEmitter.fire();
  }
}
