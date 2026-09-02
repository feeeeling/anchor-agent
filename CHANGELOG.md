# Changelog

## 0.1.1

- Added a task-details reply channel so clarification answers return to the Agent as pending instruction turns.
- Added explicit Reject Candidate and Copy Candidate review actions.
- Prevented late Agent progress, clarification, retry, and revision updates from reviving terminal tasks.
- Invalidated pending instruction leases when a user cancels or rejects a task.
- Added a Pi-specific MCP configuration option with keep-alive lifecycle and user-approved Sampling.
- Added Pi setup and troubleshooting documentation.
- Set the extension publisher to `feeeeling`; installations of `undefined_publisher.anchor-agent` should be removed before installing this version.

## 0.1.0

- First public prerelease with anchored selection tasks, MCP tools and Sampling dispatch, conflict review, task Webviews, and multi-window routing.
