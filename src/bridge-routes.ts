export type BridgeRoute =
  | { kind: "claim" }
  | { kind: "dispatchFail"; instructionId: string }
  | { kind: "listTasks" }
  | { kind: "getTask"; taskId: string }
  | { kind: "documents" }
  | { kind: "search" }
  | { kind: "bindBranch"; taskId: string }
  | { kind: "progress"; taskId: string }
  | { kind: "revisions"; taskId: string }
  | { kind: "clarification"; taskId: string }
  | { kind: "notFound" };

/**
 * Resolve LocalBridge HTTP method + pathname to a typed route.
 * Unknown combinations return `notFound` so callers can emit 404.
 */
export function matchBridgeRoute(
  method: string,
  pathname: string,
): BridgeRoute {
  const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(pathname);
  const progressMatch = /^\/v1\/tasks\/([^/]+)\/progress$/.exec(pathname);
  const revisionsMatch = /^\/v1\/tasks\/([^/]+)\/revisions$/.exec(pathname);
  const clarificationMatch = /^\/v1\/tasks\/([^/]+)\/clarification$/.exec(
    pathname,
  );
  const branchMatch = /^\/v1\/tasks\/([^/]+)\/branch$/.exec(pathname);
  const dispatchFailureMatch =
    /^\/v1\/dispatch\/instructions\/([^/]+)\/fail$/.exec(pathname);

  if (method === "POST" && pathname === "/v1/dispatch/claim") {
    return { kind: "claim" };
  }
  if (method === "POST" && dispatchFailureMatch?.[1]) {
    return {
      kind: "dispatchFail",
      instructionId: decodeURIComponent(dispatchFailureMatch[1]),
    };
  }
  if (method === "GET" && pathname === "/v1/tasks") {
    return { kind: "listTasks" };
  }
  if (method === "GET" && taskMatch?.[1]) {
    return {
      kind: "getTask",
      taskId: decodeURIComponent(taskMatch[1]),
    };
  }
  if (method === "GET" && pathname === "/v1/documents") {
    return { kind: "documents" };
  }
  if (method === "POST" && pathname === "/v1/search") {
    return { kind: "search" };
  }
  if (method === "POST" && branchMatch?.[1]) {
    return {
      kind: "bindBranch",
      taskId: decodeURIComponent(branchMatch[1]),
    };
  }
  if (method === "POST" && progressMatch?.[1]) {
    return {
      kind: "progress",
      taskId: decodeURIComponent(progressMatch[1]),
    };
  }
  if (method === "POST" && revisionsMatch?.[1]) {
    return {
      kind: "revisions",
      taskId: decodeURIComponent(revisionsMatch[1]),
    };
  }
  if (method === "POST" && clarificationMatch?.[1]) {
    return {
      kind: "clarification",
      taskId: decodeURIComponent(clarificationMatch[1]),
    };
  }
  return { kind: "notFound" };
}

export function isDispatchClaimRequest(value: unknown): value is {
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

export function isBranchBindRequest(value: unknown): value is {
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

export function isDispatchFailureRequest(value: unknown): value is {
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

export function isSearchRequest(value: unknown): value is {
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
