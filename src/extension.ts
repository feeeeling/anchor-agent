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
    // Closing an editor must never delete persisted Anchor tasks.
    vscode.workspace.onDidCloseTextDocument((document) => {
      tasks.handleDocumentClosed(document.uri.toString());
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
      "anchorAgent.answerClarification",
      (value?: unknown) => answerClarification(tasks, value),
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
