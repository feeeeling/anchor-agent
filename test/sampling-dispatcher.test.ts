import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import type { McpBridgeClient } from "../src/mcp-bridge-client.js";
import { SamplingDispatcher } from "../src/sampling-dispatcher.js";
import type { EditTask, TaskInstruction } from "../src/types.js";

function fixture() {
  const instruction: TaskInstruction = {
    id: "instruction-1",
    text: "Make this concise",
    status: "dispatching",
    dispatcherId: "dispatcher-1",
    leaseUntil: Date.now() + 60_000,
    dispatchAttempts: 1,
    createdAt: Date.now(),
  };
  const task: Omit<EditTask, "documentSnapshot"> = {
    id: "task-1",
    title: "Make concise",
    instruction: instruction.text,
    documentUri: "file:///paper.tex",
    languageId: "latex",
    baseDocumentVersion: 3,
    baseStart: 0,
    baseEnd: 13,
    currentStart: 0,
    currentEnd: 13,
    baseText: "Original text",
    baseTextHash: "hash",
    anchorState: "clean",
    taskState: "queued",
    branchId: "branch-1",
    instructions: [instruction],
    revisions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return { task, instruction };
}

describe("SamplingDispatcher", () => {
  it("automatically submits a selection-only sampling result", async () => {
    const claim = fixture();
    let submitted: Record<string, unknown> | undefined;
    const bridge = {
      request: vi.fn(async (path: string, init?: RequestInit) => {
        if (path === "/v1/dispatch/claim") {
          return { claim, autoDispatch: true, maxTokens: 2048 };
        }
        if (path.endsWith("/progress")) {
          return {};
        }
        if (path.endsWith("/revisions")) {
          submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return {};
        }
        throw new Error(`Unexpected bridge path: ${path}`);
      }),
    } as unknown as McpBridgeClient;
    const createMessage = vi.fn(async () => ({
      model: "test-model",
      role: "assistant" as const,
      content: {
        type: "text" as const,
        text: '{"replacement":"Concise text","summary":"Shortened"}',
      },
    }));
    const server = { server: { createMessage } } as unknown as McpServer;
    const dispatcher = new SamplingDispatcher(server, bridge, "dispatcher-1");

    await expect(dispatcher.dispatchNext(false)).resolves.toBe("dispatched");
    expect(submitted).toMatchObject({
      instructionId: "instruction-1",
      replacement: "Concise text",
      summary: "Shortened",
      basedOnDocumentVersion: 3,
    });
    expect(createMessage).toHaveBeenCalledOnce();
  });

  it("executes read-only tool requests during sampling", async () => {
    const claim = fixture();
    const bridgeRequest = vi.fn(async (path: string) => {
      if (path === "/v1/dispatch/claim") {
        return { claim, autoDispatch: true, maxTokens: 2048 };
      }
      if (path.endsWith("/progress") || path.endsWith("/revisions")) {
        return {};
      }
      if (path.startsWith("/v1/documents?")) {
        return {
          uri: claim.task.documentUri,
          version: 3,
          content: "Full document",
        };
      }
      throw new Error(`Unexpected bridge path: ${path}`);
    });
    const bridge = { request: bridgeRequest } as unknown as McpBridgeClient;
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({
        model: "test-model",
        role: "assistant",
        stopReason: "toolUse",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "anchor.read_document",
            input: { uri: claim.task.documentUri, mode: "snapshot" },
          },
        ],
      })
      .mockResolvedValueOnce({
        model: "test-model",
        role: "assistant",
        content: { type: "text", text: '{"replacement":"Context-aware text"}' },
      });
    const server = { server: { createMessage } } as unknown as McpServer;
    const dispatcher = new SamplingDispatcher(server, bridge, "dispatcher-1");

    await expect(dispatcher.dispatchNext(true)).resolves.toBe("dispatched");
    expect(bridgeRequest).toHaveBeenCalledWith(
      expect.stringContaining("/v1/documents?"),
    );
    expect(createMessage).toHaveBeenCalledTimes(2);
    const secondRequest = createMessage.mock.calls[1]?.[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(secondRequest.messages.at(-1)?.role).toBe("user");
  });

  it("posts an actionable fail message when sampling is rejected", async () => {
    const claim = fixture();
    let failBody: Record<string, unknown> | undefined;
    const bridge = {
      request: vi.fn(async (path: string, init?: RequestInit) => {
        if (path === "/v1/dispatch/claim") {
          return { claim, autoDispatch: true, maxTokens: 2048 };
        }
        if (path.endsWith("/progress")) {
          return {};
        }
        if (path.includes("/fail")) {
          failBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return {};
        }
        throw new Error(`Unexpected bridge path: ${path}`);
      }),
    } as unknown as McpBridgeClient;
    const createMessage = vi.fn(async () => {
      throw new Error("User rejected sampling request");
    });
    const server = { server: { createMessage } } as unknown as McpServer;
    const dispatcher = new SamplingDispatcher(server, bridge, "dispatcher-1");

    await expect(dispatcher.dispatchNext(false)).resolves.toBe("dispatched");
    expect(failBody?.dispatcherId).toBe("dispatcher-1");
    expect(String(failBody?.message)).toMatch(/Approve the Sampling prompt/i);
    expect(String(failBody?.message)).toMatch(/Retry|claim_task/i);
  });
});
