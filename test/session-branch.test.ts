import { describe, expect, it, vi } from "vitest";
import {
  PARENT_WRITEBACK_POLICY,
  assertNoParentWriteback,
  claimFieldsFromBinding,
  createLogicalOnlyCapability,
  createPiSessionForkCapability,
  ensureTaskBranch,
} from "../src/session-branch.js";

describe("ensureTaskBranch", () => {
  it("forks from the current session node when native fork is supported", async () => {
    const forkFromCurrentNode = vi.fn(async (input) => {
      expect(input.currentSessionId).toBe("sess-parent");
      expect(input.currentNodeId).toBe("node-head");
      return { sessionId: "sess-fork", nodeId: "node-fork" };
    });

    const binding = await ensureTaskBranch({
      hasNativeFork: true,
      forkFromCurrentNode,
      currentSessionId: "sess-parent",
      currentNodeId: "node-head",
      existing: { branchId: "branch-1" },
    });

    expect(binding).toEqual({
      mode: "native",
      branchId: "branch-1",
      sourceSessionId: "sess-fork",
      sourceNodeId: "node-fork",
    });
    expect(forkFromCurrentNode).toHaveBeenCalledOnce();
    expect(claimFieldsFromBinding(binding)).toEqual({
      branchMode: "native",
      sourceSessionId: "sess-fork",
      sourceNodeId: "node-fork",
    });
  });

  it("reuses an already-bound native fork without forking again", async () => {
    const forkFromCurrentNode = vi.fn(async () => ({
      sessionId: "sess-new",
      nodeId: "node-new",
    }));

    const binding = await ensureTaskBranch({
      hasNativeFork: true,
      forkFromCurrentNode,
      currentSessionId: "sess-parent",
      currentNodeId: "node-head",
      existing: {
        branchId: "branch-1",
        branchMode: "native",
        sourceSessionId: "sess-fork",
        sourceNodeId: "node-fork",
      },
    });

    expect(binding.mode).toBe("native");
    expect(binding.sourceSessionId).toBe("sess-fork");
    expect(forkFromCurrentNode).not.toHaveBeenCalled();
  });

  it("falls back to logical branch without inventing native IDs", async () => {
    const binding = await ensureTaskBranch({
      hasNativeFork: false,
      existing: { branchId: "branch-logical" },
    });

    expect(binding).toEqual({
      mode: "logical",
      branchId: "branch-logical",
    });
    expect(binding.sourceSessionId).toBeUndefined();
    expect(binding.sourceNodeId).toBeUndefined();
  });

  it("keeps requested source IDs on the logical branch only", async () => {
    const binding = await ensureTaskBranch({
      hasNativeFork: true,
      // Missing current node → cannot native-fork; stay logical.
      currentSessionId: "sess-only",
      existing: { branchId: "branch-2" },
      requested: {
        sourceSessionId: "sess-assoc",
        sourceNodeId: "node-assoc",
      },
    });

    expect(binding).toEqual({
      mode: "logical",
      branchId: "branch-2",
      sourceSessionId: "sess-assoc",
      sourceNodeId: "node-assoc",
    });
  });

  it("falls back to logical when the host fork returns incomplete IDs", async () => {
    const binding = await ensureTaskBranch({
      hasNativeFork: true,
      forkFromCurrentNode: async () => ({ sessionId: "", nodeId: "" }),
      currentSessionId: "sess-parent",
      currentNodeId: "node-head",
      existing: { branchId: "branch-3" },
    });

    expect(binding.mode).toBe("logical");
    expect(binding.sourceSessionId).toBeUndefined();
    expect(binding.sourceNodeId).toBeUndefined();
  });
});

describe("Pi session fork capability stub", () => {
  it("enables native fork only when RPC and current node are provided", () => {
    expect(createLogicalOnlyCapability()).toEqual({ hasNativeFork: false });
    expect(
      createPiSessionForkCapability({
        currentSessionId: "s",
        currentNodeId: "n",
      }).hasNativeFork,
    ).toBe(false);
    expect(
      createPiSessionForkCapability({
        currentSessionId: "s",
        currentNodeId: "n",
        nativeFork: async () => ({ sessionId: "fs", nodeId: "fn" }),
      }).hasNativeFork,
    ).toBe(true);
  });
});

describe("no parent writeback invariant", () => {
  it("documents that candidates go only through Anchor revision APIs", () => {
    expect(PARENT_WRITEBACK_POLICY.writeCompletionSummaryToParent).toBe(false);
    expect(PARENT_WRITEBACK_POLICY.writeCandidateToParent).toBe(false);
    expect(PARENT_WRITEBACK_POLICY.candidateSubmissionChannel).toBe(
      "anchor.submit_revision",
    );
  });

  it("allows revision submission actions and rejects parent writeback", () => {
    expect(() =>
      assertNoParentWriteback([{ type: "anchor.submit_revision" }]),
    ).not.toThrow();
    expect(() =>
      assertNoParentWriteback([{ type: "parent_writeback" }]),
    ).toThrow(/Parent conversation writeback is forbidden/);
    expect(() =>
      assertNoParentWriteback([{ type: "write_parent_summary" }]),
    ).toThrow(/forbidden/);
  });
});
