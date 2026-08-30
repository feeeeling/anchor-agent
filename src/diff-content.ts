import type * as vscode from "vscode";
import type { TaskService } from "./task-service.js";

export const DIFF_SCHEME = "anchor-agent-content";

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly tasks: TaskService) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    const taskId = uri.authority;
    const task = this.tasks.get(taskId);
    if (!task) {
      return "Task no longer exists.";
    }
    if (uri.path === "/base") {
      return task.baseText;
    }
    const revisionId = new URLSearchParams(uri.query).get("revision");
    const revision = task.revisions.find((item) => item.id === revisionId);
    return revision?.replacement ?? "Candidate revision no longer exists.";
  }
}
