import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  SamplingMessage,
  SamplingMessageContentBlock,
  Tool,
  ToolResultContent,
  ToolUseContent,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { McpBridgeClient } from "./mcp-bridge-client.js";
import { formatSamplingFailure } from "./sampling-errors.js";
import {
  PARENT_WRITEBACK_POLICY,
  assertNoParentWriteback,
  claimFieldsFromBinding,
  ensureTaskBranch,
  getConfiguredSessionForkCapability,
  type SessionForkCapability,
} from "./session-branch.js";
import type { EditTask, TaskInstruction } from "./types.js";

interface DispatchClaim {
  task: Omit<EditTask, "documentSnapshot">;
  instruction: TaskInstruction;
}

interface ClaimResponse {
  claim: DispatchClaim | null;
  autoDispatch: boolean;
  maxTokens?: number;
}

const candidateSchema = z.object({
  replacement: z.string(),
  summary: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});

const samplingTools: Tool[] = [
  {
    name: "anchor.read_document",
    description:
      "Read the immutable task snapshot or the current editor document.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        uri: { type: "string" },
        mode: { type: "string", enum: ["snapshot", "current"] },
      },
      required: ["taskId", "uri", "mode"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "anchor.search_workspace",
    description: "Search text in the workspace without modifying files.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        query: { type: "string" },
        include: { type: "string" },
        maxResults: { type: "number" },
      },
      required: ["taskId", "query"],
    },
    annotations: { readOnlyHint: true },
  },
];

export class SamplingDispatcher {
  private stopped = false;

  constructor(
    private readonly server: McpServer,
    private readonly bridge: McpBridgeClient,
    private readonly dispatcherId: string,
    private readonly sessionFork: SessionForkCapability = getConfiguredSessionForkCapability(),
  ) {}

  async start(): Promise<void> {
    const capabilities = await this.waitForClientCapabilities();
    if (!capabilities?.sampling) {
      return;
    }
    const supportsTools = capabilities.sampling.tools !== undefined;
    while (!this.stopped) {
      try {
        const result = await this.dispatchNext(supportsTools);
        if (result === "disabled") {
          await sleep(5_000);
        } else if (result === "idle") {
          await sleep(750);
        }
      } catch {
        await sleep(2_000);
      }
    }
  }

  async dispatchNext(
    supportsTools: boolean,
  ): Promise<"dispatched" | "idle" | "disabled"> {
    const response = await this.bridge.request<ClaimResponse>(
      "/v1/dispatch/claim",
      {
        method: "POST",
        body: JSON.stringify({
          dispatcherId: this.dispatcherId,
          leaseMs: 120_000,
          mode: "auto",
        }),
      },
    );
    if (!response.autoDispatch) {
      return "disabled";
    }
    if (!response.claim) {
      return "idle";
    }

    // After a successful claim, attach native fork metadata from the current
    // session node when the host adapter supports it; otherwise keep logical.
    await this.attachTaskBranch(response.claim);

    await this.dispatch(
      response.claim,
      supportsTools,
      response.maxTokens ?? 8_192,
    );
    return "dispatched";
  }

  /**
   * Bind the claimed task to a native forked session/node or the logical branch.
   * Never invents fake native IDs; never writes results back to the parent chat.
   */
  private async attachTaskBranch(claim: DispatchClaim): Promise<void> {
    const bound = await ensureTaskBranch({
      hasNativeFork: this.sessionFork.hasNativeFork,
      ...(this.sessionFork.forkFromCurrentNode
        ? { forkFromCurrentNode: this.sessionFork.forkFromCurrentNode }
        : {}),
      ...(this.sessionFork.currentSessionId
        ? { currentSessionId: this.sessionFork.currentSessionId }
        : {}),
      ...(this.sessionFork.currentNodeId
        ? { currentNodeId: this.sessionFork.currentNodeId }
        : {}),
      existing: {
        branchId: claim.task.branchId,
        ...(claim.task.sourceSessionId
          ? { sourceSessionId: claim.task.sourceSessionId }
          : {}),
        ...(claim.task.sourceNodeId ? { sourceNodeId: claim.task.sourceNodeId } : {}),
        ...(claim.task.branchMode ? { branchMode: claim.task.branchMode } : {}),
      },
    });
    const fields = claimFieldsFromBinding(bound);
    claim.task.branchMode = bound.mode;
    if (bound.sourceSessionId) {
      claim.task.sourceSessionId = bound.sourceSessionId;
    }
    if (bound.sourceNodeId) {
      claim.task.sourceNodeId = bound.sourceNodeId;
    }
    await this.bridge.request(
      `/v1/tasks/${encodeURIComponent(claim.task.id)}/branch`,
      {
        method: "POST",
        body: JSON.stringify(fields),
      },
    );
  }

