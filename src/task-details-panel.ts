import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  STALL_HINT_CHECKLIST,
  isDispatchNeverStarted,
  shouldShowStallHints,
  stallHintDelayRemaining,
} from "./stall-hints.js";
import type { TaskService } from "./task-service.js";
import type { EditTask } from "./types.js";
import { renderTaskDetailsHtml } from "./task-details-html.js";

const TERMINAL_STATES = new Set([
  "applied",
  "cancelled",
  "rejected",
  "archived",
]);

interface PanelMessage {
  type:
    | "ready"
    | "accept"
    | "reject"
    | "copy"
    | "openDiff"
    | "continue"
    | "retry"
    | "cancel"
    | "answerClarification";
  instruction?: string;
  answer?: string;
}

interface PanelEntry {
  panel: vscode.WebviewPanel;
  stallTimer: NodeJS.Timeout | undefined;
}

export class TaskDetailsPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, PanelEntry>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly tasks: TaskService) {
    this.subscription = tasks.onDidChange(() => this.refresh());
  }

  show(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      void vscode.window.showErrorMessage("Anchor task no longer exists.");
      return;
    }
    const existing = this.panels.get(taskId);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside, false);
      void this.update(existing.panel, task);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "anchorAgent.taskDetails",
      `Anchor Agent: ${task.title}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const nonce = randomBytes(16).toString("base64url");
    panel.webview.html = renderTaskDetailsHtml(nonce);
    this.panels.set(taskId, { panel, stallTimer: undefined });
    panel.onDidDispose(() => {
      this.clearStallTimer(taskId);
      this.panels.delete(taskId);
    });
    panel.webview.onDidReceiveMessage((value: unknown) => {
      void this.handleMessage(taskId, value);
    });
    void this.update(panel, task);
  }

  dispose(): void {
    this.subscription.dispose();
    for (const taskId of [...this.panels.keys()]) {
      this.clearStallTimer(taskId);
    }
    for (const entry of this.panels.values()) {
      entry.panel.dispose();
    }
    this.panels.clear();
  }

  private refresh(): void {
    for (const [taskId, entry] of this.panels) {
      const task = this.tasks.get(taskId);
      if (task) {
        void this.update(entry.panel, task);
      } else {
        this.clearStallTimer(taskId);
        entry.panel.dispose();
      }
    }
  }

  private clearStallTimer(taskId: string): void {
    const entry = this.panels.get(taskId);
    if (!entry?.stallTimer) {
      return;
    }
    clearTimeout(entry.stallTimer);
    entry.stallTimer = undefined;
  }

  private scheduleStallRefresh(taskId: string, task: EditTask): void {
    const entry = this.panels.get(taskId);
    if (!entry) {
      return;
    }
    this.clearStallTimer(taskId);
    if (!isDispatchNeverStarted(task)) {
      return;
    }
    const remaining = stallHintDelayRemaining(task);
    if (remaining === undefined || remaining === 0) {
      return;
    }
    entry.stallTimer = setTimeout(() => {
      const current = this.panels.get(taskId);
      const latest = this.tasks.get(taskId);
      if (!current || !latest) {
        return;
      }
      current.stallTimer = undefined;
      void this.update(current.panel, latest);
    }, remaining);
    entry.stallTimer.unref?.();
  }

  private async update(
    panel: vscode.WebviewPanel,
    task: EditTask,
  ): Promise<void> {
    const revision =
      task.revisions.find((item) => item.id === task.activeRevisionId) ??
      task.revisions.at(-1);
    let localText = task.baseText;
    let currentDocumentVersion = task.baseDocumentVersion;
    try {
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(task.documentUri),
      );
      const range = new vscode.Range(
        document.positionAt(task.currentStart),
        document.positionAt(task.currentEnd),
      );
      localText = document.getText(range);
      currentDocumentVersion = document.version;
    } catch {
      // Keep the last stable Base visible when the document cannot be opened.
    }
    if (!this.panels.has(task.id)) {
      return;
    }
    this.scheduleStallRefresh(task.id, task);
    const showStallHints = shouldShowStallHints(task);
    try {
      await panel.webview.postMessage({
        type: "task",
        task: {
          id: task.id,
          title: task.title,
          taskState: task.taskState,
          anchorState: task.anchorState,
          instruction: task.instruction,
          progress: task.progress?.message ?? "",
          lastError: latestFailedInstruction(task)?.lastError ?? "",
          showFailureError:
            task.taskState === "failed" ||
            Boolean(latestFailedInstruction(task)?.lastError),
          baseText: task.baseText,
          localText,
          currentDocumentVersion,
          candidate: revision?.replacement ?? "",
          summary: revision?.summary ?? "",
          warnings: revision?.warnings ?? [],
          revisionCount: task.revisions.length,
          instructionCount: task.instructions.length,
          hasCandidate: revision !== undefined,
          canAccept:
            revision !== undefined &&
            !TERMINAL_STATES.has(task.taskState) &&
            task.taskState !== "applying",
          canReject:
            revision !== undefined &&
            !TERMINAL_STATES.has(task.taskState) &&
            task.taskState !== "applying",
          canCopy: revision !== undefined,
          canContinue:
            !TERMINAL_STATES.has(task.taskState) &&
            task.taskState !== "applying",
          canRetry:
            !TERMINAL_STATES.has(task.taskState) &&
            task.taskState !== "applying" &&
            task.instructions.some((item) => item.status === "failed"),
          waitingForUser: task.taskState === "waitingForUser",
          clarificationQuestion: task.clarification?.question ?? "",
          clarificationOptions: task.clarification?.options ?? [],
          canAnswerClarification:
            task.taskState === "waitingForUser" &&
            Boolean(task.clarification?.question),
          showStallHints,
          stallHints: showStallHints ? [...STALL_HINT_CHECKLIST] : [],
        },
      });
    } catch {
      // The panel can close while the current document is being read.
    }
  }

  private async handleMessage(taskId: string, value: unknown): Promise<void> {
    const message = decodeMessage(value);
    if (!message) {
      return;
    }
    if (message.type === "ready") {
      const entry = this.panels.get(taskId);
      const task = this.tasks.get(taskId);
      if (entry && task) {
        void this.update(entry.panel, task);
      }
      return;
    }
    if (message.type === "accept") {
      await vscode.commands.executeCommand("anchorAgent.acceptTask", taskId);
      return;
    }
    if (message.type === "reject") {
      await vscode.commands.executeCommand("anchorAgent.rejectTask", taskId);
      return;
    }
    if (message.type === "copy") {
      await vscode.commands.executeCommand("anchorAgent.copyCandidate", taskId);
      return;
    }
    if (message.type === "openDiff") {
      await vscode.commands.executeCommand("anchorAgent.openDiff", taskId);
      return;
    }
    if (message.type === "cancel") {
      await vscode.commands.executeCommand("anchorAgent.cancelTask", taskId);
      return;
    }
    if (message.type === "retry") {
      try {
        await this.tasks.retryTask(taskId);
      } catch (error) {
        await this.showError(taskId, error);
      }
      return;
    }
    if (message.type === "answerClarification") {
      const answer = message.answer?.trim() ?? "";
      if (!answer) {
        await this.post(taskId, {
          type: "validation",
          message: "Enter an answer for the Agent.",
        });
        return;
      }
      try {
        await this.tasks.answerClarification(taskId, answer);
        await this.post(taskId, { type: "clarificationAnswered" });
      } catch (error) {
        await this.showError(taskId, error);
      }
      return;
    }
    const instruction = message.instruction?.trim() ?? "";
    if (!instruction) {
      await this.post(taskId, {
        type: "validation",
        message: "Enter a follow-up instruction.",
      });
      return;
    }
    try {
      await this.tasks.continueTask(taskId, instruction);
      await this.post(taskId, { type: "continued" });
    } catch (error) {
      await this.showError(taskId, error);
    }
  }

  private async showError(taskId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.post(taskId, { type: "validation", message });
  }

  private async post(taskId: string, message: unknown): Promise<void> {
    await this.panels.get(taskId)?.panel.webview.postMessage(message);
  }
}

function latestFailedInstruction(task: EditTask) {
  for (let index = task.instructions.length - 1; index >= 0; index -= 1) {
    const instruction = task.instructions[index];
    if (instruction?.status === "failed" && instruction.lastError) {
      return instruction;
    }
  }
  return undefined;
}

function decodeMessage(value: unknown): PanelMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const supported = [
    "ready",
    "accept",
    "reject",
    "copy",
    "openDiff",
    "continue",
    "retry",
    "cancel",
    "answerClarification",
  ];
  if (
    typeof candidate.type !== "string" ||
    !supported.includes(candidate.type)
  ) {
    return undefined;
  }
  if (
    candidate.instruction !== undefined &&
    typeof candidate.instruction !== "string"
  ) {
    return undefined;
  }
  if (
    candidate.answer !== undefined &&
    typeof candidate.answer !== "string"
  ) {
    return undefined;
  }
  return {
    type: candidate.type as PanelMessage["type"],
    ...(typeof candidate.instruction === "string"
      ? { instruction: candidate.instruction }
      : {}),
    ...(typeof candidate.answer === "string" ? { answer: candidate.answer } : {}),
  };
}
