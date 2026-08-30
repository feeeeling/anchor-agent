# Anchor Agent

Anchor Agent is a VS Code extension for asynchronous, selection-scoped AI editing. A task remains attached to its logical text range while the user edits elsewhere. MCP-compatible agents may read context and submit candidate revisions, but they cannot apply edits directly.

## Current status

Early MVP foundation:

- selection task creation and tracked anchors;
- task persistence and editor decorations;
- local authenticated bridge API;
- stdio MCP server exposing read/search/progress/revision tools;
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

The bridge discovers the active VS Code extension through `~/.anchor-agent/connection.json`. Call `anchor.list_tasks` to discover a newly created task.