  stop(): void {
    this.stopped = true;
  }

  private async dispatch(
    claim: DispatchClaim,
    supportsTools: boolean,
    maxTokens: number,
  ): Promise<void> {
    try {
      // Invariant: never write candidates or summaries back to the parent
      // conversation. Only Anchor revision APIs receive the result.
      assertNoParentWriteback([
        { type: PARENT_WRITEBACK_POLICY.candidateSubmissionChannel },
      ]);
      await this.reportProgress(
        claim.task.id,
        "sampling",
        "Agent is generating a candidate",
        10,
      );
      const messages: SamplingMessage[] = [
        {
          role: "user",
          content: { type: "text", text: buildPrompt(claim, supportsTools) },
        },
      ];
      const finalText = supportsTools
        ? await this.sampleWithTools(messages, maxTokens, claim.task.id)
        : await this.sampleWithoutTools(messages, maxTokens);
      const candidate = parseCandidate(finalText);
      await this.bridge.request(
        `/v1/tasks/${encodeURIComponent(claim.task.id)}/revisions`,
        {
          method: "POST",
          body: JSON.stringify({
            instructionId: claim.instruction.id,
            parentRevisionId: claim.instruction.parentRevisionId,
            replacement: candidate.replacement,
            summary: candidate.summary,
            warnings: candidate.warnings,
            basedOnDocumentVersion: claim.task.baseDocumentVersion,
          }),
        },
      );
    } catch (error) {
      const message = formatSamplingFailure(error);
      await this.bridge.request(
        `/v1/dispatch/instructions/${encodeURIComponent(claim.instruction.id)}/fail`,
        {
          method: "POST",
          body: JSON.stringify({ dispatcherId: this.dispatcherId, message }),
        },
      );
    }
  }

  private async sampleWithoutTools(
    messages: SamplingMessage[],
    maxTokens: number,
  ): Promise<string> {
    const result = await this.server.server.createMessage({
      messages,
      systemPrompt: systemPrompt(false),
      includeContext: "none",
      maxTokens,
    });
    return textFrom(result.content);
  }

  private async sampleWithTools(
    messages: SamplingMessage[],
    maxTokens: number,
    taskId: string,
  ): Promise<string> {
    for (let turn = 0; turn < 8; turn += 1) {
      const result = await this.server.server.createMessage({
        messages,
        systemPrompt: systemPrompt(true),
        includeContext: "none",
        maxTokens,
        tools: samplingTools,
        toolChoice: { mode: "auto" },
      });
      const blocks = Array.isArray(result.content)
        ? result.content
        : [result.content];
      const toolUses = blocks.filter(isToolUse);
      if (toolUses.length === 0) {
        return textFrom(blocks);
      }
      const toolResults = await Promise.all(
        toolUses.map((toolUse) => this.executeTool(toolUse, taskId)),
      );
      messages.push({ role: "assistant", content: blocks });
      messages.push({ role: "user", content: toolResults });
    }
    throw new Error("Sampling exceeded the maximum tool-call turns");
  }

