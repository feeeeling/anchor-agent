import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpBridgeClient } from "../src/mcp-bridge-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.ANCHOR_AGENT_HOME;
  delete process.env.ANCHOR_AGENT_WORKSPACE;
  delete process.env.ANCHOR_AGENT_DESCRIPTOR;
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("McpBridgeClient connection selection", () => {
  it("selects a connection matching the workspace hint", async () => {
    const root = await createRoot();
    process.env.ANCHOR_AGENT_HOME = root;
    process.env.ANCHOR_AGENT_WORKSPACE = "/workspace/two";
    await writeDescriptor(
      root,
      "one",
      "http://127.0.0.1:1",
      "file:///workspace/one",
      1,
    );
    await writeDescriptor(
      root,
      "two",
      "http://127.0.0.1:2",
      "file:///workspace/two",
      2,
    );

    const client = new McpBridgeClient();
    const connections = await client.listConnections();

    expect(
      connections.find((item) => item.connectionId === "two")?.selected,
    ).toBe(true);
  });

  it("allows an explicit connection selection", async () => {
    const root = await createRoot();
    process.env.ANCHOR_AGENT_HOME = root;
    await writeDescriptor(
      root,
      "one",
      "http://127.0.0.1:1",
      "file:///workspace/one",
      1,
    );
    await writeDescriptor(
      root,
      "two",
      "http://127.0.0.1:2",
      "file:///workspace/two",
      2,
    );
    const client = new McpBridgeClient();

    await client.selectConnection("one");

    expect(
      (await client.listConnections()).find(
        (item) => item.connectionId === "one",
      )?.selected,
    ).toBe(true);
  });

  it("prefers the focused-window active.json hint", async () => {
    const root = await createRoot();
    process.env.ANCHOR_AGENT_HOME = root;
    await writeDescriptor(
      root,
      "one",
      "http://127.0.0.1:1",
      "file:///workspace/one",
      10,
    );
    await writeDescriptor(
      root,
      "two",
      "http://127.0.0.1:2",
      "file:///workspace/two",
      20,
    );
    await writeFile(
      join(root, "active.json"),
      JSON.stringify({ connectionId: "one" }),
    );

    const client = new McpBridgeClient();
    const connections = await client.listConnections();
    expect(
      connections.find((item) => item.connectionId === "one")?.selected,
    ).toBe(true);
  });

  it("ignores dead process descriptors and falls back to live ones", async () => {
    const root = await createRoot();
    process.env.ANCHOR_AGENT_HOME = root;
    await writeDescriptor(
      root,
      "dead",
      "http://127.0.0.1:1",
      "file:///workspace/dead",
      99,
      2_147_483_646,
    );
    await writeDescriptor(
      root,
      "live",
      "http://127.0.0.1:2",
      "file:///workspace/live",
      1,
    );

    const client = new McpBridgeClient();
    const connections = await client.listConnections();
    expect(connections.map((item) => item.connectionId)).toEqual(["live"]);
    expect(connections[0]?.selected).toBe(true);
  });

  it("throws when selecting an unknown connection", async () => {
    const root = await createRoot();
    process.env.ANCHOR_AGENT_HOME = root;
    await writeDescriptor(
      root,
      "one",
      "http://127.0.0.1:1",
      "file:///workspace/one",
      1,
    );
    const client = new McpBridgeClient();
    await expect(client.selectConnection("missing")).rejects.toThrow(
      /Unknown Anchor Agent connection/,
    );
  });

  it("surfaces a clear error when no extension connections exist", async () => {
    const root = await createRoot();
    process.env.ANCHOR_AGENT_HOME = root;
    const client = new McpBridgeClient();
    await expect(client.request("/v1/tasks")).rejects.toThrow(
      /No active Anchor Agent extension/,
    );
  });
});

