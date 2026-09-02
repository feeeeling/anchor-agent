export type McpConfigurationTarget = "standard" | "pi";

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
  lifecycle?: "keep-alive";
}

export interface McpHostConfiguration {
  settings?: {
    sampling: boolean;
    samplingAutoApprove: boolean;
  };
  mcpServers: Record<string, McpServerEntry>;
}

export function createMcpConfiguration(
  serverPath: string,
  workspacePath?: string,
  target: McpConfigurationTarget = "standard",
): McpHostConfiguration {
  const server: McpServerEntry = {
    command: "node",
    args: [serverPath],
  };
  if (workspacePath) {
    server.env = { ANCHOR_AGENT_WORKSPACE: workspacePath };
  }
  if (target === "pi") {
    server.lifecycle = "keep-alive";
    return {
      settings: { sampling: true, samplingAutoApprove: false },
      mcpServers: { "anchor-agent": server },
    };
  }
  return { mcpServers: { "anchor-agent": server } };
}
