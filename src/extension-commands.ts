import * as vscode from "vscode";
import { transformAnchor } from "./anchor-range.js";
import { DIFF_SCHEME } from "./diff-content.js";
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
import type { TaskDetailsPanelManager } from "./task-details-panel.js";
import type { TaskService } from "./task-service.js";
import { threeWayMerge } from "./three-way-merge.js";
import type { AnchorSpan } from "./types.js";

export async function copyMcpConfiguration(
  context: vscode.ExtensionContext,
): Promise<void> {
  const selected =
    await vscode.window.showQuickPick<
      McpConfigurationQuickPickItem
    >(
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

  const destination =
    await vscode.window.showQuickPick<McpDestinationQuickPickItem>(
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
          description:
            "Merge into the user-global MCP config after preview + confirm",
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

export {
  createTask,
  showTaskDetails,
  openDiffTask,
  copyCandidate,
  rejectTask,
  cancelTask,
  retryTask,
  continueTask,
  answerClarification,
  acceptTask,
} from "./extension-task-commands.js";
