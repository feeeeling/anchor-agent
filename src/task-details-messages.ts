import {
  STALL_HINT_CHECKLIST,
  shouldShowStallHints,
} from "./stall-hints.js";
import type { EditTask } from "./types.js";

const TERMINAL_STATES = new Set([
  "applied",
  "cancelled",
  "rejected",
  "archived",
]);

export type TaskDetailsInboundType =
  | "ready"
  | "accept"
  | "reject"
  | "copy"
  | "openDiff"
  | "continue"
  | "retry"
  | "cancel"
  | "answerClarification";

export interface TaskDetailsInboundMessage {
  type: TaskDetailsInboundType;
  instruction?: string;
  answer?: string;
}

export interface TaskDetailsViewModel {
  id: string;
  title: string;
  taskState: EditTask["taskState"];
  anchorState: EditTask["anchorState"];
  instruction: string;
  progress: string;
  lastError: string;
  showFailureError: boolean;
  baseText: string;
  localText: string;
  currentDocumentVersion: number;
  candidate: string;
  summary: string;
  warnings: string[];
  revisionCount: number;
  instructionCount: number;
  hasCandidate: boolean;
  canAccept: boolean;
  canReject: boolean;
  canCopy: boolean;
  canContinue: boolean;
  canRetry: boolean;
  waitingForUser: boolean;
  clarificationQuestion: string;
  clarificationOptions: string[];
  canAnswerClarification: boolean;
  showStallHints: boolean;
  stallHints: string[];
}

const SUPPORTED_INBOUND: readonly TaskDetailsInboundType[] = [
  "ready",
  "accept",
  "reject",
  "copy",
  "openDiff",
  "continue",
  "retry",
  "cancel",
  "answerClarification",
];

export function decodeTaskDetailsMessage(
  value: unknown,
): TaskDetailsInboundMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.type !== "string" ||
    !SUPPORTED_INBOUND.includes(candidate.type as TaskDetailsInboundType)
  ) {
    return undefined;
  }
  if (
    candidate.instruction !== undefined &&
    typeof candidate.instruction !== "string"
  ) {
    return undefined;
  }
  if (candidate.answer !== undefined && typeof candidate.answer !== "string") {
    return undefined;
  }
  return {
    type: candidate.type as TaskDetailsInboundType,
    ...(typeof candidate.instruction === "string"
      ? { instruction: candidate.instruction }
      : {}),
    ...(typeof candidate.answer === "string" ? { answer: candidate.answer } : {}),
  };
}

export function latestFailedInstruction(task: EditTask) {
  for (let index = task.instructions.length - 1; index >= 0; index -= 1) {
    const instruction = task.instructions[index];
    if (instruction?.status === "failed" && instruction.lastError) {
      return instruction;
    }
  }
  return undefined;
}

export function buildTaskDetailsViewModel(
  task: EditTask,
  options: {
    localText: string;
    currentDocumentVersion: number;
    now?: number;
  },
): TaskDetailsViewModel {
  const revision =
    task.revisions.find((item) => item.id === task.activeRevisionId) ??
    task.revisions.at(-1);
  const showStallHints = shouldShowStallHints(task, options.now);
  const failed = latestFailedInstruction(task);
  return {
    id: task.id,
    title: task.title,
    taskState: task.taskState,
    anchorState: task.anchorState,
    instruction: task.instruction,
    progress: task.progress?.message ?? "",
    lastError: failed?.lastError ?? "",
    showFailureError:
      task.taskState === "failed" || Boolean(failed?.lastError),
    baseText: task.baseText,
    localText: options.localText,
    currentDocumentVersion: options.currentDocumentVersion,
    candidate: revision?.replacement ?? "",
    summary: revision?.summary ?? "",
    warnings: revision?.warnings ?? [],
    revisionCount: task.revisions.length,
    instructionCount: task.instructions.length,
    hasCandidate: revision !== undefined,
    canAccept:
      revision !== undefined &&
      !TERMINAL_STATES.has(task.taskState) &&
      task.taskState !== "applying",
    canReject:
      revision !== undefined &&
      !TERMINAL_STATES.has(task.taskState) &&
      task.taskState !== "applying",
    canCopy: revision !== undefined,
    canContinue:
      !TERMINAL_STATES.has(task.taskState) && task.taskState !== "applying",
    canRetry:
      !TERMINAL_STATES.has(task.taskState) &&
      task.taskState !== "applying" &&
      task.instructions.some((item) => item.status === "failed"),
    waitingForUser: task.taskState === "waitingForUser",
    clarificationQuestion: task.clarification?.question ?? "",
    clarificationOptions: task.clarification?.options ?? [],
    canAnswerClarification:
      task.taskState === "waitingForUser" &&
      Boolean(task.clarification?.question),
    showStallHints,
    stallHints: showStallHints ? [...STALL_HINT_CHECKLIST] : [],
  };
}
