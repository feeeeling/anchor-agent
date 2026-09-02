# Pi setup

Anchor Agent can dispatch tasks automatically through Pi's MCP Sampling support. The MCP server must stay connected so it can observe tasks created later in VS Code.

## Copy the configuration

1. Install the Anchor Agent VSIX and reload VS Code.
2. Open the target workspace.
3. Run **Anchor Agent: Copy MCP Configuration**.
4. Choose **Pi**.
5. Save the copied JSON as either:
   - `.mcp.json` in the directory where Pi will run; or
   - `~/.config/mcp/mcp.json` for a user-global configuration.

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

The JSON was copied but not saved in a path Pi reads, or Pi has not been reloaded. Use `.mcp.json`, `~/.config/mcp/mcp.json`, or a Pi-owned MCP config, then run `/reload`.

### The task stays at `created` with zero dispatch attempts

Confirm that the server uses `"lifecycle": "keep-alive"` and that Pi advertises Sampling. A lazy MCP process cannot observe a task created before the server is connected.

### `node` is not found

GUI-launched hosts may not inherit the shell `PATH`. Replace `"command": "node"` with the absolute path reported by:

```bash
command -v node
```

### Multiple VS Code windows are open

Keep `ANCHOR_AGENT_WORKSPACE` set to the intended workspace. You can also use `anchor.list_connections` and `anchor.use_connection` to select a window explicitly.