describe("McpBridgeClient request and toolResult errors", () => {
  it("rejects non-OK bridge responses with status text", async () => {
    const root = await createRoot();
    process.env.ANCHOR_AGENT_HOME = root;
    await writeDescriptor(
      root,
      "one",
      "http://127.0.0.1:9",
      "file:///workspace/one",
      1,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ error: "Not found" }),
      })),
    );
    const client = new McpBridgeClient();
    await expect(client.request("/v1/tasks/missing")).rejects.toThrow(
      /Anchor bridge returned 404/,
    );
  });

  it("wraps request failures as MCP toolResult errors", async () => {
    const root = await createRoot();
    process.env.ANCHOR_AGENT_HOME = root;
    await writeDescriptor(
      root,
      "one",
      "http://127.0.0.1:9",
      "file:///workspace/one",
      1,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      })),
    );
    const client = new McpBridgeClient();
    const result = await client.toolResult("/v1/tasks");
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/401|Unauthorized/);
  });

  it("returns JSON payloads for successful bridge requests", async () => {
    const root = await createRoot();
    process.env.ANCHOR_AGENT_HOME = root;
    await writeDescriptor(
      root,
      "one",
      "http://127.0.0.1:9",
      "file:///workspace/one",
      1,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("http://127.0.0.1:9/v1/tasks");
        expect(init?.headers).toMatchObject({
          authorization: "Bearer token-one",
        });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ tasks: [] }),
        };
      }),
    );
    const client = new McpBridgeClient();
    await expect(client.request("/v1/tasks")).resolves.toEqual({ tasks: [] });
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "anchor-connections-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "connections"), { recursive: true });
  return root;
}

async function writeDescriptor(
  root: string,
  connectionId: string,
  endpoint: string,
  workspace: string,
  updatedAt: number,
  pid = process.pid,
): Promise<void> {
  await writeFile(
    join(root, "connections", `${connectionId}.json`),
    JSON.stringify({
      connectionId,
      endpoint,
      token: `token-${connectionId}`,
      pid,
      workspaceFolders: [workspace],
      updatedAt,
    }),
  );
}

describe("McpBridgeClient routing extras", () => {
  it("keeps the cached connection after active.json changes", async () => {
    const root = await createRoot();
    process.env.ANCHOR_AGENT_HOME = root;
    delete process.env.ANCHOR_AGENT_WORKSPACE;
    await writeDescriptor(
      root,
      "one",
      "http://127.0.0.1:1",
      "file:///workspace/one",
      1,
    );
    await writeDescriptor(
      root,
      "two",
      "http://127.0.0.1:2",
      "file:///workspace/two",
      2,
    );
    await writeFile(
      join(root, "active.json"),
      JSON.stringify({ connectionId: "one" }),
    );

    const client = new McpBridgeClient();
    expect(
      (await client.listConnections()).find((item) => item.selected)
        ?.connectionId,
    ).toBe("one");

    await writeFile(
      join(root, "active.json"),
      JSON.stringify({ connectionId: "two" }),
    );

    expect(
      (await client.listConnections()).find((item) => item.selected)
        ?.connectionId,
    ).toBe("one");
  });

  it("uses ANCHOR_AGENT_DESCRIPTOR when set at construction", async () => {
    const root = await createRoot();
    process.env.ANCHOR_AGENT_HOME = root;
    const descriptorPath = join(root, "explicit.json");
    await writeFile(
      descriptorPath,
      JSON.stringify({
        connectionId: "explicit",
        endpoint: "http://127.0.0.1:9",
        token: "token-explicit",
        pid: process.pid,
        workspaceFolders: ["file:///workspace/explicit"],
        updatedAt: 1,
      }),
    );
    process.env.ANCHOR_AGENT_DESCRIPTOR = descriptorPath;
    await writeDescriptor(
      root,
      "other",
      "http://127.0.0.1:2",
      "file:///workspace/other",
      99,
    );

    const client = new McpBridgeClient();
    const connections = await client.listConnections();

    expect(
      connections.find((item) => item.connectionId === "explicit")?.selected,
    ).toBe(true);
  });
});
