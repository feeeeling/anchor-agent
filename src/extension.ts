import * as vscode from "vscode";
import { transformAnchor } from "./anchor-range.js";
import { BridgeServer } from "./bridge-server.js";
import { AnchorCodeLensProvider } from "./code-lenses.js";
import { AnchorDecorations } from "./decorations.js";
import { DIFF_SCHEME, DiffContentProvider } from "./diff-content.js";
import { promptForInstruction } from "./instruction-panel.js";
import {
  buildMcpConfigDiffPreview,
  createMcpConfiguration,
  mergeMcpConfiguration,
  parseMcpConfigurationText,
  serializeMcpConfiguration,
  type McpConfigurationTarget,
  type McpHostConfiguration,
} from "./mcp-config.js";
import * as os from "node:os";
import * as path from "node:path";
import { TaskDetailsPanelManager } from "./task-details-panel.js";
import { TaskService } from "./task-service.js";
import { TaskTreeProvider } from "./task-tree.js";
import { threeWayMerge } from "./three-way-merge.js";
import type { AnchorSpan } from "./types.js";

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const tasks = new TaskService(context.workspaceState);
  const tree = new TaskTreeProvider(tasks);
  const codeLenses = new AnchorCodeLensProvider(tasks);
  const decorations = new AnchorDecorations(tasks);
  const bridge = new BridgeServer(tasks);
  const details = new TaskDetailsPanelManager(tasks);
  const diffProvider = new DiffContentProvider(tasks);

  context.subscriptions.push(
    tasks,
    tree,
    codeLenses,
    decorations,
    bridge,
    details,
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
      createTask(tasks, details),
    ),
    vscode.commands.registerCommand(
      "anchorAgent.reviewTask",
      (value?: unknown) => showTaskDetails(details, value),
    ),
    vscode.commands.registerCommand("anchorAgent.openDiff", (value?: unknown) =>
      openDiffTask(tasks, value),
    ),
    vscode.commands.registerCommand(
      "anchorAgent.acceptTask",
      (value?: unknown) => acceptTask(tasks, value),
    ),
    vscode.commands.registerCommand(
      "anchorAgent.rejectTask",
      (value?: unknown) => rejectTask(tasks, value),
    ),
    vscode.commands.registerCommand(
      "anchorAgent.copyCandidate",
      (value?: unknown) => copyCandidate(tasks, value),
    ),
    vscode.commands.registerCommand(
      "anchorAgent.continueTask",
      (value?: unknown) => continueTask(tasks, value),
    ),
    vscode.commands.registerCommand(
      "anchorAgent.retryTask",
      (value?: unknown) => retryTask(tasks, value),
    ),
    vscode.commands.registerCommand("anchorAgent.copyMcpConfig", () =>
      copyMcpConfiguration(context),
    ),
    vscode.commands.registerCommand(
      "anchorAgent.cancelTask",
      (value?: unknown) => cancelTask(tasks, value),
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

interface McpConfigurationQuickPickItem extends vscode.QuickPickItem {
  target: McpConfigurationTarget;
}

type McpConfigDestination =
  | { kind: "clipboard" }
  | { kind: "workspace" }
  | { kind: "user" };

interface McpDestinationQuickPickItem extends vscode.QuickPickItem {
  destination: McpConfigDestination;
}

async function copyMcpConfiguration(
  context: vscode.ExtensionContext,
): Promise<void> {
  const selected =
    await vscode.window.showQuickPick<McpConfigurationQuickPickItem>(
      [
        {
          label: "Pi",
          description: "Keep-alive connection with user-approved MCP Sampling",
          target: "pi",
        },
        {
          label: "Standard MCP host",
          description: "Portable stdio server configuration",
          target: "standard",
        },
      ],
      { placeHolder: "Choose the MCP host configuration" },
    );
  if (!selected) {
    return;
  }

  const destination = await vscode.window.showQuickPick<McpDestinationQuickPickItem>(
    [
      {
        label: "Copy to clipboard only",
        description: "Do not write any file",
        destination: { kind: "clipboard" },
      },
      {
        label: "Write workspace .mcp.json",
        description: "Merge into the open workspace after preview + confirm",
        destination: { kind: "workspace" },
      },
      {
        label: "Write ~/.config/mcp/mcp.json",
        description: "Merge into the user-global MCP config after preview + confirm",
        destination: { kind: "user" },
      },
    ],
    { placeHolder: "Choose how to apply the MCP configuration" },
  );
  if (!destination) {
    return;
  }

  const serverPath = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "mcp-server.cjs",
  ).fsPath;
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const configuration = createMcpConfiguration(
    serverPath,
    workspacePath,
    selected.target,
  );

  if (destination.destination.kind === "clipboard") {
    await vscode.env.clipboard.writeText(
      serializeMcpConfiguration(configuration).trimEnd(),
    );
    const nextStep =
      selected.target === "pi"
        ? "Save it as .mcp.json or ~/.config/mcp/mcp.json, then run /reload in Pi."
        : "Paste it into your MCP host configuration and restart the host.";
    void vscode.window.showInformationMessage(
      `Anchor Agent MCP configuration copied. ${nextStep}`,
    );
    return;
  }

  await writeMcpConfigurationWithConfirm(
    configuration,
    destination.destination,
    selected.target,
  );
}

