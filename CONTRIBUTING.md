# Contributing

Thanks for helping improve Anchor Agent.

## Development

Requirements: Node.js 20+ and VS Code 1.95+.

```bash
git clone https://github.com/feeeeling/anchor-agent.git
cd anchor-agent
npm ci
npm run check
npm test
npm run build
```

Press `F5` in VS Code to launch the Extension Development Host.

## Pull requests

- Keep changes selection-scoped: Agents must submit candidates and must not directly mutate files.
- Add tests for anchor transformations, conflict behavior, dispatch, or connection routing when applicable.
- Run `npm run check`, `npm test`, and `npm run build` before opening a PR.
- Update durable documentation under `docs/` when behavior or trust boundaries change.
- Keep PRs focused and explain user-visible behavior and security implications.

## Reporting bugs

Include the VS Code version, operating system, MCP host, relevant Anchor task state, and reproducible steps. Remove document contents and bearer tokens from logs before sharing them.
