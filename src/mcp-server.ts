#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

interface ConnectionDescriptor {
  endpoint: string;
  token: string;
}

const descriptorPath = join(homedir(), ".anchor-agent", "connection.json");
const server = new McpServer({ name: "anchor-agent", version: "0.1.0" });

server.registerTool(
  "anchor.list_tasks",
  {
    description: "List anchored edit tasks exposed by the active VS Code window.",
    annotations: { readOnlyHint: true },
  },
  async () => toolCall("/v1/tasks"),
);

server.registerTool(
  "anchor.get_task",
  {
    description: "Get one anchored local-edit task. The full document is intentionally omitted.",
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
  async (input) => toolCall("/v1/search", { method: "POST", body: JSON.stringify(input) }),
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
    description: "Submit an immutable candidate replacement. This never edits the document.",
    inputSchema: {
      taskId: z.string().min(1),
      parentRevisionId: z.string().optional(),
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

async function toolCall(path: string, init: RequestInit = {}) {
  try {
    const descriptor = await loadDescriptor();
    const response = await fetch(`${descriptor.endpoint}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Anchor bridge returned ${response.status}: ${text}`);
    }
    return { content: [{ type: "text" as const, text }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: "text" as const, text: message }] };
  }
}

async function loadDescriptor(): Promise<ConnectionDescriptor> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(descriptorPath, "utf8"));
  } catch {
    throw new Error("No active Anchor Agent extension was found. Open the VS Code workspace first.");
  }
  if (!value || typeof value !== "object") {
    throw new Error("The Anchor Agent connection descriptor is invalid.");
  }
  const descriptor = value as Record<string, unknown>;
  if (typeof descriptor.endpoint !== "string" || typeof descriptor.token !== "string") {
    throw new Error("The Anchor Agent connection descriptor is incomplete.");
  }
  return { endpoint: descriptor.endpoint, token: descriptor.token };
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
