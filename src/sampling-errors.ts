/**
 * Turn opaque sampling / bridge failures into short English messages that name
 * a likely cause and a next step (approve Sampling, fix MCP, Retry, claim manually).
 */
export function formatSamplingFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.trim() || "Unknown sampling failure";
  const lower = text.toLowerCase();

  if (isSamplingRejected(lower)) {
    return (
      "Sampling was rejected or not authorized. Approve the Sampling prompt in Pi " +
      "(or enable samplingAutoApprove), then click Retry. " +
      "Or claim the task manually with anchor.claim_task."
    );
  }

  if (isBridgeDisconnect(lower)) {
    return (
      "Could not reach the Anchor Agent bridge (extension disconnected or refused). " +
      "Confirm VS Code has Anchor Agent open for this workspace, fix MCP /reload, then Retry. " +
      "Or claim manually with anchor.claim_task."
    );
  }

  if (isInvalidCandidate(lower)) {
    return (
      "Sampling returned invalid or empty candidate JSON. Click Retry to generate again, " +
      "or claim manually with anchor.claim_task and submit a revision."
    );
  }

  if (isToolTurnLimit(lower)) {
    return (
      "Sampling hit the maximum tool-call turns without a candidate. Click Retry, " +
      "or claim manually with anchor.claim_task if automatic dispatch keeps failing."
    );
  }

  return (
    `Automatic sampling failed: ${text}. Click Retry after fixing Sampling/MCP, ` +
    "or claim manually with anchor.claim_task."
  );
}

function isSamplingRejected(lower: string): boolean {
  return (
    lower.includes("sampling") &&
    (lower.includes("reject") ||
      lower.includes("denied") ||
      lower.includes("unauthorized") ||
      lower.includes("not authorized") ||
      lower.includes("permission") ||
      lower.includes("cancelled") ||
      lower.includes("canceled") ||
      lower.includes("user declined") ||
      lower.includes("user refused"))
  );
}

function isInvalidCandidate(lower: string): boolean {
  return (
    lower.includes("did not contain a json candidate") ||
    lower.includes("did not contain text") ||
    lower.includes("invalid candidate") ||
    lower.includes("invalid json") ||
    (lower.includes("json") &&
      (lower.includes("parse") ||
        lower.includes("expected") ||
        lower.includes("unexpected"))) ||
    lower.includes("no candidate") ||
    lower.includes("empty text") ||
    lower.includes("empty response")
  );
}

function isToolTurnLimit(lower: string): boolean {
  return (
    lower.includes("maximum tool-call turns") ||
    lower.includes("max tool") ||
    lower.includes("tool-call turns") ||
    lower.includes("tool turn limit")
  );
}

function isBridgeDisconnect(lower: string): boolean {
  return (
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("network") ||
    lower.includes("socket hang up") ||
    lower.includes("bridge returned") ||
    lower.includes("bridge returned invalid json") ||
    lower.includes("no live anchor agent connection") ||
    lower.includes("unknown anchor agent connection") ||
    (lower.includes("bridge") &&
      (lower.includes("disconnect") ||
        lower.includes("connect") ||
        lower.includes("refused") ||
        lower.includes("unreachable"))) ||
    (lower.includes("connection") &&
      (lower.includes("refused") ||
        lower.includes("reset") ||
        lower.includes("closed") ||
        lower.includes("failed")))
  );
}
