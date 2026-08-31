import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpBridgeClient } from "../src/mcp-bridge-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.ANCHOR_AGENT_HOME;
  delete process.env.ANCHOR_AGENT_WORKSPACE;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("McpBridgeClient connection selection", () => {
  it("selects a connection matching the workspace hint", async () => {
    const root = await createRoot();
    process.env.ANCHOR_AGENT_HOME = root;
    process.env.ANCHOR_AGENT_WORKSPACE = "/workspace/two";
    await writeDescriptor(root, "one", "http://127.0.0.1:1", "file:///workspace/one", 1);
    await writeDescriptor(root, "two", "http://127.0.0.1:2", "file:///workspace/two", 2);

    const client = new McpBridgeClient();
    const connections = await client.listConnections();

    expect(connections.find((item) => item.connectionId === "two")?.selected).toBe(true);
  });

  it("allows an explicit connection selection", async () => {
    const root = await createRoot();
    process.env.ANCHOR_AGENT_HOME = root;
    await writeDescriptor(root, "one", "http://127.0.0.1:1", "file:///workspace/one", 1);
    await writeDescriptor(root, "two", "http://127.0.0.1:2", "file:///workspace/two", 2);
    const client = new McpBridgeClient();

    await client.selectConnection("one");

    expect((await client.listConnections()).find((item) => item.connectionId === "one")?.selected).toBe(true);
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
): Promise<void> {
  await writeFile(
    join(root, "connections", `${connectionId}.json`),
    JSON.stringify({
      connectionId,
      endpoint,
      token: `token-${connectionId}`,
      pid: process.pid,
      workspaceFolders: [workspace],
      updatedAt,
    }),
  );
}
