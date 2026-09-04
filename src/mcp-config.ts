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
    [key: string]: unknown;
  };
  mcpServers: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export const ANCHOR_AGENT_SERVER_KEY = "anchor-agent";

/** Existing MCP JSON after parse: empty file → null; otherwise a JSON object. */
export type ParsedMcpDocument = Record<string, unknown> | null;

export function createMcpConfiguration(
  serverPath: string,
  workspacePath?: string,
  target: McpConfigurationTarget = "standard",
  nodeCommand = "node",
): McpHostConfiguration {
  const server: McpServerEntry = {
    command: nodeCommand,
    args: [serverPath],
  };
  if (workspacePath) {
    server.env = { ANCHOR_AGENT_WORKSPACE: workspacePath };
  }
  if (target === "pi") {
    server.lifecycle = "keep-alive";
    return {
      settings: { sampling: true, samplingAutoApprove: false },
      mcpServers: { [ANCHOR_AGENT_SERVER_KEY]: server },
    };
  }
  return { mcpServers: { [ANCHOR_AGENT_SERVER_KEY]: server } };
}

/** Pretty-print MCP host JSON with a trailing newline. */
export function serializeMcpConfiguration(config: unknown): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Merge an Anchor Agent server entry into an existing MCP host document.
 * Preserves other servers and unrelated top-level / settings keys.
 * When the incoming config includes Pi sampling settings, only
 * `sampling` and `samplingAutoApprove` are updated under `settings`.
 */
export function mergeMcpConfiguration(
  existing: unknown,
  incoming: McpHostConfiguration,
): McpHostConfiguration {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const existingServersRaw = base.mcpServers;
  const existingServers =
    existingServersRaw &&
    typeof existingServersRaw === "object" &&
    !Array.isArray(existingServersRaw)
      ? { ...(existingServersRaw as Record<string, unknown>) }
      : {};

  const incomingServer = incoming.mcpServers[ANCHOR_AGENT_SERVER_KEY];
  if (!incomingServer) {
    throw new Error(
      `Incoming MCP configuration is missing "${ANCHOR_AGENT_SERVER_KEY}"`,
    );
  }
  existingServers[ANCHOR_AGENT_SERVER_KEY] = { ...incomingServer };

  const merged: Record<string, unknown> = {
    ...base,
    mcpServers: existingServers,
  };

  if (incoming.settings) {
    const existingSettingsRaw = base.settings;
    const existingSettings =
      existingSettingsRaw &&
      typeof existingSettingsRaw === "object" &&
      !Array.isArray(existingSettingsRaw)
        ? { ...(existingSettingsRaw as Record<string, unknown>) }
        : {};
    merged.settings = {
      ...existingSettings,
      sampling: incoming.settings.sampling,
      samplingAutoApprove: incoming.settings.samplingAutoApprove,
    };
  }

  return merged as McpHostConfiguration;
}

/**
 * Parse existing MCP JSON text. Empty / whitespace-only input yields null
 * (treated as no prior file). Invalid JSON throws.
 */
