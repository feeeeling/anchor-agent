export function renderTaskDetailsHtml(nonce: string): string {

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    body { box-sizing: border-box; margin: 0 auto; max-width: 1000px; padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-size)/1.5 var(--vscode-font-family); }
    header { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
    h1 { margin: 0; font-size: 1.3rem; }
    #status { white-space: nowrap; padding: 3px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 999px; }
    .muted { color: var(--vscode-descriptionForeground); }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    section { margin-top: 16px; }
    pre { min-height: 100px; max-height: 35vh; overflow: auto; margin: 6px 0 0; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); }
    textarea { box-sizing: border-box; width: 100%; min-height: 100px; resize: vertical; padding: 9px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); font: inherit; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    button { padding: 6px 12px; border: 1px solid transparent; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    button:disabled { cursor: default; opacity: .5; }
    #warnings, #error { color: var(--vscode-errorForeground); }
    #failure { display: none; margin-top: 12px; padding: 12px 14px; border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); border-radius: 6px; background: var(--vscode-inputValidation-errorBackground, transparent); color: var(--vscode-errorForeground); }
    #failure.visible { display: block; }
    #failure strong { display: block; margin-bottom: 6px; color: var(--vscode-errorForeground); }
    #stall { display: none; margin-top: 14px; padding: 12px 14px; border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-inputValidation-warningBackground, transparent); }
    #stall.visible { display: block; }
    #stall strong { display: block; margin-bottom: 4px; }
    #stall ul { margin: 8px 0 0; padding-left: 1.2rem; }
    #stall li { margin: 4px 0; }
    #clarification { display: none; margin-top: 16px; padding: 12px 14px; border: 1px solid var(--vscode-focusBorder, var(--vscode-panel-border)); border-radius: 6px; background: var(--vscode-editorWidget-background, transparent); }
    #clarification.visible { display: block; }
    #clarification strong { display: block; margin-bottom: 6px; }
    #clarification-question { margin: 0 0 10px; white-space: pre-wrap; }
    #clarification-options { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    #clarification-options button { padding: 4px 10px; }
    #followup-section.hidden { display: none; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header><div><h1 id="title">Anchor Agent task</h1><div id="meta" class="muted"></div></div><span id="status">loading</span></header>
  <p id="progress" class="muted"></p>
  <section id="failure" role="alert" aria-live="assertive">
    <strong>Sampling / dispatch failed</strong>
    <div id="failure-message"></div>
  </section>
  <section id="stall" role="status" aria-live="polite">
    <strong>Dispatch has not started</strong>
    <p class="muted" style="margin:0">No Agent has claimed this instruction yet. Check the following:</p>
    <ul id="stall-list"></ul>
  </section>
  <section><strong>Instruction</strong><div id="instruction"></div><div id="summary" class="muted"></div><div id="warnings"></div></section>
  <div class="grid">
    <section><strong>Base</strong><pre id="base"></pre></section>
    <section><strong>Current Local</strong><pre id="local"></pre></section>
    <section><strong>Candidate</strong><pre id="candidate"></pre></section>
  </div>
  <div class="actions">
    <button id="accept">Accept candidate</button>
    <button id="reject" class="secondary">Reject candidate</button>
    <button id="copy" class="secondary">Copy candidate</button>
    <button id="diff" class="secondary">Open Diff</button>
    <button id="retry" class="secondary">Retry</button>
    <button id="cancel" class="secondary">Cancel task</button>
  </div>
  <div id="error" role="alert" aria-live="polite"></div>
  <section id="clarification" role="region" aria-label="Agent clarification">
    <strong>Agent needs clarification</strong>
    <p id="clarification-question"></p>
    <div id="clarification-options" class="actions"></div>
    <textarea id="clarification-answer" placeholder="Type your answer for the Agent."></textarea>
    <div class="actions"><button id="send-clarification">Send answer to Agent</button></div>
  </section>
  <section id="followup-section">
    <strong>Continue refining</strong>
    <textarea id="followup" placeholder="Describe what to change in the next candidate."></textarea>
    <div class="actions"><button id="continue">Send follow-up</button></div>
  </section>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const byId = (id) => document.getElementById(id);
    let currentTask;
    const send = (type, extra = {}) => vscode.postMessage({ type, ...extra });
    byId('accept').addEventListener('click', () => send('accept'));
    byId('reject').addEventListener('click', () => send('reject'));
    byId('copy').addEventListener('click', () => send('copy'));
    byId('diff').addEventListener('click', () => send('openDiff'));
    byId('retry').addEventListener('click', () => send('retry'));
    byId('cancel').addEventListener('click', () => send('cancel'));
    byId('continue').addEventListener('click', () => send('continue', { instruction: byId('followup').value }));
    byId('followup').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        send('continue', { instruction: byId('followup').value });
      }
    });
    const sendClarification = () => send('answerClarification', { answer: byId('clarification-answer').value });
    byId('send-clarification').addEventListener('click', sendClarification);
    byId('clarification-answer').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        sendClarification();
      }
    });
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message?.type === 'validation') { byId('error').textContent = message.message; return; }
      if (message?.type === 'continued') { byId('followup').value = ''; byId('error').textContent = ''; return; }
      if (message?.type === 'clarificationAnswered') {
        byId('clarification-answer').value = '';
        byId('error').textContent = '';
        return;
      }
      if (message?.type !== 'task') return;
      currentTask = message.task;
      const task = currentTask;
      byId('title').textContent = task.title;
      byId('status').textContent = task.taskState + ' / ' + task.anchorState;
      byId('meta').textContent = task.revisionCount + ' revisions · ' + task.instructionCount + ' instructions · document v' + task.currentDocumentVersion;
      byId('progress').textContent = task.progress;
      const failure = byId('failure');
      const failureMessage = task.lastError || task.progress || '';
      byId('failure-message').textContent = failureMessage;
      if (task.showFailureError && failureMessage) {
        failure.classList.add('visible');
      } else {
        failure.classList.remove('visible');
      }
      byId('instruction').textContent = task.instruction;
      byId('summary').textContent = task.summary;
      byId('warnings').textContent = task.warnings.join('\\n');
      byId('base').textContent = task.baseText;
      byId('local').textContent = task.localText;
      byId('candidate').textContent = task.candidate || 'No candidate yet.';
      byId('accept').disabled = !task.canAccept;
      byId('reject').disabled = !task.canReject;
      byId('copy').disabled = !task.canCopy;
      byId('diff').disabled = !task.hasCandidate;
      byId('retry').disabled = !task.canRetry;
      byId('cancel').disabled = !task.canContinue;
      byId('continue').disabled = !task.canContinue || task.canAnswerClarification;
      byId('followup').disabled = !task.canContinue || task.canAnswerClarification;
      const followupSection = byId('followup-section');
      if (task.canAnswerClarification) {
        followupSection.classList.add('hidden');
      } else {
        followupSection.classList.remove('hidden');
      }
      const clarification = byId('clarification');
      const clarificationOptions = byId('clarification-options');
      clarificationOptions.replaceChildren();
      if (task.canAnswerClarification) {
        byId('clarification-question').textContent = task.clarificationQuestion;
        byId('send-clarification').disabled = false;
        byId('clarification-answer').disabled = false;
        if (Array.isArray(task.clarificationOptions)) {
          for (const option of task.clarificationOptions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'secondary';
            button.textContent = option;
            button.addEventListener('click', () => {
              byId('clarification-answer').value = option;
              send('answerClarification', { answer: option });
            });
            clarificationOptions.appendChild(button);
          }
        }
        clarification.classList.add('visible');
      } else {
        byId('clarification-question').textContent = '';
        byId('send-clarification').disabled = true;
        byId('clarification-answer').disabled = true;
        clarification.classList.remove('visible');
      }
      const stall = byId('stall');
      const stallList = byId('stall-list');
      stallList.replaceChildren();
      if (task.showStallHints && Array.isArray(task.stallHints) && task.stallHints.length) {
        for (const hint of task.stallHints) {
          const item = document.createElement('li');
          item.textContent = hint;
          stallList.appendChild(item);
        }
        stall.classList.add('visible');
      } else {
        stall.classList.remove('visible');
      }
    });
    send('ready');
  </script>
</body>
</html>`;
}
