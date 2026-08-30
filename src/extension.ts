import * as vscode from "vscode";
import { BridgeServer } from "./bridge-server.js";
import { AnchorDecorations } from "./decorations.js";
import { DIFF_SCHEME, DiffContentProvider } from "./diff-content.js";
import { TaskService } from "./task-service.js";
import { TaskTreeProvider } from "./task-tree.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const tasks = new TaskService(context.workspaceState);
  const tree = new TaskTreeProvider(tasks);
  const decorations = new AnchorDecorations(tasks);
  const bridge = new BridgeServer(tasks);
  const diffProvider = new DiffContentProvider(tasks);

  context.subscriptions.push(
    tasks,
    tree,
    decorations,
    bridge,
    vscode.window.registerTreeDataProvider("anchorAgent.tasks", tree),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, diffProvider),
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
    vscode.commands.registerCommand("anchorAgent.createTask", () => createTask(tasks)),
    vscode.commands.registerCommand("anchorAgent.reviewTask", (value?: unknown) => reviewTask(tasks, value)),
    vscode.commands.registerCommand("anchorAgent.acceptTask", (value?: unknown) => acceptTask(tasks, value)),
    vscode.commands.registerCommand("anchorAgent.cancelTask", async (value?: unknown) => {
      const taskId = taskIdFrom(value);
      if (taskId) {
        await tasks.setState(taskId, "cancelled");
      }
    }),
  );

  try {
    await bridge.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showWarningMessage(`Anchor Agent MCP bridge did not start: ${message}`);
  }
}

async function createTask(tasks: TaskService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("Select a contiguous text range first.");
    return;
  }
  const instruction = await vscode.window.showInputBox({
    title: "Rewrite selection with Anchor Agent",
    prompt: "The initial agent context contains this selection only; it may read the file through MCP.",
    placeHolder: "Describe the desired change",
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) {
    return;
  }
  const task = await tasks.create(editor.document, editor.selection, instruction.trim());
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
    void vscode.window.showInformationMessage(
      `${task.taskState}: ${task.progress?.message ?? "No candidate revision has been submitted yet."}`,
    );
    return;
  }
  const revision = task.revisions.find((item) => item.id === task.activeRevisionId) ?? task.revisions.at(-1);
  if (!revision) {
    return;
  }
  const baseUri = vscode.Uri.from({ scheme: DIFF_SCHEME, authority: task.id, path: "/base" });
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
    "Keep reviewing",
  );
  if (action === "Accept") {
    await acceptTask(tasks, task.id);
  }
}

async function acceptTask(tasks: TaskService, value?: unknown): Promise<void> {
  const taskId = taskIdFrom(value);
  if (!taskId) {
    return;
  }
  const task = tasks.get(taskId);
  const revision = task?.revisions.find((item) => item.id === task.activeRevisionId);
  if (!task || !revision) {
    void vscode.window.showErrorMessage("No active candidate revision is available.");
    return;
  }
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(task.documentUri));
  const start = document.positionAt(task.currentStart);
  const end = document.positionAt(task.currentEnd);
  const range = new vscode.Range(start, end);
  const currentText = document.getText(range);
  if (currentText !== task.baseText || task.anchorState === "modified" || task.anchorState === "orphaned") {
    await tasks.setState(task.id, "conflicted");
    void vscode.window.showWarningMessage(
      "The anchored text changed after this task was created. Direct replacement was blocked.",
    );
    return;
  }
  await tasks.setState(task.id, "applying");
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, range, revision.replacement);
  const applied = await vscode.workspace.applyEdit(edit);
  await tasks.setState(task.id, applied ? "applied" : "failed");
  if (!applied) {
    void vscode.window.showErrorMessage("VS Code rejected the candidate edit.");
  }
}

function taskIdFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return undefined;
}
