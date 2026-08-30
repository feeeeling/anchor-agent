import * as vscode from "vscode";
import type { TaskService } from "./task-service.js";
import type { EditTask } from "./types.js";

const HIDDEN_STATES = new Set(["applied", "rejected", "cancelled", "archived"]);

export class AnchorCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly tasks: TaskService) {
    this.subscription = tasks.onDidChange(() => this.emitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return buildCodeLenses(this.tasks.list(), document);
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

function buildCodeLenses(tasks: EditTask[], document: vscode.TextDocument): vscode.CodeLens[] {
  const documentLength = document.getText().length;
  const lenses: vscode.CodeLens[] = [];
  for (const task of tasks) {
    if (task.documentUri !== document.uri.toString() || HIDDEN_STATES.has(task.taskState)) {
      continue;
    }
    const offset = Math.min(Math.max(task.currentStart, 0), documentLength);
    const position = document.positionAt(offset);
    lenses.push(
      new vscode.CodeLens(new vscode.Range(position, position), {
        command: "anchorAgent.reviewTask",
        title: titleFor(task),
        tooltip: task.progress?.message ?? task.instruction,
        arguments: [task.id],
      }),
    );
  }
  return lenses;
}

function titleFor(task: EditTask): string {
  switch (task.taskState) {
    case "running":
      return `$(loading~spin) AI: ${task.progress?.message ?? "working…"}`;
    case "ready":
      return "$(sparkle) AI candidate ready — review";
    case "conflicted":
      return "$(warning) AI candidate conflicts with local edits";
    case "waitingForUser":
      return "$(question) AI needs clarification";
    case "failed":
      return "$(error) AI task failed";
    default:
      return "$(circle-outline) AI edit queued";
  }
}
