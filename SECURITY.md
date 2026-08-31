# Security policy

## Supported versions

Anchor Agent is pre-1.0. Security fixes currently target the latest commit and latest GitHub prerelease.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability involving bearer tokens, workspace data disclosure, arbitrary file access, or unintended file mutation. Use GitHub's private vulnerability reporting for this repository.

Include reproduction steps and affected versions, but do not include real secrets or private document contents.

## Security boundaries

- The extension bridge binds only to `127.0.0.1` and authenticates requests with a user-only bearer-token descriptor.
- MCP tools expose read/search and candidate submission, not generic write, shell, delete, Git, or patch operations.
- Candidates require explicit editor-side acceptance.
- Workspace reads and searches can be disabled in VS Code settings.

These controls reduce risk but do not make untrusted MCP hosts safe. Only connect Agent software you trust to your workspace.
