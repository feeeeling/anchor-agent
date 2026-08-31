import * as vscode from "vscode";
import type { TaskService } from "./task-service.js";

const HIDDEN_STATES = new Set(["applied", "rejected", "cancelled", "archived"]);

export class AnchorDecorations implements vscode.Disposable {
  private readonly normal = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.wordHighlightBackground"),
    overviewRulerColor: new vscode.ThemeColor(
      "editorOverviewRuler.infoForeground",
    ),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private readonly ready = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor(
      "editor.wordHighlightStrongBackground",
    ),
    overviewRulerColor: new vscode.ThemeColor("testing.iconPassed"),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private readonly warning = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editorWarning.background"),
    border: "1px solid",
    borderColor: new vscode.ThemeColor("editorWarning.foreground"),
    overviewRulerColor: new vscode.ThemeColor(
      "editorOverviewRuler.warningForeground",
    ),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly tasks: TaskService) {
    this.subscriptions = [
      tasks.onDidChange(() => this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
    ];
    this.refresh();
  }

  refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const groups = {
        normal: [] as vscode.DecorationOptions[],
        ready: [] as vscode.DecorationOptions[],
        warning: [] as vscode.DecorationOptions[],
      };
      const documentLength = editor.document.getText().length;
      for (const task of this.tasks.list()) {
        if (
          task.documentUri !== editor.document.uri.toString() ||
          HIDDEN_STATES.has(task.taskState)
        ) {
          continue;
        }
        const start = Math.min(Math.max(task.currentStart, 0), documentLength);
        const end = Math.min(Math.max(task.currentEnd, start), documentLength);
        const option: vscode.DecorationOptions = {
          range: new vscode.Range(
            editor.document.positionAt(start),
            editor.document.positionAt(end),
          ),
          hoverMessage: new vscode.MarkdownString(
            `**Anchor Agent** — ${task.taskState}\n\n${task.progress?.message ?? task.instruction}\n\n` +
              `[Review task](command:anchorAgent.reviewTask?${encodeURIComponent(JSON.stringify([task.id]))})`,
          ),
        };
        if (
          task.taskState === "conflicted" ||
          task.anchorState === "modified" ||
          task.anchorState === "orphaned"
        ) {
          groups.warning.push(option);
        } else if (task.taskState === "ready") {
          groups.ready.push(option);
        } else {
          groups.normal.push(option);
        }
      }
      editor.setDecorations(this.normal, groups.normal);
      editor.setDecorations(this.ready, groups.ready);
      editor.setDecorations(this.warning, groups.warning);
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.normal.dispose();
    this.ready.dispose();
    this.warning.dispose();
  }
}
