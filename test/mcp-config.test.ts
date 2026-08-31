import { describe, expect, it } from "vitest";
import { createMcpConfiguration } from "../src/mcp-config.js";

describe("createMcpConfiguration", () => {
  it("points the host at the bundled stdio server", () => {
    expect(
      createMcpConfiguration("/extensions/anchor/dist/mcp-server.cjs"),
    ).toEqual({
      mcpServers: {
        "anchor-agent": {
          command: "node",
          args: ["/extensions/anchor/dist/mcp-server.cjs"],
        },
      },
    });
  });

  it("adds a workspace routing hint when one is open", () => {
    expect(createMcpConfiguration("/server.cjs", "/workspace")).toEqual({
      mcpServers: {
        "anchor-agent": {
          command: "node",
          args: ["/server.cjs"],
          env: { ANCHOR_AGENT_WORKSPACE: "/workspace" },
        },
      },
    });
  });
});
