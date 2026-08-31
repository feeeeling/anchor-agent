# ADR 0003: Workspace-aware MCP connection routing

- Status: Accepted
- Date: 2026-08-31

## Context

A single `~/.anchor-agent/connection.json` is overwritten by whichever VS Code window activates most recently. An MCP process could therefore claim a task in one workspace and submit its result to another if focus changed between requests.

## Decision

Every extension host writes a user-only descriptor under `~/.anchor-agent/connections/<connectionId>.json` and refreshes it with a heartbeat. The focused window updates `active.json` and the legacy `connection.json` pointer.

The stdio bridge resolves and caches one descriptor before making task requests. Selection order is:

1. explicit `ANCHOR_AGENT_DESCRIPTOR`;
2. explicit `anchor.use_connection` selection;
3. `ANCHOR_AGENT_WORKSPACE` match;
4. focused-window hint;
5. most recently refreshed live process.

`anchor.list_connections` exposes sanitized descriptors without bearer tokens. `anchor.use_connection` changes the process-local selection. Dead extension PIDs are ignored. Caching prevents focus changes from moving an in-flight task between windows.

## Consequences

- Multiple VS Code windows can expose independent task sets safely.
- Host configurations should provide `ANCHOR_AGENT_WORKSPACE` when they can expand a workspace path.
- Existing single-descriptor configurations continue to work through a legacy pointer.
- Selection is per MCP process and is never written into global editor configuration.
