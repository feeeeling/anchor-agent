import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { sha256 } from "./hash.js";
import {
  TaskServiceBase,
  TERMINAL_STATES,
  type InstructionClaim,
  type ClaimInstructionRequest,
} from "./task-service-base.js";
import type {
  EditTask,
  Revision,
  TaskInstruction,
} from "./types.js";

export type { InstructionClaim, ClaimInstructionRequest };
export { releaseInFlightDispatchLeases } from "./task-recovery.js";

export class TaskService extends TaskServiceBase {
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
    task.progress = {
      stage: "waitingForUser",
      message: question,
    };
    task.updatedAt = Date.now();
    await this.changed();
    return task;
  }

  /**
   * Returns a user clarification answer to the Agent via instruction continuation:
   * the open dispatching/pending turn is reused (or a new pending turn is created)
   * so claim_task / sampling can pick it up. Not a deferred MCP tool result.
   */
  async answerClarification(
    taskId: string,
    answer: string,
  ): Promise<TaskInstruction> {
    const task = this.require(taskId);
    if (task.taskState !== "waitingForUser" || !task.clarification) {
      throw new Error("This task is not waiting for a clarification answer");
    }
    const trimmed = answer.trim();
    if (!trimmed) {
      throw new Error("Clarification answer must not be empty");
    }
    const text = formatClarificationAnswerInstruction(
      task.clarification,
      trimmed,
    );
    const open = [...task.instructions]
      .reverse()
      .find(
        (item) =>
          item.status === "pending" || item.status === "dispatching",
      );
    const now = Date.now();
    let pending: TaskInstruction;
    if (open) {
      open.text = text;
      open.status = "pending";
      open.dispatchAttempts = 0;
      delete open.dispatcherId;
      delete open.leaseUntil;
      delete open.lastError;
      pending = open;
    } else {
      pending = {
        id: randomUUID(),
        text,
        status: "pending",
        dispatchAttempts: 0,
        createdAt: now,
        ...(task.activeRevisionId
          ? { parentRevisionId: task.activeRevisionId }
          : {}),
      };
      task.instructions.push(pending);
    }
    task.instruction = text;
    delete task.clarification;
    task.progress = {
      stage: "queued",
      message: "Clarification answered; waiting for a connected Agent",
    };
    task.taskState =
      task.anchorState === "modified" || task.anchorState === "orphaned"
        ? "conflicted"
        : "created";
    task.updatedAt = now;
    await this.changed();
    return pending;
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
}

export function formatClarificationAnswerInstruction(
  clarification: { question: string; options?: string[] },
  answer: string,
): string {
  const lines = [
    "Clarification answer from the user:",
    `Question: ${clarification.question}`,
  ];
  if (clarification.options?.length) {
    lines.push(`Options offered: ${clarification.options.join(" | ")}`);
  }
  lines.push(`Answer: ${answer}`);
  lines.push(
    "Continue the anchored edit using this answer. Do not ask the same clarification again unless still blocked.",
  );
  return lines.join("\n");
}
