export type AnchorState =
  | "clean"
  | "shifted"
  | "modified"
  | "ambiguous"
  | "orphaned";

export type TaskState =
  | "created"
  | "queued"
  | "running"
  | "waitingForUser"
  | "ready"
  | "conflicted"
  | "applying"
  | "applied"
  | "rejected"
  | "cancelled"
  | "failed"
  | "orphaned"
  | "archived";

export interface TaskInstruction {
  id: string;
  text: string;
  parentRevisionId?: string;
  status: "pending" | "dispatching" | "completed" | "failed";
  revisionId?: string;
  dispatcherId?: string;
  leaseUntil?: number;
  dispatchAttempts: number;
  lastError?: string;
  createdAt: number;
}

export interface Revision {
  id: string;
  parentRevisionId?: string;
  instructionId?: string;
  instruction?: string;
  replacement: string;
  summary?: string;
  warnings: string[];
  basedOnDocumentVersion?: number;
  createdAt: number;
}

export interface TaskProgress {
  stage: string;
  message: string;
  percentage?: number;
}

export interface EditTask {
  id: string;
  title: string;
  instruction: string;
  documentUri: string;
  languageId: string;
  baseDocumentVersion: number;
  baseStart: number;
  baseEnd: number;
  currentStart: number;
  currentEnd: number;
  baseText: string;
  baseTextHash: string;
  documentSnapshot: string;
  anchorState: AnchorState;
  taskState: TaskState;
  sourceSessionId?: string;
  sourceNodeId?: string;
  branchId: string;
  /** native = host forked session; logical = task-local history only */
  branchMode?: "native" | "logical";
  instructions: TaskInstruction[];
  revisions: Revision[];
  activeRevisionId?: string;
  progress?: TaskProgress;
  clarification?: {
    question: string;
    options?: string[];
  };
  createdAt: number;
  updatedAt: number;
}

export interface TextChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export interface AnchorSpan {
  start: number;
  end: number;
  state: AnchorState;
}
