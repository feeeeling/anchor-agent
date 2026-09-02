# Pi setup

Anchor Agent can dispatch tasks automatically through Pi's MCP Sampling support. The MCP server must stay connected so it can observe tasks created later in VS Code.

## Copy or write the configuration

1. Install the Anchor Agent VSIX and reload VS Code.
2. Open the target workspace.
3. Run **Anchor Agent: Copy MCP Configuration**.
4. Choose **Pi**.
5. Choose how to apply the configuration:
   - **Copy to clipboard only**, then paste manually; or
   - **Write workspace `.mcp.json`**; or
   - **Write `~/.config/mcp/mcp.json`**.
6. For write destinations, review the before/after diff, confirm in the modal, and only then is the file written. Existing MCP servers are preserved; Pi `settings.sampling` / `settings.samplingAutoApprove` are merged without wiping unrelated settings. Parent directories under `~/.config/mcp` are created when needed.

The generated Pi entry includes:

```json
{
  "settings": {
    "sampling": true,
    "samplingAutoApprove": false
  },
  "mcpServers": {
    "anchor-agent": {
      "command": "node",
      "args": ["/installed/extension/dist/mcp-server.cjs"],
      "env": {
        "ANCHOR_AGENT_WORKSPACE": "/target/workspace"
      },
      "lifecycle": "keep-alive"
    }
  }
}
```

`samplingAutoApprove` remains disabled so Pi asks before an MCP server invokes the model.

## Load and verify

In Pi, run:

```text
/reload
/mcp
```

The MCP panel should show `anchor-agent`. Create a task in VS Code and approve the Sampling request when Pi prompts. The task should move from `created` to `queued` or `running` and eventually become `ready`.

For manual fallback, ask Pi to call `anchor.list_tasks`, `anchor.claim_task`, and `anchor.submit_revision`.

## Troubleshooting

### Pi shows zero MCP servers

The JSON was not written (or was only copied) to a path Pi reads, or Pi has not been reloaded. Use the write options for `.mcp.json` / `~/.config/mcp/mcp.json`, or a Pi-owned MCP config, then run `/reload`.

### The task stays at `created` with zero dispatch attempts

Confirm that the server uses `"lifecycle": "keep-alive"` and that Pi advertises Sampling. A lazy MCP process cannot observe a task created before the server is connected.

After about 12 seconds with no dispatch attempt, the task details panel shows a stall checklist (MCP connection, `/reload`, Sampling authorization, or manual `anchor.claim_task`). The banner clears automatically once an Agent claims the instruction.


### Sampling fails and the task ends in `failed`

Automatic Sampling failures no longer leave the task looking stuck in `created`. After up to three dispatch attempts the task moves to `failed`, and the task details panel shows an actionable error (also stored as `lastError`), for example:

- **Sampling rejected / not authorized** — approve the Sampling prompt in Pi (or set `samplingAutoApprove`), then click **Retry**.
- **Invalid or empty candidate JSON** — click **Retry**, or claim manually with `anchor.claim_task` and submit a revision.
- **Maximum tool-call turns** — click **Retry**; if it keeps failing, claim manually.
- **Bridge / connection errors (`ECONNREFUSED`, disconnected extension)** — confirm VS Code has Anchor Agent open for this workspace, run `/reload` in Pi, then **Retry**.

The panel enables **Retry** whenever any instruction status is `failed`. Manual fallback remains `anchor.list_tasks` → `anchor.claim_task` → `anchor.submit_revision`.

### `node` is not found

GUI-launched hosts may not inherit the shell `PATH`. Replace `"command": "node"` with the absolute path reported by:

```bash
command -v node
```

### Multiple VS Code windows are open

Keep `ANCHOR_AGENT_WORKSPACE` set to the intended workspace. You can also use `anchor.list_connections` and `anchor.use_connection` to select a window explicitly.
