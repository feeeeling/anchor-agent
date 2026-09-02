import * as vscode from "vscode";
import { transformAnchor } from "./anchor-range.js";
import { DIFF_SCHEME } from "./diff-content.js";
import { promptForInstruction } from "./instruction-panel.js";
import type { TaskDetailsPanelManager } from "./task-details-panel.js";
import type { TaskService } from "./task-service.js";
import { threeWayMerge } from "./three-way-merge.js";
import type { AnchorSpan } from "./types.js";

export async function createTask(
  tasks: TaskService,
  details: TaskDetailsPanelManager,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage(
      "Select a contiguous text range first.",
    );
    return;
  }
  const documentUri = editor.document.uri;
  let trackedRange: AnchorSpan = {
    start: editor.document.offsetAt(editor.selection.start),
    end: editor.document.offsetAt(editor.selection.end),
    state: "clean",
  };
  const selectedText = editor.document.getText(editor.selection);
  const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.toString() !== documentUri.toString()) {
      return;
    }
    trackedRange = transformAnchor(
      trackedRange,
      event.contentChanges.map((change) => ({
        rangeOffset: change.rangeOffset,
        rangeLength: change.rangeLength,
        text: change.text,
      })),
    );
  });
  const instruction = await promptForInstruction(selectedText).finally(() =>
    subscription.dispose(),
  );
  if (!instruction) {
    return;
  }
  const document = await vscode.workspace.openTextDocument(documentUri);
  if (
    trackedRange.state === "orphaned" ||
    trackedRange.end <= trackedRange.start
  ) {
    void vscode.window.showWarningMessage(
      "The selected text was removed while the instruction was open. Select it again.",
    );
    return;
  }
  const selection = new vscode.Selection(
    document.positionAt(trackedRange.start),
    document.positionAt(trackedRange.end),
  );
  const task = await tasks.create(document, selection, instruction);
  details.show(task.id);
  const action = await vscode.window.showInformationMessage(
    `Anchor task created: ${task.title}`,
    "Copy task ID",
  );
  if (action === "Copy task ID") {
    await vscode.env.clipboard.writeText(task.id);
  }
}

export function showTaskDetails(
  details: TaskDetailsPanelManager,
  value?: unknown,
): void {
  const taskId = taskIdFrom(value);
  if (taskId) {
    details.show(taskId);
  }
}

export async function openDiffTask(
  tasks: TaskService,
  value?: unknown,
): Promise<void> {
  const taskId = taskIdFrom(value);
  const task = taskId ? tasks.get(taskId) : undefined;
  const revision =
    task?.revisions.find((item) => item.id === task.activeRevisionId) ??
    task?.revisions.at(-1);
  if (!task || !revision) {
    void vscode.window.showInformationMessage(
      "No candidate revision is available yet.",
    );
    return;
  }
  const baseUri = vscode.Uri.from({
    scheme: DIFF_SCHEME,
    authority: task.id,
    path: "/base",
  });
  const candidateUri = vscode.Uri.from({
    scheme: DIFF_SCHEME,
    authority: task.id,
    path: "/candidate",
    query: new URLSearchParams({ revision: revision.id }).toString(),
  });
  await vscode.commands.executeCommand(
    "vscode.diff",
    baseUri,
    candidateUri,
    `Anchor Agent: ${task.title}`,
    { preview: true },
  );
}

export async function copyCandidate(
  tasks: TaskService,
  value?: unknown,
): Promise<void> {
  const taskId = taskIdFrom(value);
  const task = taskId ? tasks.get(taskId) : undefined;
  const revision =
    task?.revisions.find((item) => item.id === task.activeRevisionId) ??
    task?.revisions.at(-1);
  if (!revision) {
    void vscode.window.showInformationMessage(
      "No candidate revision is available yet.",
    );
    return;
  }
  await vscode.env.clipboard.writeText(revision.replacement);
  void vscode.window.showInformationMessage("Candidate copied to clipboard.");
}

