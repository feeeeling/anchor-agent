# ADR 0001: MCP integration and local-edit scope

- Status: Accepted
- Date: 2026-08-30

## Decision

Anchor Agent exposes task capabilities through MCP. An agent receives only the selected text initially, but may request the task-time document snapshot, the current document, or other workspace files. Workspace access is read-only.

Every task automatically branches from the active agent conversation node when the host supports it. Otherwise, Anchor Agent maintains a logical branch by replaying task-local history. Task results are not written back to the parent conversation.

The product remains selection-scoped: an agent may inspect broad context, but its only mutation-shaped output is a candidate replacement for the anchored selection.

## Consequences

- The editor extension owns all file mutations and conflict checks.
- MCP support alone does not guarantee automatic prompting or native session forks; hosts may require sampling support or a thin adapter.
- No generic file-write or shell tools are exposed by the Anchor MCP server.
- Applying a candidate always requires explicit user action.
