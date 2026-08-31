import { randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import type { ConnectionDescriptor } from "./connection-types.js";

const ROOT = join(homedir(), ".anchor-agent");
const CONNECTIONS = join(ROOT, "connections");
const ACTIVE_PATH = join(ROOT, "active.json");
const LEGACY_PATH = join(ROOT, "connection.json");

export class ExtensionConnectionRegistry implements vscode.Disposable {
  readonly connectionId = randomBytes(12).toString("hex");
  private descriptor: ConnectionDescriptor | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private windowSubscription: vscode.Disposable | undefined;

  async start(
    input: Omit<ConnectionDescriptor, "connectionId" | "updatedAt">,
  ): Promise<void> {
    this.descriptor = {
      ...input,
      connectionId: this.connectionId,
      updatedAt: Date.now(),
    };
    await mkdir(CONNECTIONS, { recursive: true, mode: 0o700 });
    await this.write(vscode.window.state.focused);
    this.windowSubscription = vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        void this.write(true);
      }
    });
    this.heartbeat = setInterval(() => {
      void this.write(vscode.window.state.focused);
    }, 10_000);
    this.heartbeat.unref();
  }

  dispose(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
    }
    this.windowSubscription?.dispose();
    void this.removeOwnedFiles();
  }

  private async write(markActive: boolean): Promise<void> {
    if (!this.descriptor) {
      return;
    }
    this.descriptor.updatedAt = Date.now();
    const path = join(CONNECTIONS, `${this.connectionId}.json`);
    await writeJsonAtomic(path, this.descriptor);
    if (markActive) {
      await Promise.all([
        writeJsonAtomic(ACTIVE_PATH, { connectionId: this.connectionId }),
        writeJsonAtomic(LEGACY_PATH, this.descriptor),
      ]);
    }
  }

  private async removeOwnedFiles(): Promise<void> {
    await unlink(join(CONNECTIONS, `${this.connectionId}.json`)).catch(
      () => undefined,
    );
    await Promise.all([
      removeIfOwned(ACTIVE_PATH, this.connectionId),
      removeIfOwned(LEGACY_PATH, this.connectionId),
    ]);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function removeIfOwned(
  path: string,
  connectionId: string,
): Promise<void> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    if (value.connectionId === connectionId) {
      await unlink(path);
    }
  } catch {
    // The pointer belongs to another window or has already been removed.
  }
}
