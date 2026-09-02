import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { transformAnchor } from "./anchor-range.js";
import { sha256 } from "./hash.js";
import { newLogicalBranchId } from "./session-branch.js";
import { releaseInFlightDispatchLeases } from "./task-recovery.js";
export { releaseInFlightDispatchLeases } from "./task-recovery.js";

import type {
  EditTask,
  Revision,
  TaskInstruction,
  TaskProgress,
  TextChange,
} from "./types.js";

const STORAGE_KEY = "anchorAgent.tasks.v1";
type TerminalTaskState = "applied" | "rejected" | "cancelled" | "archived";

export const TERMINAL_STATES = new Set<EditTask["taskState"]>([
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
  branchMode?: "native" | "logical";
}

export class TaskServiceBase implements vscode.Disposable {
  protected readonly tasks = new Map<string, EditTask>();
  protected readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(protected readonly state: vscode.Memento) {
    let restoredDirty = false;
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
        restoredDirty = true;
      }
      for (const instruction of task.instructions) {
        instruction.dispatchAttempts ??= 0;
      }
      if (releaseInFlightDispatchLeases(task)) {
        restoredDirty = true;
      }
      this.tasks.set(task.id, task);
    }
    if (restoredDirty) {
      // Persist lease releases so a second activate stays claimable.
      void this.changed();
    }
  }

  /**
   * Closing a text document / editor must not drop Anchor tasks.
   * Tasks remain keyed by documentUri in memory and workspaceState;
   * Local reads reopen the URI when the file is available again.
   */
  handleDocumentClosed(documentUri: string): EditTask[] {
    return this.list().filter((task) => task.documentUri === documentUri);
  }

  /** Tasks that remain claimable, reviewable, or waiting after recovery. */
  listContinuable(): EditTask[] {
    return this.list().filter((task) => {
      if (TERMINAL_STATES.has(task.taskState) || task.taskState === "orphaned") {
        return false;
      }
      if (
        task.taskState === "waitingForUser" ||
        task.taskState === "ready" ||
        task.taskState === "conflicted"
      ) {
        return true;
      }
      return task.instructions.some(
        (item) =>
          item.status === "pending" ||
          item.status === "dispatching" ||
          item.status === "failed",
      );
    });
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
      branchId: newLogicalBranchId(),
      branchMode: "logical",
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

  async bindBranch(
    taskId: string,
    branch: {
      branchMode: "native" | "logical";
      sourceSessionId?: string;
      sourceNodeId?: string;
    },
  ): Promise<EditTask> {
    const task = this.require(taskId);
    this.ensureMutable(task, "bind a branch for");
    task.branchMode = branch.branchMode;
    if (branch.sourceSessionId) {
      task.sourceSessionId = branch.sourceSessionId;
    }
    if (branch.sourceNodeId) {
      task.sourceNodeId = branch.sourceNodeId;
    }
    task.updatedAt = Date.now();
    await this.changed();
    return task;
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
        task.taskState === "orphaned" ||
        task.taskState === "waitingForUser"
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
        if (request.branchMode === "native" || request.branchMode === "logical") {
          task.branchMode = request.branchMode;
        } else if (!task.branchMode) {
          // Claims without adapter metadata stay on the logical branch.
          task.branchMode = "logical";
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
          message: `${message} Automatic retry ${instruction.dispatchAttempts}/3…`,
        };
      } else {
        instruction.status = "failed";
        delete instruction.leaseUntil;
        task.taskState = "failed";
        // Keep the actionable sampling/bridge message on final failure (panel + lastError).
        task.progress = { stage: "failed", message };
      }
      task.updatedAt = Date.now();
      await this.changed();
      return;
    }
    throw new Error(`Unknown instruction: ${instructionId}`);
  }

  publicView(task: EditTask): Omit<EditTask, "documentSnapshot"> {
    const { documentSnapshot: _, ...publicTask } = task;
    return publicTask;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  protected require(taskId: string): EditTask {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    return task;
  }

  protected ensureMutable(task: EditTask, action: string): void {
    if (TERMINAL_STATES.has(task.taskState) || task.taskState === "applying") {
      throw new Error(`Cannot ${action} a task in state ${task.taskState}`);
    }
  }

  protected async terminateTask(
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

  protected async changed(): Promise<void> {
    await this.state.update(STORAGE_KEY, this.list());
    this.changeEmitter.fire();
  }
}
