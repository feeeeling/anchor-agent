# Anchor Agent

Anchor Agent is a VS Code extension for asynchronous, selection-scoped AI editing. A task remains attached to its logical text range while the user edits elsewhere. MCP-compatible agents may read context and submit candidate revisions, but they cannot apply edits directly.

## Current status

Early MVP foundation:

- multiline task instructions with range tracking while the dialog is open;
- selection task creation, tracked anchors, and a live task-details panel;
- task persistence, CodeLens status, and editor decorations;
- local authenticated bridge API with workspace-aware multi-window routing;
- stdio MCP server exposing connection/claim/read/search/progress/revision tools;
- automatic dispatch through MCP Sampling, with read tools when the host supports them;
- leased retries plus explicit retry for failed Agent dispatches;
- explicit review and follow-up instructions on a task-local logical branch;
- configurable conflict handling with rebase/regeneration or reviewed three-way merge.

See [`docs/PRD.md`](docs/PRD.md), [`docs/architecture.md`](docs/architecture.md), and [`docs/mcp-contract.md`](docs/mcp-contract.md).

## Development

```bash
npm install
npm run check
npm test
npm run build
```

Run the extension with VS Code's Extension Development Host. Configure an MCP host to launch:

```json
{
  "mcpServers": {
    "anchor-agent": {
      "command": "node",
      "args": ["/absolute/path/to/doc_editor/dist/mcp-server.cjs"]
    }
  }
}
```

The bridge discovers live windows through `~/.anchor-agent/connections/`. In multi-window setups, set `ANCHOR_AGENT_WORKSPACE` in the MCP process or use `anchor.list_connections` followed by `anchor.use_connection`. Call `anchor.list_tasks` to discover a newly created task.
