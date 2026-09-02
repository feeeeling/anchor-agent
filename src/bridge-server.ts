import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import * as vscode from "vscode";
import { ExtensionConnectionRegistry } from "./extension-connection-registry.js";
import type { ClaimInstructionRequest, TaskService } from "./task-service.js";
import type { Revision, TaskProgress } from "./types.js";

const MAX_BODY_BYTES = 1_000_000;
const MAX_DOCUMENT_BYTES = 2_000_000;

export class BridgeServer implements vscode.Disposable {
  private readonly token = randomBytes(32).toString("hex");
  private readonly registry = new ExtensionConnectionRegistry();
  private server: Server | undefined;
  private endpoint: string | undefined;

  constructor(private readonly tasks: TaskService) {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not determine Anchor Agent bridge address");
    }
    this.endpoint = `http://127.0.0.1:${address.port}`;
    await this.registry.start({
      endpoint: this.endpoint,
      token: this.token,
      pid: process.pid,
      workspaceFolders:
        vscode.workspace.workspaceFolders?.map((folder) =>
          folder.uri.toString(),
        ) ?? [],
      ...(vscode.workspace.name
        ? { workspaceName: vscode.workspace.name }
        : {}),
    });
  }

  dispose(): void {
    this.server?.close();
    this.registry.dispose();
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (request.headers.authorization !== `Bearer ${this.token}`) {
        this.json(response, 401, { error: "Unauthorized" });
        return;
      }
      const url = new URL(request.url ?? "/", this.endpoint);
      const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
      const progressMatch = /^\/v1\/tasks\/([^/]+)\/progress$/.exec(
        url.pathname,
      );
      const revisionsMatch = /^\/v1\/tasks\/([^/]+)\/revisions$/.exec(
        url.pathname,
      );
      const clarificationMatch = /^\/v1\/tasks\/([^/]+)\/clarification$/.exec(
        url.pathname,
      );
      const branchMatch = /^\/v1\/tasks\/([^/]+)\/branch$/.exec(url.pathname);
      const dispatchFailureMatch =
        /^\/v1\/dispatch\/instructions\/([^/]+)\/fail$/.exec(url.pathname);

      if (request.method === "POST" && url.pathname === "/v1/dispatch/claim") {
        const body = await this.readBody(request);
        if (!isDispatchClaimRequest(body)) {
          throw new Error("dispatcherId, leaseMs, and mode are required");
        }
        if (body.mode === "auto" && !this.autoDispatchAllowed()) {
          this.json(response, 200, { claim: null, autoDispatch: false });
          return;
        }
        const claimRequest: ClaimInstructionRequest = {
          dispatcherId: body.dispatcherId,
          leaseMs: body.leaseMs,
          ...(body.taskId ? { taskId: body.taskId } : {}),
          ...(body.sourceSessionId
            ? { sourceSessionId: body.sourceSessionId }
            : {}),
          ...(body.sourceNodeId ? { sourceNodeId: body.sourceNodeId } : {}),
          ...(body.branchMode === "native" || body.branchMode === "logical"
            ? { branchMode: body.branchMode }
            : {}),
        };
        const claim = await this.tasks.claimInstruction(claimRequest);
        this.json(response, 200, {
          claim: claim ?? null,
          autoDispatch: true,
          maxTokens: this.samplingMaxTokens(),
        });
        return;
      }
      if (request.method === "POST" && dispatchFailureMatch?.[1]) {
        const body = await this.readBody(request);
        if (!isDispatchFailureRequest(body)) {
          throw new Error("dispatcherId and message are required");
        }
        await this.tasks.failInstruction(
          decodeURIComponent(dispatchFailureMatch[1]),
          body.dispatcherId,
          body.message,
        );
        this.json(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/tasks") {
        this.json(response, 200, {
          tasks: this.tasks.list().map((task) => this.tasks.publicView(task)),
        });
        return;
      }
      if (request.method === "GET" && taskMatch?.[1]) {
        const task = this.tasks.get(decodeURIComponent(taskMatch[1]));
        if (!task) {
          this.json(response, 404, { error: "Task not found" });
          return;
        }
        this.json(response, 200, this.tasks.publicView(task));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/documents") {
        await this.readDocument(url, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/search") {
        await this.searchWorkspace(await this.readBody(request), response);
        return;
      }
      if (request.method === "POST" && branchMatch?.[1]) {
        const body = await this.readBody(request);
        if (!isBranchBindRequest(body)) {
          throw new Error("branchMode must be native or logical");
        }
        const task = await this.tasks.bindBranch(
          decodeURIComponent(branchMatch[1]),
          body,
        );
        this.json(response, 200, this.tasks.publicView(task));
        return;
      }
      if (request.method === "POST" && progressMatch?.[1]) {
        const task = await this.tasks.reportProgress(
          decodeURIComponent(progressMatch[1]),
          await this.readBody<TaskProgress>(request),
        );
        this.json(response, 200, this.tasks.publicView(task));
        return;
      }
      if (request.method === "POST" && revisionsMatch?.[1]) {
        const body = await this.readBody<
          Omit<Revision, "id" | "createdAt" | "warnings"> & {
            warnings?: string[];
          }
        >(request);
        const revision = await this.tasks.submitRevision(
          decodeURIComponent(revisionsMatch[1]),
          body,
        );
        this.json(response, 201, revision);
        return;
      }
      if (request.method === "POST" && clarificationMatch?.[1]) {
        const body = await this.readBody<{
          question: string;
          options?: string[];
        }>(request);
        const task = await this.tasks.requestClarification(
          decodeURIComponent(clarificationMatch[1]),
          body.question,
          body.options,
        );
        this.json(response, 200, this.tasks.publicView(task));
        return;
      }
      this.json(response, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.json(response, 400, { error: message });
    }
  }

  private async readDocument(
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    const taskId = url.searchParams.get("taskId");
    const uriValue = url.searchParams.get("uri");
    const mode = url.searchParams.get("mode") ?? "snapshot";
    if (!taskId || !uriValue || (mode !== "snapshot" && mode !== "current")) {
      throw new Error("taskId, uri, and a valid mode are required");
    }
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Unknown task: ${taskId}`);
    }
    const isTaskDocument = task.documentUri === uriValue;
    if (!isTaskDocument && !this.workspaceReadsAllowed()) {
      throw new Error("Workspace reads are disabled");
    }
    const uri = vscode.Uri.parse(uriValue);
    if (!isTaskDocument && !vscode.workspace.getWorkspaceFolder(uri)) {
      throw new Error("Requested document is outside the workspace");
    }
    if (mode === "snapshot") {
      if (!isTaskDocument) {
        throw new Error("A snapshot is only available for the task document");
      }
      this.json(response, 200, {
        uri: uriValue,
        mode,
        version: task.baseDocumentVersion,
        content: task.documentSnapshot,
      });
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const content = document.getText();
    if (Buffer.byteLength(content, "utf8") > MAX_DOCUMENT_BYTES) {
      throw new Error("Document exceeds the 2 MB bridge limit");
    }
    this.json(response, 200, {
      uri: uriValue,
      mode,
      version: document.version,
      content,
    });
  }

  private async searchWorkspace(
    body: unknown,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.workspaceSearchAllowed()) {
      throw new Error("Workspace search is disabled");
    }
    if (!isSearchRequest(body)) {
      throw new Error("taskId and query are required");
    }
    if (!this.tasks.get(body.taskId)) {
      throw new Error(`Unknown task: ${body.taskId}`);
    }
    const maxResults = Math.min(Math.max(body.maxResults ?? 20, 1), 100);
    const matches: Array<{ uri: string; line: number; preview: string }> = [];
    const files = await vscode.workspace.findFiles(
      body.include ?? "**/*",
      "**/{.git,node_modules,dist,build}/**",
      500,
    );
    for (const uri of files) {
      if (matches.length >= maxResults) {
        break;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_DOCUMENT_BYTES || bytes.includes(0)) {
        continue;
      }
      const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (line.includes(body.query)) {
          matches.push({
            uri: uri.toString(),
            line: index + 1,
            preview: line.slice(0, 500),
          });
          if (matches.length >= maxResults) {
            break;
          }
        }
      }
    }
    this.json(response, 200, { matches });
  }

  private autoDispatchAllowed(): boolean {
    return vscode.workspace
      .getConfiguration("anchorAgent")
      .get("autoDispatch", true);
  }

  private samplingMaxTokens(): number {
    return vscode.workspace
      .getConfiguration("anchorAgent")
      .get("samplingMaxTokens", 8_192);
  }

  private workspaceReadsAllowed(): boolean {
    return vscode.workspace
      .getConfiguration("anchorAgent")
      .get("allowWorkspaceReads", true);
  }

  private workspaceSearchAllowed(): boolean {
    return vscode.workspace
      .getConfiguration("anchorAgent")
      .get("allowWorkspaceSearch", true);
  }

  private async readBody<T = unknown>(request: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > MAX_BODY_BYTES) {
        throw new Error("Request body is too large");
      }
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
    } catch {
      throw new Error("Request body must be valid JSON");
    }
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(body));
  }
}

function isDispatchClaimRequest(value: unknown): value is {
  dispatcherId: string;
  leaseMs: number;
  mode: "auto" | "manual";
  taskId?: string;
  sourceSessionId?: string;
  sourceNodeId?: string;
  branchMode?: "native" | "logical";
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.dispatcherId === "string" &&
    typeof candidate.leaseMs === "number" &&
    (candidate.mode === "auto" || candidate.mode === "manual")
  );
}

function isBranchBindRequest(value: unknown): value is {
  branchMode: "native" | "logical";
  sourceSessionId?: string;
  sourceNodeId?: string;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.branchMode === "native" || candidate.branchMode === "logical"
  );
}

function isDispatchFailureRequest(value: unknown): value is {
  dispatcherId: string;
  message: string;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.dispatcherId === "string" &&
    typeof candidate.message === "string"
  );
}

function isSearchRequest(value: unknown): value is {
  taskId: string;
  query: string;
  include?: string;
  maxResults?: number;
} {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.taskId === "string" && typeof candidate.query === "string"
  );
}