  private async executeTool(
    toolUse: ToolUseContent,
    taskId: string,
  ): Promise<ToolResultContent> {
    try {
      const input = { ...toolUse.input, taskId };
      let value: unknown;
      if (toolUse.name === "anchor.read_document") {
        const parsed = z
          .object({
            taskId: z.string(),
            uri: z.string(),
            mode: z.enum(["snapshot", "current"]),
          })
          .parse(input);
        const query = new URLSearchParams(parsed);
        value = await this.bridge.request(`/v1/documents?${query.toString()}`);
      } else if (toolUse.name === "anchor.search_workspace") {
        const parsed = z
          .object({
            taskId: z.string(),
            query: z.string(),
            include: z.string().optional(),
            maxResults: z.number().int().min(1).max(100).optional(),
          })
          .parse(input);
        value = await this.bridge.request("/v1/search", {
          method: "POST",
          body: JSON.stringify(parsed),
        });
      } else {
        throw new Error(`Unsupported sampling tool: ${toolUse.name}`);
      }
      return {
        type: "tool_result",
        toolUseId: toolUse.id,
        content: [{ type: "text", text: JSON.stringify(value) }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        type: "tool_result",
        toolUseId: toolUse.id,
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  }

  private async reportProgress(
    taskId: string,
    stage: string,
    message: string,
    percentage: number,
  ): Promise<void> {
    await this.bridge.request(
      `/v1/tasks/${encodeURIComponent(taskId)}/progress`,
      {
        method: "POST",
        body: JSON.stringify({ stage, message, percentage }),
      },
    );
  }

  private async waitForClientCapabilities() {
    for (let attempt = 0; attempt < 100 && !this.stopped; attempt += 1) {
      if (this.server.server.getClientVersion()) {
        return this.server.server.getClientCapabilities();
      }
      await sleep(100);
    }
    return undefined;
  }
}

function buildPrompt(claim: DispatchClaim, supportsTools: boolean): string {
  const previous = claim.instruction.parentRevisionId
    ? claim.task.revisions.find(
        (revision) => revision.id === claim.instruction.parentRevisionId,
      )
    : undefined;
  return [
    `Task ID: ${claim.task.id}`,
    `Language: ${claim.task.languageId}`,
    `Document URI: ${claim.task.documentUri}`,
    "",
    "Selected Base text:",
    "<selection>",
    claim.task.baseText,
    "</selection>",
    "",
    previous
      ? `Previous candidate:\n<candidate>\n${previous.replacement}\n</candidate>\n`
      : "",
    `Instruction: ${claim.instruction.text}`,
    supportsTools
      ? "Read additional document or workspace context only when it is useful."
      : "No read tools are available in this automatic dispatch; work from the supplied selection.",
    "Return only a JSON object with replacement, optional summary, and optional warnings.",
  ].join("\n");
}

function systemPrompt(supportsTools: boolean): string {
  return [
    "You perform one local text edit. Never attempt to write files or return a patch for other ranges.",
    "Do not write completion summaries or candidates back into the parent conversation; Anchor records results only through submit_revision.",
    "Preserve syntax, formatting, commands, references, and surrounding-language conventions unless instructed otherwise.",
    supportsTools
      ? "You may use only the provided read-only tools."
      : "Use only the supplied selection.",
  ].join(" ");
}

function parseCandidate(value: string): z.infer<typeof candidateSchema> {
  const withoutFence = value
    .trim()
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("Agent sampling response did not contain a JSON candidate");
  }
  try {
    const parsed: unknown = JSON.parse(withoutFence.slice(start, end + 1));
    return candidateSchema.parse(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent returned an invalid candidate: ${detail}`);
  }
}

function textFrom(
  content: SamplingMessageContentBlock | SamplingMessageContentBlock[],
): string {
  const blocks = Array.isArray(content) ? content : [content];
  const text = blocks
    .filter(
      (
        block,
      ): block is Extract<SamplingMessageContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) {
    throw new Error("Agent sampling response did not contain text");
  }
  return text;
}

function isToolUse(
  block: SamplingMessageContentBlock,
): block is ToolUseContent {
  return block.type === "tool_use";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
