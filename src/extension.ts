import * as vscode from "vscode";
import { BridgeServer } from "./bridge-server.js";
import { AnchorCodeLensProvider } from "./code-lenses.js";
import { AnchorDecorations } from "./decorations.js";
import { DIFF_SCHEME, DiffContentProvider } from "./diff-content.js";
import { TaskService } from "./task-service.js";
import { TaskTreeProvider } from "./task-tree.js";
import { threeWayMerge } from "./three-way-merge.js";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const tasks = new TaskService(context.workspaceState);
  const tree = new TaskTreeProvider(tasks);
  const codeLenses = new AnchorCodeLensProvider(tasks);
  const decorations = new AnchorDecorations(tasks);
  const bridge = new BridgeServer(tasks);
  const diffProvider = new DiffContentProvider(tasks);

  context.subscriptions.push(
    tasks,
    tree,
    codeLenses,
    decorations,
    bridge,
    vscode.window.registerTreeDataProvider("anchorAgent.tasks", tree),
    vscode.languages.registerCodeLensProvider(
      [{ scheme: "file" }, { scheme: "untitled" }],
      codeLenses,
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      DIFF_SCHEME,
      diffProvider,
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      void tasks.applyDocumentChanges(
        event.document.uri.toString(),
        event.contentChanges.map((change) => ({
          rangeOffset: change.rangeOffset,
          rangeLength: change.rangeLength,
          text: change.text,
        })),
      );
    }),
    vscode.commands.registerCommand("anchorAgent.createTask", () =>
      createTask(tasks),
    ),
    vscode.commands.registerCommand(
      "anchorAgent.reviewTask",
      (value?: unknown) => reviewTask(tasks, value),
    ),
    vscode.commands.registerCommand(
      "anchorAgent.acceptTask",
      (value?: unknown) => acceptTask(tasks, value),
    ),
    vscode.commands.registerCommand(
      "anchorAgent.continueTask",
      (value?: unknown) => continueTask(tasks, value),
    ),
    vscode.commands.registerCommand(
      "anchorAgent.retryTask",
      (value?: unknown) => retryTask(tasks, value),
    ),
    vscode.commands.registerCommand(
      "anchorAgent.cancelTask",
      async (value?: unknown) => {
        const taskId = taskIdFrom(value);
        if (taskId) {
          await tasks.setState(taskId, "cancelled");
        }
      },
    ),
  );

  try {
    await bridge.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(
      `Anchor Agent MCP bridge did not start: ${message}`,
    );
  }
}

async function createTask(tasks: TaskService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage(
      "Select a contiguous text range first.",
    );
    return;
  }
  const instruction = await vscode.window.showInputBox({
    title: "Rewrite selection with Anchor Agent",
    prompt:
      "The initial agent context contains this selection only; it may read the file through MCP.",
    placeHolder: "Describe the desired change",
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) {
    return;
  }
  const task = await tasks.create(
    editor.document,
    editor.selection,
    instruction.trim(),
  );
  const action = await vscode.window.showInformationMessage(
    `Anchor task created: ${task.title}`,
    "Copy task ID",
  );
  if (action === "Copy task ID") {
    await vscode.env.clipboard.writeText(task.id);
  }
}

async function reviewTask(tasks: TaskService, value?: unknown): Promise<void> {
  const taskId = taskIdFrom(value);
  if (!taskId) {
    return;
  }
  const task = tasks.get(taskId);
  if (!task) {
    void vscode.window.showErrorMessage("Anchor task no longer exists.");
    return;
  }
  if (task.revisions.length === 0) {
    const action = await vscode.window.showInformationMessage(
      `${task.taskState}: ${task.progress?.message ?? "No candidate revision has been submitted yet."}`,
      ...(task.taskState === "failed" ? ["Retry"] : []),
    );
    if (action === "Retry") {
      await retryTask(tasks, task.id);
    }
    return;
  }
  const revision =
    task.revisions.find((item) => item.id === task.activeRevisionId) ??
    task.revisions.at(-1);
  if (!revision) {
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
  const action = await vscode.window.showInformationMessage(
    revision.summary ?? "Candidate ready for review.",
    "Accept",
    "Continue refining",
    "Keep reviewing",
  );
  if (action === "Accept") {
    await acceptTask(tasks, task.id);
  } else if (action === "Continue refining") {
    await continueTask(tasks, task.id);
  }
}

async function retryTask(tasks: TaskService, value?: unknown): Promise<void> {
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

async function continueTask(
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
  await tasks.continueTask(taskId, instruction.trim());
  void vscode.window.showInformationMessage(
    "Follow-up instruction queued for the connected agent.",
  );
}

async function acceptTask(tasks: TaskService, value?: unknown): Promise<void> {
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
  await reviewTask(tasks, task.id);
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
