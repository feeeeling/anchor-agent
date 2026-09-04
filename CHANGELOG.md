# Changelog

## Unreleased

- MCP configuration uses the editor Node absolute path so GUI-launched hosts can spawn the stdio server.
- Invalid MCP JSON is rejected with a named parse error instead of a raw `JSON.parse` throw.

## 0.1.1

- Added a Pi session fork adapter: native fork from the current node when the host injects fork capability, otherwise logical branch; task results are never written back to the parent conversation.
- Surface actionable Sampling failure errors in task progress/`lastError` and the details panel (Retry enabled when failed).
- Added a task-details reply channel so clarification answers return to the Agent as pending instruction turns.
- Added explicit Reject Candidate and Copy Candidate review actions.
- Prevented late Agent progress, clarification, retry, and revision updates from reviving terminal tasks.
- Invalidated pending instruction leases when a user cancels or rejects a task.
- Added a Pi-specific MCP configuration option with keep-alive lifecycle and user-approved Sampling.
- Added Pi setup and troubleshooting documentation.
- Set the extension publisher to `feeeeling`; installations of `undefined_publisher.anchor-agent` should be removed before installing this version.

## 0.1.0

- First public prerelease with anchored selection tasks, MCP tools and Sampling dispatch, conflict review, task Webviews, and multi-window routing.