export async function rejectTask(tasks: TaskService, value?: unknown): Promise<void> {
  const taskId = taskIdFrom(value);
  if (!taskId) {
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    "Reject this candidate and close the task?",
    { modal: true },
    "Reject candidate",
  );
  if (choice !== "Reject candidate") {
    return;
  }
  try {
    await tasks.rejectTask(taskId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
  }
}

export async function cancelTask(tasks: TaskService, value?: unknown): Promise<void> {
  const taskId = taskIdFrom(value);
  if (!taskId) {
    return;
  }
  try {
    await tasks.cancelTask(taskId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
  }
}

export async function retryTask(tasks: TaskService, value?: unknown): Promise<void> {
  const taskId = taskIdFrom(value);
  if (!taskId) {
    return;
  }
  try {
    await tasks.retryTask(taskId);
    void vscode.window.showInformationMessage("Anchor Agent retry queued.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
  }
}

export async function continueTask(
  tasks: TaskService,
  value?: unknown,
): Promise<void> {
  const taskId = taskIdFrom(value);
  if (!taskId || !tasks.get(taskId)) {
    void vscode.window.showErrorMessage(
      "Select an existing Anchor Agent task first.",
    );
    return;
  }
  const instruction = await vscode.window.showInputBox({
    title: "Continue refining candidate",
    prompt: "This instruction stays on the task's isolated logical branch.",
    placeHolder: "Describe what should change in the next candidate",
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) {
    return;
  }
  try {
    await tasks.continueTask(taskId, instruction.trim());
    void vscode.window.showInformationMessage(
      "Follow-up instruction queued for the connected agent.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
  }
}

export async function answerClarification(
  tasks: TaskService,
  value?: unknown,
): Promise<void> {
  const taskId = taskIdFrom(value);
  const task = taskId ? tasks.get(taskId) : undefined;
  if (!taskId || !task) {
    void vscode.window.showErrorMessage(
      "Select an existing Anchor Agent task first.",
    );
    return;
  }
  if (task.taskState !== "waitingForUser" || !task.clarification) {
    void vscode.window.showErrorMessage(
      "This task is not waiting for a clarification answer.",
    );
    return;
  }
  const answer = await vscode.window.showInputBox({
    title: "Answer Agent clarification",
    prompt: task.clarification.question,
    placeHolder: task.clarification.options?.join(" / ") || "Your answer",
    ignoreFocusOut: true,
  });
  if (!answer?.trim()) {
    return;
  }
  try {
    await tasks.answerClarification(taskId, answer.trim());
    void vscode.window.showInformationMessage(
      "Clarification answer queued for the connected agent.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(message);
  }
}

export async function acceptTask(tasks: TaskService, value?: unknown): Promise<void> {
  const taskId = taskIdFrom(value);
  if (!taskId) {
    return;
  }
  const task = tasks.get(taskId);
  const revision = task?.revisions.find(
    (item) => item.id === task.activeRevisionId,
  );
  if (!task || !revision) {
    void vscode.window.showErrorMessage(
      "No active candidate revision is available.",
    );
    return;
  }
  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.parse(task.documentUri),
  );
  const start = document.positionAt(task.currentStart);
  const end = document.positionAt(task.currentEnd);
  const range = new vscode.Range(start, end);
  const currentText = document.getText(range);
  const checkedVersion = document.version;
  if (currentText !== task.baseText || task.anchorState === "orphaned") {
    await handleChangedAnchor({
      tasks,
      taskId: task.id,
      document,
      currentText,
      remoteText: revision.replacement,
    });
    return;
  }
  await tasks.setState(task.id, "applying");
  if (
    document.version !== checkedVersion ||
    document.getText(range) !== task.baseText
  ) {
    await tasks.setState(task.id, "conflicted");
    void vscode.window.showWarningMessage(
      "The document changed while applying the candidate. No edit was made.",
    );
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, range, revision.replacement);
  const applied = await vscode.workspace.applyEdit(edit);
  await tasks.setState(task.id, applied ? "applied" : "failed");
  if (!applied) {
    void vscode.window.showErrorMessage("VS Code rejected the candidate edit.");
  }
}

interface ChangedAnchorContext {
  tasks: TaskService;
  taskId: string;
  document: vscode.TextDocument;
  currentText: string;
  remoteText: string;
}

async function handleChangedAnchor(
  context: ChangedAnchorContext,
): Promise<void> {
  const { tasks, taskId, document, currentText, remoteText } = context;
  const task = tasks.get(taskId);
  if (!task) {
    return;
  }
  await tasks.setState(task.id, "conflicted");
  const configuredPolicy = vscode.workspace
    .getConfiguration("anchorAgent")
    .get<string>("conflictPolicy", "prompt");
  let action: "merge" | "regenerate" | undefined;
  if (configuredPolicy === "autoMergeAndReview") {
    action = "merge";
  } else if (configuredPolicy === "regenerateOnChange") {
    action = "regenerate";
  } else {
    const selection = await vscode.window.showWarningMessage(
      "The anchored text changed. Choose how to preserve your local edits.",
      "Try automatic merge",
      "Regenerate from current text",
    );
    if (selection === "Try automatic merge") {
      action = "merge";
    } else if (selection === "Regenerate from current text") {
      action = "regenerate";
    }
  }

  if (action === "regenerate") {
    const originalInstruction = task.instruction;
    await tasks.rebaseTask(task.id, document);
    await tasks.continueTask(
      task.id,
      `Regenerate against the updated anchored text. Preserve this intent: ${originalInstruction}`,
    );
    void vscode.window.showInformationMessage(
      "The task was rebased and a new Agent revision was requested.",
    );
    return;
  }
  if (action !== "merge") {
    return;
  }

  const result = threeWayMerge(task.baseText, currentText, remoteText);
  if (result.conflicted) {
    void vscode.window.showWarningMessage(
      "Local and Agent edits overlap. Automatic merge was blocked; regenerate or keep editing manually.",
    );
    return;
  }
  const parentRevisionId = task.activeRevisionId;
  await tasks.rebaseTask(task.id, document);
  const mergedCandidate = {
    replacement: result.merged,
    summary:
      "Merged non-overlapping local and Agent changes; review before applying.",
    basedOnDocumentVersion: document.version,
  };
  if (parentRevisionId) {
    await tasks.submitRevision(task.id, {
      ...mergedCandidate,
      parentRevisionId,
    });
  } else {
    await tasks.submitRevision(task.id, mergedCandidate);
  }
  await vscode.commands.executeCommand("anchorAgent.reviewTask", task.id);
}

function taskIdFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string"
  ) {
    return value.id;
  }
  return undefined;
}
