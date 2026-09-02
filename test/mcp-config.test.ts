import { describe, expect, it } from "vitest";
import {
  buildMcpConfigDiffPreview,
  createMcpConfiguration,
  mergeMcpConfiguration,
  parseMcpConfigurationText,
  serializeMcpConfiguration,
} from "../src/mcp-config.js";

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

  it("keeps the server connected and enables approved sampling for Pi", () => {
    expect(createMcpConfiguration("/server.cjs", "/workspace", "pi")).toEqual({
      settings: { sampling: true, samplingAutoApprove: false },
      mcpServers: {
        "anchor-agent": {
          command: "node",
          args: ["/server.cjs"],
          env: { ANCHOR_AGENT_WORKSPACE: "/workspace" },
          lifecycle: "keep-alive",
        },
      },
    });
  });
});

describe("serializeMcpConfiguration", () => {
  it("pretty-prints JSON with a trailing newline", () => {
    expect(serializeMcpConfiguration({ mcpServers: {} })).toBe(
      '{\n  "mcpServers": {}\n}\n',
    );
  });
});

describe("parseMcpConfigurationText", () => {
  it("returns null for empty input", () => {
    expect(parseMcpConfigurationText("")).toBeNull();
    expect(parseMcpConfigurationText("  \n")).toBeNull();
  });

  it("parses valid JSON objects", () => {
    expect(parseMcpConfigurationText('{"mcpServers":{}}')).toEqual({
      mcpServers: {},
    });
  });

  it("throws on invalid JSON", () => {
    expect(() => parseMcpConfigurationText("{")).toThrow();
  });
});

describe("mergeMcpConfiguration", () => {
  const incoming = createMcpConfiguration("/server.cjs", "/ws", "pi");

  it("creates servers when the existing document is empty", () => {
    expect(mergeMcpConfiguration(null, incoming)).toEqual(incoming);
  });

  it("preserves unrelated servers and replaces anchor-agent", () => {
    const existing = {
      mcpServers: {
        other: { command: "uvx", args: ["demo"] },
        "anchor-agent": {
          command: "node",
          args: ["/old.cjs"],
        },
      },
    };
    const merged = mergeMcpConfiguration(existing, incoming);
    expect(merged.mcpServers.other).toEqual({
      command: "uvx",
      args: ["demo"],
    });
    expect(merged.mcpServers["anchor-agent"]).toEqual(
      incoming.mcpServers["anchor-agent"],
    );
  });

  it("merges Pi sampling settings without wiping unrelated settings", () => {
    const existing = {
      settings: {
        sampling: false,
        samplingAutoApprove: true,
        theme: "dark",
      },
      mcpServers: {
        other: { command: "npx", args: ["x"] },
      },
    };
    const merged = mergeMcpConfiguration(existing, incoming);
    expect(merged.settings).toEqual({
      sampling: true,
      samplingAutoApprove: false,
      theme: "dark",
    });
    expect(merged.mcpServers.other).toEqual({
      command: "npx",
      args: ["x"],
    });
  });

  it("does not invent settings when merging a standard host config", () => {
    const standard = createMcpConfiguration("/server.cjs", "/ws", "standard");
    const existing = {
      settings: { theme: "light" },
      mcpServers: {},
    };
    const merged = mergeMcpConfiguration(existing, standard);
    expect(merged.settings).toEqual({ theme: "light" });
    expect(merged.mcpServers["anchor-agent"]).toEqual(
      standard.mcpServers["anchor-agent"],
    );
  });

  it("preserves unrelated top-level keys", () => {
    const existing = {
      version: 1,
      mcpServers: {},
    };
    const merged = mergeMcpConfiguration(existing, incoming);
    expect(merged.version).toBe(1);
  });
});

describe("buildMcpConfigDiffPreview", () => {
  it("reports when before and after are identical", () => {
    const text = serializeMcpConfiguration({ mcpServers: {} });
    expect(buildMcpConfigDiffPreview(text, text, ".mcp.json")).toBe(
      "No changes for .mcp.json\n",
    );
  });

  it("emits a unified-diff preview for added content", () => {
    const after = serializeMcpConfiguration({
      mcpServers: {
        "anchor-agent": { command: "node", args: ["/server.cjs"] },
      },
    });
    const preview = buildMcpConfigDiffPreview("", after, ".mcp.json");
    expect(preview).toContain("--- a/.mcp.json");
    expect(preview).toContain("+++ b/.mcp.json");
    expect(preview).toContain('+  "mcpServers": {');
    expect(preview).toContain('+    "anchor-agent": {');
  });

  it("shows removed and added lines when merging updates a server path", () => {
    const before = serializeMcpConfiguration({
      mcpServers: {
        "anchor-agent": { command: "node", args: ["/old.cjs"] },
      },
    });
    const after = serializeMcpConfiguration({
      mcpServers: {
        "anchor-agent": { command: "node", args: ["/new.cjs"] },
      },
    });
    const preview = buildMcpConfigDiffPreview(before, after, "mcp.json");
    expect(preview).toContain("--- a/mcp.json");
    expect(preview).toContain('-        "/old.cjs"');
    expect(preview).toContain('+        "/new.cjs"');
  });
});
