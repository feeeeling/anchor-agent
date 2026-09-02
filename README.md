# Anchor Agent

[![CI](https://github.com/feeeeling/anchor-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/feeeeling/anchor-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

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
- explicit diff, accept, reject, copy, retry, cancel, and follow-up review actions;
- configurable conflict handling with rebase/regeneration or reviewed three-way merge.

See [`docs/PRD.md`](docs/PRD.md), [`docs/architecture.md`](docs/architecture.md), [`docs/mcp-contract.md`](docs/mcp-contract.md), and the [`Pi setup guide`](docs/pi-setup.md).

## Install

Download `anchor-agent-0.1.1.vsix` from the latest GitHub prerelease and install it:

```bash
code --install-extension anchor-agent-0.1.1.vsix
```

In VS Code, run **Anchor Agent: Copy MCP Configuration** from the Command Palette, choose your host, and save the copied JSON in its MCP configuration. For Pi, save it as `.mcp.json` or `~/.config/mcp/mcp.json`, then run `/reload`; the generated keep-alive configuration allows tasks created later to dispatch automatically. See the [Pi setup guide](docs/pi-setup.md).

Then select text and run **Anchor Agent: Rewrite Selection** or press `Cmd+Shift+I` / `Ctrl+Shift+I`.

This is an early prerelease. Back up important work and review every candidate before accepting it.

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

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for development and pull-request guidance. Report vulnerabilities according to [`SECURITY.md`](SECURITY.md).

Released under the [MIT License](LICENSE).
