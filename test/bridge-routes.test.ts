import { describe, expect, it } from "vitest";
import {
  isBranchBindRequest,
  isDispatchClaimRequest,
  isDispatchFailureRequest,
  isSearchRequest,
  matchBridgeRoute,
} from "../src/bridge-routes.js";

describe("matchBridgeRoute", () => {
  it("maps LocalBridge paths used by claim, tasks, and branch bind", () => {
    expect(matchBridgeRoute("POST", "/v1/dispatch/claim")).toEqual({
      kind: "claim",
    });
    expect(
      matchBridgeRoute("POST", "/v1/dispatch/instructions/inst%2F1/fail"),
    ).toEqual({ kind: "dispatchFail", instructionId: "inst/1" });
    expect(matchBridgeRoute("GET", "/v1/tasks")).toEqual({ kind: "listTasks" });
    expect(matchBridgeRoute("GET", "/v1/tasks/task%2F1")).toEqual({
      kind: "getTask",
      taskId: "task/1",
    });
    expect(matchBridgeRoute("GET", "/v1/documents")).toEqual({
      kind: "documents",
    });
    expect(matchBridgeRoute("POST", "/v1/search")).toEqual({ kind: "search" });
    expect(matchBridgeRoute("POST", "/v1/tasks/t1/branch")).toEqual({
      kind: "bindBranch",
      taskId: "t1",
    });
    expect(matchBridgeRoute("POST", "/v1/tasks/t1/progress")).toEqual({
      kind: "progress",
      taskId: "t1",
    });
    expect(matchBridgeRoute("POST", "/v1/tasks/t1/revisions")).toEqual({
      kind: "revisions",
      taskId: "t1",
    });
    expect(matchBridgeRoute("POST", "/v1/tasks/t1/clarification")).toEqual({
      kind: "clarification",
      taskId: "t1",
    });
    expect(matchBridgeRoute("GET", "/v1/unknown")).toEqual({ kind: "notFound" });
    expect(matchBridgeRoute("DELETE", "/v1/tasks")).toEqual({
      kind: "notFound",
    });
  });
});

describe("bridge request guards", () => {
  it("validates claim, branch, failure, and search bodies", () => {
    expect(
      isDispatchClaimRequest({
        dispatcherId: "d1",
        leaseMs: 1000,
        mode: "auto",
      }),
    ).toBe(true);
    expect(
      isDispatchClaimRequest({ dispatcherId: "d1", leaseMs: 1000 }),
    ).toBe(false);

    expect(isBranchBindRequest({ branchMode: "logical" })).toBe(true);
    expect(isBranchBindRequest({ branchMode: "native" })).toBe(true);
    expect(isBranchBindRequest({ branchMode: "other" })).toBe(false);

    expect(
      isDispatchFailureRequest({ dispatcherId: "d1", message: "boom" }),
    ).toBe(true);
    expect(isDispatchFailureRequest({ dispatcherId: "d1" })).toBe(false);

    expect(isSearchRequest({ taskId: "t1", query: "hello" })).toBe(true);
    expect(isSearchRequest({ taskId: "t1" })).toBe(false);
  });
});
