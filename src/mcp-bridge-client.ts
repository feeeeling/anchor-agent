import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ConnectionDescriptor,
  PublicConnectionDescriptor,
} from "./connection-types.js";

export class McpBridgeClient {
  private readonly root =
    process.env.ANCHOR_AGENT_HOME ?? join(homedir(), ".anchor-agent");
  private readonly explicitDescriptorPath = process.env.ANCHOR_AGENT_DESCRIPTOR;
  private readonly workspaceHint = process.env.ANCHOR_AGENT_WORKSPACE;
  private selectedConnectionId: string | undefined;
  private cachedDescriptor: ConnectionDescriptor | undefined;

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const descriptor = await this.resolveDescriptor();
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

  async listConnections(): Promise<PublicConnectionDescriptor[]> {
    const descriptors = await this.readRegistry();
    const selected = await this.resolveDescriptor().catch(() => undefined);
    if (selected && !descriptors.some((item) => item.connectionId === selected.connectionId)) {
      descriptors.push(selected);
    }
    return descriptors.map(({ token: _, ...descriptor }) => ({
      ...descriptor,
      selected: descriptor.connectionId === selected?.connectionId,
    }));
  }

  async selectConnection(connectionId: string): Promise<void> {
    const descriptors = await this.readRegistry();
    const descriptor = descriptors.find((item) => item.connectionId === connectionId);
    if (!descriptor) {
      throw new Error(`Unknown Anchor Agent connection: ${connectionId}`);
    }
    this.selectedConnectionId = connectionId;
    this.cachedDescriptor = descriptor;
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

  private async resolveDescriptor(): Promise<ConnectionDescriptor> {
    if (this.cachedDescriptor) {
      return this.cachedDescriptor;
    }
    if (this.explicitDescriptorPath) {
      this.cachedDescriptor = await readDescriptor(this.explicitDescriptorPath);
      return this.cachedDescriptor;
    }
    const descriptors = await this.readRegistry();
    if (descriptors.length === 0) {
      throw new Error("No active Anchor Agent extension was found. Open the VS Code workspace first.");
    }
    let selected = this.selectedConnectionId
      ? descriptors.find((item) => item.connectionId === this.selectedConnectionId)
      : undefined;
    selected ??= this.workspaceHint
      ? descriptors.find((item) => matchesWorkspace(item, this.workspaceHint ?? ""))
      : undefined;
    if (!selected) {
      const activeId = await this.readActiveConnectionId();
      selected = activeId
        ? descriptors.find((item) => item.connectionId === activeId)
        : undefined;
    }
    selected ??= [...descriptors].sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!selected) {
      throw new Error("No usable Anchor Agent connection was found.");
    }
    this.cachedDescriptor = selected;
    return selected;
  }

  private async readRegistry(): Promise<ConnectionDescriptor[]> {
    const directory = join(this.root, "connections");
    const entries = await readdir(directory).catch(() => [] as string[]);
    const descriptors = (
      await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".json"))
          .map((entry) => readDescriptor(join(directory, entry)).catch(() => undefined)),
      )
    ).filter((value): value is ConnectionDescriptor => value !== undefined);
    const liveDescriptors = descriptors.filter((descriptor) => processIsAlive(descriptor.pid));
    if (liveDescriptors.length > 0) {
      return liveDescriptors;
    }
    const legacy = await readDescriptor(join(this.root, "connection.json")).catch(() => undefined);
    return legacy && processIsAlive(legacy.pid) ? [legacy] : [];
  }

  private async readActiveConnectionId(): Promise<string | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(join(this.root, "active.json"), "utf8"));
      if (value && typeof value === "object") {
        const connectionId = (value as Record<string, unknown>).connectionId;
        return typeof connectionId === "string" ? connectionId : undefined;
      }
    } catch {
      // No active-window hint is available.
    }
    return undefined;
  }
}

async function readDescriptor(path: string): Promise<ConnectionDescriptor> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Cannot read Anchor Agent connection descriptor: ${path}`);
  }
  const descriptor = decodeConnectionDescriptor(value);
  if (!descriptor) {
    throw new Error(`Invalid Anchor Agent connection descriptor: ${path}`);
  }
  return descriptor;
}

function decodeConnectionDescriptor(value: unknown): ConnectionDescriptor | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.endpoint !== "string" ||
    typeof candidate.token !== "string" ||
    typeof candidate.pid !== "number" ||
    !Array.isArray(candidate.workspaceFolders) ||
    !candidate.workspaceFolders.every((item) => typeof item === "string") ||
    typeof candidate.updatedAt !== "number"
  ) {
    return undefined;
  }
  return {
    connectionId:
      typeof candidate.connectionId === "string"
        ? candidate.connectionId
        : `legacy-${candidate.pid}`,
    endpoint: candidate.endpoint,
    token: candidate.token,
    pid: candidate.pid,
    workspaceFolders: candidate.workspaceFolders,
    updatedAt: candidate.updatedAt,
    ...(typeof candidate.workspaceName === "string"
      ? { workspaceName: candidate.workspaceName }
      : {}),
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function matchesWorkspace(descriptor: ConnectionDescriptor, hint: string): boolean {
  const normalizedHint = normalizeWorkspace(hint);
  return descriptor.workspaceFolders.some(
    (folder) => normalizeWorkspace(folder) === normalizedHint,
  );
}

function normalizeWorkspace(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") {
      return decodeURIComponent(url.pathname).replace(/\/$/u, "").toLowerCase();
    }
  } catch {
    // Plain filesystem path or workspace label.
  }
  return value.replace(/\/$/u, "").toLowerCase();
}
