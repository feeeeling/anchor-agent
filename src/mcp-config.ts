export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpHostConfiguration {
  mcpServers: Record<string, McpServerEntry>;
}

export function createMcpConfiguration(
  serverPath: string,
  workspacePath?: string,
): McpHostConfiguration {
  const server: McpServerEntry = {
    command: "node",
    args: [serverPath],
  };
  if (workspacePath) {
    server.env = { ANCHOR_AGENT_WORKSPACE: workspacePath };
  }
  return { mcpServers: { "anchor-agent": server } };
}
