#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { McpBridgeClient } from "./mcp-bridge-client.js";
import { SamplingDispatcher } from "./sampling-dispatcher.js";
import {
  claimFieldsFromBinding,
  configureSessionForkCapability,
  ensureTaskBranch,
  getConfiguredSessionForkCapability,
  resolveSessionForkCapability,
} from "./session-branch.js";

// Hosts may call configureSessionForkCapability() with a native fork RPC.
// Env alone only supplies current session/node IDs when a fork function is also injected.
configureSessionForkCapability(resolveSessionForkCapability());

const server = new McpServer({ name: "anchor-agent", version: "0.1.0" });
const bridge = new McpBridgeClient();
const dispatcherId = `mcp-${randomUUID()}`;

server.registerTool(
  "anchor.list_connections",
  {
    description:
      "List active Anchor Agent VS Code windows and the currently selected connection.",
    annotations: { readOnlyHint: true },
  },
  async () => localTool(() => bridge.listConnections()),
);

server.registerTool(
  "anchor.use_connection",
  {
    description:
      "Select which VS Code window subsequent Anchor Agent tools use.",
    inputSchema: { connectionId: z.string().min(1) },
  },
  async ({ connectionId }) =>
    localTool(async () => {
      await bridge.selectConnection(connectionId);
      return { selected: connectionId };
    }),
);

server.registerTool(
  "anchor.list_tasks",
  {
    description:
      "List anchored edit tasks exposed by the active VS Code window.",
    annotations: { readOnlyHint: true },
  },
  async () => toolCall("/v1/tasks"),
);

