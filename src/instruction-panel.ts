import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

const MAX_INSTRUCTION_LENGTH = 20_000;
const MAX_PREVIEW_LENGTH = 1_200;

interface PanelMessage {
  type: "submit" | "cancel";
  instruction?: string;
}

export function promptForInstruction(
  selectionText: string,
): Promise<string | undefined> {
  const panel = vscode.window.createWebviewPanel(
    "anchorAgent.instruction",
    "Anchor Agent instruction",
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: false },
  );
  const nonce = randomBytes(16).toString("base64url");
  panel.webview.html = renderHtml(nonce, selectionText);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
      panel.dispose();
    };
    panel.onDidDispose(() => finish(undefined));
    panel.webview.onDidReceiveMessage((value: unknown) => {
      const message = decodeMessage(value);
      if (!message) {
        return;
      }
      if (message.type === "cancel") {
        finish(undefined);
        return;
      }
      const instruction = message.instruction?.trim() ?? "";
      if (!instruction || instruction.length > MAX_INSTRUCTION_LENGTH) {
        void panel.webview.postMessage({
          type: "validation",
          message: instruction
            ? `Instruction must be at most ${MAX_INSTRUCTION_LENGTH.toLocaleString()} characters.`
            : "Enter an instruction before starting the task.",
        });
        return;
      }
      finish(instruction);
    });
  });
}

function decodeMessage(value: unknown): PanelMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.type !== "submit" && candidate.type !== "cancel") {
    return undefined;
  }
  if (
    candidate.instruction !== undefined &&
    typeof candidate.instruction !== "string"
  ) {
    return undefined;
  }
  return {
    type: candidate.type,
    ...(typeof candidate.instruction === "string"
      ? { instruction: candidate.instruction }
      : {}),
  };
}

function renderHtml(nonce: string, selectionText: string): string {
  const preview =
    selectionText.length > MAX_PREVIEW_LENGTH
      ? `${selectionText.slice(0, MAX_PREVIEW_LENGTH)}\n…`
      : selectionText;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    body { box-sizing: border-box; max-width: 900px; margin: 0 auto; padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size)/1.5 var(--vscode-font-family); }
    h1 { margin: 0 0 4px; font-size: 1.35rem; }
    .hint { margin: 0 0 18px; color: var(--vscode-descriptionForeground); }
    label { display: block; margin-bottom: 6px; font-weight: 600; }
    textarea { box-sizing: border-box; width: 100%; min-height: 180px; resize: vertical; padding: 10px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); font: inherit; }
    textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    details { margin: 18px 0; }
    pre { max-height: 240px; overflow: auto; white-space: pre-wrap; padding: 10px; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
    button { padding: 7px 14px; border: 1px solid transparent; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    #error { min-height: 1.5em; margin-top: 6px; color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <h1>Rewrite selected text</h1>
  <p class="hint">The Agent initially receives only this selection. It may request read-only file context through MCP.</p>
  <label for="instruction">Instruction</label>
  <textarea id="instruction" autofocus maxlength="${MAX_INSTRUCTION_LENGTH}" placeholder="Describe the desired change. Use multiple lines if needed."></textarea>
  <div id="error" role="alert" aria-live="polite"></div>
  <details>
    <summary>Selected text (${selectionText.length.toLocaleString()} characters)</summary>
    <pre>${escapeHtml(preview)}</pre>
  </details>
  <div class="actions">
    <button id="cancel" class="secondary" type="button">Cancel</button>
    <button id="submit" type="button">Start Agent task</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const instruction = document.getElementById('instruction');
    const error = document.getElementById('error');
    document.getElementById('submit').addEventListener('click', () => {
      vscode.postMessage({ type: 'submit', instruction: instruction.value });
    });
    document.getElementById('cancel').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
    instruction.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        vscode.postMessage({ type: 'submit', instruction: instruction.value });
      }
    });
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'validation') {
        error.textContent = event.data.message;
      }
    });
    instruction.focus();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
