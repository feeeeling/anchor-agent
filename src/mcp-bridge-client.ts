import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

interface ConnectionDescriptor {
  endpoint: string;
  token: string;
}

export class McpBridgeClient {
  private readonly descriptorPath =
    process.env.ANCHOR_AGENT_DESCRIPTOR ?? join(homedir(), ".anchor-agent", "connection.json");

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const descriptor = await this.loadDescriptor();
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
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("Anchor bridge returned invalid JSON");
    }
  }

  async toolResult(path: string, init: RequestInit = {}) {
    try {
      const value = await this.request<unknown>(path, init);
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

  private async loadDescriptor(): Promise<ConnectionDescriptor> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.descriptorPath, "utf8"));
    } catch {
      throw new Error(
        "No active Anchor Agent extension was found. Open the VS Code workspace first.",
      );
    }
    if (!value || typeof value !== "object") {
      throw new Error("The Anchor Agent connection descriptor is invalid.");
    }
    const descriptor = value as Record<string, unknown>;
    if (
      typeof descriptor.endpoint !== "string" ||
      typeof descriptor.token !== "string"
    ) {
      throw new Error("The Anchor Agent connection descriptor is incomplete.");
    }
    return { endpoint: descriptor.endpoint, token: descriptor.token };
  }
}
