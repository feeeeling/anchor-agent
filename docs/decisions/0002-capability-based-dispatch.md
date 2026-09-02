# ADR 0002: Capability-based Agent dispatch

- Status: Accepted
- Date: 2026-08-30

## Context

MCP standardizes tools, resources, prompts, and optional client sampling. It does not require every host to expose its active conversation ID or a native fork operation. Anchor Agent still needs the editor shortcut to start work automatically where possible without pretending all hosts have identical capabilities.

## Decision

The stdio MCP process negotiates the connected client's capabilities after initialization.

1. If the client supports `sampling/createMessage`, the process leases pending instructions from the extension and automatically asks the host to generate a candidate.
2. If the client also supports sampling tools, the sampling loop offers only Anchor's read-document and search-workspace tools. Tool calls are executed by the trusted extension bridge.
3. If sampling is unavailable, an Agent claims work explicitly with `anchor.claim_task`. Optional `sourceSessionId` and `sourceNodeId` bind that logical task branch to host context.
4. Native host session forks remain an adapter-level capability (`src/session-branch.ts`, ADR 0004). When available, claim/sampling fork from the current node; otherwise `TaskService` instruction/revision history is the logical branch of record, with no fake native IDs and no parent conversation writeback.

Claims use expiring leases. Failed automatic dispatches back off and retry three times; the user may then retry explicitly. Candidate application remains exclusively in the editor extension.

## Consequences

- Automatic dispatch works on sampling-capable hosts without a per-vendor chat API.
- Basic MCP clients remain compatible but require a claim tool call or a small host adapter.
- Sampling without tool support receives only the selected text, preserving the minimum-context default.
- Automatic sampling does not imply access to the host's current conversation ancestry; that requires native adapter metadata.
