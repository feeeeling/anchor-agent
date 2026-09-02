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
    panel.webview.html = renderHtml(nonce);
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

function renderHtml(nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    body { box-sizing: border-box; margin: 0 auto; max-width: 1000px; padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size)/1.5 var(--vscode-font-family); }
    header { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
    h1 { margin: 0; font-size: 1.3rem; }
    #status { white-space: nowrap; padding: 3px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 999px; }
    .muted { color: var(--vscode-descriptionForeground); }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    section { margin-top: 16px; }
    pre { min-height: 100px; max-height: 35vh; overflow: auto; margin: 6px 0 0; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); }
    textarea { box-sizing: border-box; width: 100%; min-height: 100px; resize: vertical; padding: 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); font: inherit; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    button { padding: 6px 12px; border: 1px solid transparent; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:disabled { cursor: default; opacity: .5; }
    #warnings, #error { color: var(--vscode-errorForeground); }
    #failure { display: none; margin-top: 12px; padding: 12px 14px; border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); border-radius: 6px; background: var(--vscode-inputValidation-errorBackground, transparent); color: var(--vscode-errorForeground); }
    #failure.visible { display: block; }
    #failure strong { display: block; margin-bottom: 6px; color: var(--vscode-errorForeground); }
    #stall { display: none; margin-top: 14px; padding: 12px 14px; border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-inputValidation-warningBackground, transparent); }
    #stall.visible { display: block; }
    #stall strong { display: block; margin-bottom: 4px; }
    #stall ul { margin: 8px 0 0; padding-left: 1.2rem; }
    #stall li { margin: 4px 0; }
    #clarification { display: none; margin-top: 16px; padding: 12px 14px; border: 1px solid var(--vscode-focusBorder, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-editorWidget-background, transparent); }
    #clarification.visible { display: block; }
    #clarification strong { display: block; margin-bottom: 6px; }
    #clarification-question { margin: 0 0 10px; white-space: pre-wrap; }
    #clarification-options { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    #clarification-options button { padding: 4px 10px; }
    #followup-section.hidden { display: none; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header><div><h1 id="title">Anchor Agent task</h1><div id="meta" class="muted"></div></div><span id="status">loading</span></header>
  <p id="progress" class="muted"></p>
  <section id="failure" role="alert" aria-live="assertive">
    <strong>Sampling / dispatch failed</strong>
    <div id="failure-message"></div>
  </section>
  <section id="stall" role="status" aria-live="polite">
    <strong>Dispatch has not started</strong>
    <p class="muted" style="margin:0">No Agent has claimed this instruction yet. Check the following:</p>
    <ul id="stall-list"></ul>
  </section>
  <section><strong>Instruction</strong><div id="instruction"></div><div id="summary" class="muted"></div><div id="warnings"></div></section>
  <div class="grid">
    <section><strong>Base</strong><pre id="base"></pre></section>
    <section><strong>Current Local</strong><pre id="local"></pre></section>
    <section><strong>Candidate</strong><pre id="candidate"></pre></section>
  </div>
  <div class="actions">
    <button id="accept">Accept candidate</button>
    <button id="reject" class="secondary">Reject candidate</button>
    <button id="copy" class="secondary">Copy candidate</button>
    <button id="diff" class="secondary">Open Diff</button>
    <button id="retry" class="secondary">Retry</button>
    <button id="cancel" class="secondary">Cancel task</button>
  </div>
  <div id="error" role="alert" aria-live="polite"></div>
  <section id="clarification" role="region" aria-label="Agent clarification">
    <strong>Agent needs clarification</strong>
    <p id="clarification-question"></p>
    <div id="clarification-options" class="actions"></div>
    <textarea id="clarification-answer" placeholder="Type your answer for the Agent."></textarea>
    <div class="actions"><button id="send-clarification">Send answer to Agent</button></div>
  </section>
  <section id="followup-section">
    <strong>Continue refining</strong>
    <textarea id="followup" placeholder="Describe what to change in the next candidate."></textarea>
    <div class="actions"><button id="continue">Send follow-up</button></div>
  </section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const byId = (id) => document.getElementById(id);
    let currentTask;
    const send = (type, extra = {}) => vscode.postMessage({ type, ...extra });
    byId('accept').addEventListener('click', () => send('accept'));
    byId('reject').addEventListener('click', () => send('reject'));
    byId('copy').addEventListener('click', () => send('copy'));
    byId('diff').addEventListener('click', () => send('openDiff'));
    byId('retry').addEventListener('click', () => send('retry'));
    byId('cancel').addEventListener('click', () => send('cancel'));
    byId('continue').addEventListener('click', () => send('continue', { instruction: byId('followup').value }));
    byId('followup').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        send('continue', { instruction: byId('followup').value });
      }
    });
    const sendClarification = () => send('answerClarification', { answer: byId('clarification-answer').value });
    byId('send-clarification').addEventListener('click', sendClarification);
    byId('clarification-answer').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendClarification();
      }
    });
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'validation') { byId('error').textContent = message.message; return; }
      if (message?.type === 'continued') { byId('followup').value = ''; byId('error').textContent = ''; return; }
      if (message?.type === 'clarificationAnswered') {
        byId('clarification-answer').value = '';
        byId('error').textContent = '';
        return;
      }
      if (message?.type !== 'task') return;
      currentTask = message.task;
      const task = currentTask;
      byId('title').textContent = task.title;
      byId('status').textContent = task.taskState + ' / ' + task.anchorState;
      byId('meta').textContent = task.revisionCount + ' revisions · ' + task.instructionCount + ' instructions · document v' + task.currentDocumentVersion;
      byId('progress').textContent = task.progress;
      const failure = byId('failure');
      const failureMessage = task.lastError || task.progress || '';
      byId('failure-message').textContent = failureMessage;
      if (task.showFailureError && failureMessage) {
        failure.classList.add('visible');
      } else {
        failure.classList.remove('visible');
      }
      byId('instruction').textContent = task.instruction;
      byId('summary').textContent = task.summary;
      byId('warnings').textContent = task.warnings.join('\\n');
      byId('base').textContent = task.baseText;
      byId('local').textContent = task.localText;
      byId('candidate').textContent = task.candidate || 'No candidate yet.';
      byId('accept').disabled = !task.canAccept;
      byId('reject').disabled = !task.canReject;
      byId('copy').disabled = !task.canCopy;
      byId('diff').disabled = !task.hasCandidate;
      byId('retry').disabled = !task.canRetry;
      byId('cancel').disabled = !task.canContinue;
      byId('continue').disabled = !task.canContinue || task.canAnswerClarification;
      byId('followup').disabled = !task.canContinue || task.canAnswerClarification;
      const followupSection = byId('followup-section');
      if (task.canAnswerClarification) {
        followupSection.classList.add('hidden');
      } else {
        followupSection.classList.remove('hidden');
      }
      const clarification = byId('clarification');
      const clarificationOptions = byId('clarification-options');
      clarificationOptions.replaceChildren();
      if (task.canAnswerClarification) {
        byId('clarification-question').textContent = task.clarificationQuestion;
        byId('send-clarification').disabled = false;
        byId('clarification-answer').disabled = false;
        if (Array.isArray(task.clarificationOptions)) {
          for (const option of task.clarificationOptions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'secondary';
            button.textContent = option;
            button.addEventListener('click', () => {
              byId('clarification-answer').value = option;
              send('answerClarification', { answer: option });
            });
            clarificationOptions.appendChild(button);
          }
        }
        clarification.classList.add('visible');
      } else {
        byId('clarification-question').textContent = '';
        byId('send-clarification').disabled = true;
        byId('clarification-answer').disabled = true;
        clarification.classList.remove('visible');
      }
      const stall = byId('stall');
      const stallList = byId('stall-list');
      stallList.replaceChildren();
      if (task.showStallHints && Array.isArray(task.stallHints) && task.stallHints.length) {
        for (const hint of task.stallHints) {
          const item = document.createElement('li');
          item.textContent = hint;
          stallList.appendChild(item);
        }
        stall.classList.add('visible');
      } else {
        stall.classList.remove('visible');
      }
    });
    send('ready');
  </script>
</body>
</html>`;
}