async function writeMcpConfigurationWithConfirm(
  incoming: McpHostConfiguration,
  destination: Exclude<McpConfigDestination, { kind: "clipboard" }>,
  target: McpConfigurationTarget,
): Promise<void> {
  let targetPath: string;
  let fileLabel: string;
  if (destination.kind === "workspace") {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      void vscode.window.showErrorMessage(
        "Open a workspace folder before writing .mcp.json.",
      );
      return;
    }
    targetPath = path.join(workspaceFolder, ".mcp.json");
    fileLabel = ".mcp.json";
  } else {
    targetPath = path.join(os.homedir(), ".config", "mcp", "mcp.json");
    fileLabel = "~/.config/mcp/mcp.json";
  }

  const targetUri = vscode.Uri.file(targetPath);
  let existingText = "";
  let fileExisted = false;
  try {
    const bytes = await vscode.workspace.fs.readFile(targetUri);
    existingText = Buffer.from(bytes).toString("utf8");
    fileExisted = true;
  } catch {
    existingText = "";
  }

  let existing: unknown;
  try {
    existing = parseMcpConfigurationText(existingText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      `Existing MCP config at ${fileLabel} is not valid JSON: ${message}`,
    );
    return;
  }

  const merged = mergeMcpConfiguration(existing, incoming);
  const afterText = serializeMcpConfiguration(merged);
  const beforeText =
    existingText.length === 0
      ? ""
      : existingText.endsWith("\n")
        ? existingText
        : `${existingText}\n`;
  const preview = buildMcpConfigDiffPreview(beforeText, afterText, fileLabel);

  if (preview.startsWith("No changes")) {
    void vscode.window.showInformationMessage(
      `${fileLabel} already contains the Anchor Agent MCP configuration.`,
    );
    return;
  }

  await showMcpConfigDiffDocuments(beforeText, afterText, fileLabel);

  const summary = fileExisted
    ? `Merge Anchor Agent into existing ${fileLabel}? Other MCP servers are preserved.`
    : `Create ${fileLabel} with the Anchor Agent MCP configuration?`;
  const confirm = await vscode.window.showWarningMessage(
    summary,
    { modal: true, detail: preview.slice(0, 1_500) },
    "Write file",
  );
  if (confirm !== "Write file") {
    return;
  }

  if (destination.kind === "user") {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(targetPath)),
    );
  }

  await vscode.workspace.fs.writeFile(
    targetUri,
    Buffer.from(afterText, "utf8"),
  );

  const reloadHint =
    target === "pi"
      ? " Run /reload in Pi to load the updated configuration."
      : " Restart the MCP host if it does not reload automatically.";
  void vscode.window.showInformationMessage(
    `Wrote Anchor Agent MCP configuration to ${fileLabel}.${reloadHint}`,
  );
}

async function showMcpConfigDiffDocuments(
  beforeText: string,
  afterText: string,
  fileLabel: string,
): Promise<void> {
  const beforeDoc = await vscode.workspace.openTextDocument({
    language: "json",
    content: beforeText.length === 0 ? "\n" : beforeText,
  });
  const afterDoc = await vscode.workspace.openTextDocument({
    language: "json",
    content: afterText,
  });
  await vscode.commands.executeCommand(
    "vscode.diff",
    beforeDoc.uri,
    afterDoc.uri,
    `Anchor Agent MCP: ${fileLabel} (current → proposed)`,
    { preview: true },
  );
}

async function createTask(
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

function showTaskDetails(
  details: TaskDetailsPanelManager,
  value?: unknown,
): void {
  const taskId = taskIdFrom(value);
  if (taskId) {
    details.show(taskId);
  }
}

async function openDiffTask(
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

async function copyCandidate(
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

async function rejectTask(tasks: TaskService, value?: unknown): Promise<void> {
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

async function cancelTask(tasks: TaskService, value?: unknown): Promise<void> {
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