export function parseMcpConfigurationText(text: string): ParsedMcpDocument {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid MCP configuration JSON: ${message}`);
  }
  if (parsed === null) {
    return null;
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP configuration must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Build a unified-diff style preview of before → after for confirmation UIs.
 */
export function buildMcpConfigDiffPreview(
  beforeText: string,
  afterText: string,
  fileLabel: string,
): string {
  const beforeLines = splitLines(normalizeTextForDiff(beforeText));
  const afterLines = splitLines(normalizeTextForDiff(afterText));

  if (beforeLines.join("\n") === afterLines.join("\n")) {
    return `No changes for ${fileLabel}\n`;
  }

  const edits = diffLines(beforeLines, afterLines);
  const hunks = buildHunks(edits, 3);
  const parts = [`--- a/${fileLabel}`, `+++ b/${fileLabel}`];
  for (const hunk of hunks) {
    parts.push(
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
    );
    parts.push(...hunk.lines);
  }
  return `${parts.join("\n")}\n`;
}

function normalizeTextForDiff(text: string): string {
  if (text.length === 0) {
    return "";
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const withoutTrailing = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutTrailing.length === 0 ? [""] : withoutTrailing.split("\n");
}

type LineEdit =
  | { type: "equal"; lines: string[] }
  | { type: "add"; lines: string[] }
  | { type: "remove"; lines: string[] };

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/** LCS line diff suitable for small JSON documents. */
function diffLines(before: string[], after: string[]): LineEdit[] {
  const n = before.length;
  const m = after.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      if (before[i] === after[j]) {
        dp[i]![j] = (dp[i + 1]![j + 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
      }
    }
  }

  const edits: LineEdit[] = [];
  let i = 0;
  let j = 0;
  const push = (type: LineEdit["type"], line: string): void => {
    const last = edits.at(-1);
    if (last && last.type === type) {
      last.lines.push(line);
      return;
    }
    edits.push({ type, lines: [line] });
  };

  while (i < n && j < m) {
    if (before[i] === after[j]) {
      push("equal", before[i]!);
      i += 1;
      j += 1;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      push("remove", before[i]!);
      i += 1;
    } else {
      push("add", after[j]!);
      j += 1;
    }
  }
  while (i < n) {
    push("remove", before[i]!);
    i += 1;
  }
  while (j < m) {
    push("add", after[j]!);
    j += 1;
  }
  return edits;
}

function buildHunks(edits: LineEdit[], context: number): DiffHunk[] {
  // Flatten to tagged lines with old/new coordinates.
  type Tagged = {
    kind: " " | "+" | "-";
    text: string;
    oldLine: number | null;
    newLine: number | null;
  };
  const tagged: Tagged[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const edit of edits) {
    if (edit.type === "equal") {
      for (const line of edit.lines) {
        tagged.push({
          kind: " ",
          text: line,
          oldLine,
          newLine,
        });
        oldLine += 1;
        newLine += 1;
      }
    } else if (edit.type === "remove") {
      for (const line of edit.lines) {
        tagged.push({
          kind: "-",
          text: line,
          oldLine,
          newLine: null,
        });
        oldLine += 1;
      }
    } else {
      for (const line of edit.lines) {
        tagged.push({
          kind: "+",
          text: line,
          oldLine: null,
          newLine,
        });
        newLine += 1;
      }
    }
  }

  const changeIndexes = tagged
    .map((line, index) => (line.kind === " " ? -1 : index))
    .filter((index) => index >= 0);
  if (changeIndexes.length === 0) {
    return [];
  }

  const ranges: Array<{ start: number; end: number }> = [];
  let rangeStart = Math.max(0, changeIndexes[0]! - context);
  let rangeEnd = Math.min(tagged.length - 1, changeIndexes[0]! + context);
  for (const index of changeIndexes.slice(1)) {
    const nextStart = Math.max(0, index - context);
    const nextEnd = Math.min(tagged.length - 1, index + context);
    if (nextStart <= rangeEnd + 1) {
      rangeEnd = Math.max(rangeEnd, nextEnd);
    } else {
      ranges.push({ start: rangeStart, end: rangeEnd });
      rangeStart = nextStart;
      rangeEnd = nextEnd;
    }
  }
  ranges.push({ start: rangeStart, end: rangeEnd });

  return ranges.map(({ start, end }) => {
    const slice = tagged.slice(start, end + 1);
    const firstOld = slice.find((line) => line.oldLine !== null)?.oldLine ?? 1;
    const firstNew = slice.find((line) => line.newLine !== null)?.newLine ?? 1;
    const oldCount = slice.filter((line) => line.kind !== "+").length;
    const newCount = slice.filter((line) => line.kind !== "-").length;
    return {
      oldStart: firstOld,
      oldCount,
      newStart: firstNew,
      newCount,
      lines: slice.map((line) => `${line.kind}${line.text}`),
    };
  });
}
