import * as vscode from "vscode";
import type { TaskService } from "./task-service.js";
import type { EditTask } from "./types.js";

export class TaskTreeProvider
  implements vscode.TreeDataProvider<EditTask>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<EditTask | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly tasks: TaskService) {
    this.subscription = tasks.onDidChange(() => this.emitter.fire(undefined));
  }

  getChildren(): EditTask[] {
    return this.tasks.list();
  }

  getTreeItem(task: EditTask): vscode.TreeItem {
    const item = new vscode.TreeItem(
      task.title,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = task.id;
    item.description = task.taskState;
    item.tooltip = new vscode.MarkdownString(
      `**${escapeMarkdown(task.title)}**\n\n${escapeMarkdown(task.instruction)}\n\n` +
        `State: \`${task.taskState}\` · Anchor: \`${task.anchorState}\` · Revisions: ${task.revisions.length}`,
    );
    item.iconPath = new vscode.ThemeIcon(iconFor(task));
    item.contextValue = `anchorTask.${task.taskState}`;
    item.command = {
      command: "anchorAgent.reviewTask",
      title: "Review task",
      arguments: [task.id],
    };
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

function iconFor(task: EditTask): string {
  switch (task.taskState) {
    case "running":
    case "queued":
      return "loading~spin";
    case "ready":
      return "sparkle";
    case "conflicted":
    case "orphaned":
    case "failed":
      return "warning";
    case "applied":
      return "check";
    case "cancelled":
    case "rejected":
      return "circle-slash";
    default:
      return "circle-outline";
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+.!|~-]/g, "\\$&");
}