server.registerTool(
  "anchor.claim_task",
  {
    description:
      "Claim a pending task instruction in the current Agent conversation. Use this when automatic sampling is unavailable. Optional sourceSessionId/sourceNodeId associate the logical Anchor branch with host context; when a native session-fork adapter is configured, Anchor forks from the current node instead of inventing IDs. Task results are never written back to the parent conversation.",
    inputSchema: {
      taskId: z.string().optional(),
      sourceSessionId: z.string().optional(),
      sourceNodeId: z.string().optional(),
    },
  },
  async (input) => {
    try {
      // Claim with optional logical association IDs first. Native fork attaches
      // only after a successful claim so idle claims do not create orphan sessions.
      const capability = getConfiguredSessionForkCapability();
      const claimResult = await bridge.request<{
        claim: {
          task: {
            id: string;
            branchId: string;
            sourceSessionId?: string;
            sourceNodeId?: string;
            branchMode?: "native" | "logical";
          };
        } | null;
      }>("/v1/dispatch/claim", {
        method: "POST",
        body: JSON.stringify({
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...(input.sourceSessionId
            ? { sourceSessionId: input.sourceSessionId }
            : {}),
          ...(input.sourceNodeId ? { sourceNodeId: input.sourceNodeId } : {}),
          branchMode: "logical",
          dispatcherId,
          leaseMs: 120_000,
          mode: "manual",
        }),
      });
      if (claimResult.claim) {
        const bound = await ensureTaskBranch({
          hasNativeFork: capability.hasNativeFork,
          ...(capability.forkFromCurrentNode
            ? { forkFromCurrentNode: capability.forkFromCurrentNode }
            : {}),
          ...(capability.currentSessionId
            ? { currentSessionId: capability.currentSessionId }
            : {}),
          ...(capability.currentNodeId
            ? { currentNodeId: capability.currentNodeId }
            : {}),
          existing: {
            branchId: claimResult.claim.task.branchId,
            ...(claimResult.claim.task.sourceSessionId
              ? { sourceSessionId: claimResult.claim.task.sourceSessionId }
              : {}),
            ...(claimResult.claim.task.sourceNodeId
              ? { sourceNodeId: claimResult.claim.task.sourceNodeId }
              : {}),
            ...(claimResult.claim.task.branchMode
              ? { branchMode: claimResult.claim.task.branchMode }
              : {}),
          },
          requested: {
            ...(input.sourceSessionId
              ? { sourceSessionId: input.sourceSessionId }
              : {}),
            ...(input.sourceNodeId ? { sourceNodeId: input.sourceNodeId } : {}),
          },
        });
        const fields = claimFieldsFromBinding(bound);
        await bridge.request(
          `/v1/tasks/${encodeURIComponent(claimResult.claim.task.id)}/branch`,
          {
            method: "POST",
            body: JSON.stringify(fields),
          },
        );
        claimResult.claim.task.branchMode = bound.mode;
        if (bound.sourceSessionId) {
          claimResult.claim.task.sourceSessionId = bound.sourceSessionId;
        }
        if (bound.sourceNodeId) {
          claimResult.claim.task.sourceNodeId = bound.sourceNodeId;
        }
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(claimResult) },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  },
);

server.registerTool(
  "anchor.get_task",
  {
    description:
      "Get one anchored local-edit task. The full document is intentionally omitted.",
    inputSchema: { taskId: z.string().min(1) },
    annotations: { readOnlyHint: true },
  },
  async ({ taskId }) => toolCall(`/v1/tasks/${encodeURIComponent(taskId)}`),
);

server.registerTool(
  "anchor.read_document",
  {
    description: "Read the immutable task snapshot or current editor document.",
    inputSchema: {
      taskId: z.string().min(1),
      uri: z.string().min(1),
      mode: z.enum(["snapshot", "current"]).default("snapshot"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ taskId, uri, mode }) => {
    const query = new URLSearchParams({ taskId, uri, mode });
    return toolCall(`/v1/documents?${query.toString()}`);
  },
);

server.registerTool(
  "anchor.search_workspace",
  {
    description: "Search workspace text without modifying files.",
    inputSchema: {
      taskId: z.string().min(1),
      query: z.string().min(1),
      include: z.string().optional(),
      maxResults: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  async (input) =>
    toolCall("/v1/search", { method: "POST", body: JSON.stringify(input) }),
);

server.registerTool(
  "anchor.report_progress",
  {
    description: "Report task progress for display at the editor anchor.",
    inputSchema: {
      taskId: z.string().min(1),
      stage: z.string().min(1),
      message: z.string().min(1),
      percentage: z.number().min(0).max(100).optional(),
    },
  },
  async ({ taskId, ...progress }) =>
    toolCall(`/v1/tasks/${encodeURIComponent(taskId)}/progress`, {
      method: "POST",
      body: JSON.stringify(progress),
    }),
);

server.registerTool(
  "anchor.submit_revision",
  {
    description:
      "Submit an immutable candidate replacement. This never edits the document.",
    inputSchema: {
      taskId: z.string().min(1),
      parentRevisionId: z.string().optional(),
      instructionId: z.string().optional(),
      instruction: z.string().optional(),
      replacement: z.string(),
      summary: z.string().optional(),
      warnings: z.array(z.string()).optional(),
      basedOnDocumentVersion: z.number().int().optional(),
    },
  },
  async ({ taskId, ...revision }) =>
    toolCall(`/v1/tasks/${encodeURIComponent(taskId)}/revisions`, {
      method: "POST",
      body: JSON.stringify(revision),
    }),
);

server.registerTool(
  "anchor.request_clarification",
  {
    description: "Ask the user a question before producing another candidate.",
    inputSchema: {
      taskId: z.string().min(1),
      question: z.string().min(1),
      options: z.array(z.string()).optional(),
    },
  },
  async ({ taskId, ...clarification }) =>
    toolCall(`/v1/tasks/${encodeURIComponent(taskId)}/clarification`, {
      method: "POST",
      body: JSON.stringify(clarification),
    }),
);

function toolCall(path: string, init: RequestInit = {}) {
  return bridge.toolResult(path, init);
}

async function localTool(operation: () => Promise<unknown>) {
  try {
    const value = await operation();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(value) }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: "text" as const, text: message }],
    };
  }
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const dispatcher = new SamplingDispatcher(server, bridge, dispatcherId);
  process.once("SIGINT", () => dispatcher.stop());
  process.once("SIGTERM", () => dispatcher.stop());
  void dispatcher.start().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Anchor auto-dispatch stopped: ${message}\n`);
  });
}

void main().catch((error) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
