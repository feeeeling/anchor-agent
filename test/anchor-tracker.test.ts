import { describe, expect, it } from "vitest";
import { transformAnchor } from "../src/anchor-range.js";

const clean = { start: 10, end: 20, state: "clean" as const };

describe("transformAnchor", () => {
  it("shifts an anchor when text is inserted before it", () => {
    expect(
      transformAnchor(clean, [{ rangeOffset: 2, rangeLength: 0, text: "abc" }]),
    ).toEqual({
      start: 13,
      end: 23,
      state: "shifted",
    });
  });

  it("treats insertion at the start boundary as outside the anchor", () => {
    expect(
      transformAnchor(clean, [
        { rangeOffset: 10, rangeLength: 0, text: "abc" },
      ]),
    ).toEqual({
      start: 13,
      end: 23,
      state: "shifted",
    });
  });

  it("treats insertion at the end boundary as outside the anchor", () => {
    expect(
      transformAnchor(clean, [
        { rangeOffset: 20, rangeLength: 0, text: "abc" },
      ]),
    ).toEqual(clean);
  });

  it("marks an insertion inside the anchor as modified", () => {
    expect(
      transformAnchor(clean, [
        { rangeOffset: 15, rangeLength: 0, text: "abc" },
      ]),
    ).toEqual({
      start: 10,
      end: 23,
      state: "modified",
    });
  });

  it("tracks a replacement inside the anchor", () => {
    expect(
      transformAnchor(clean, [{ rangeOffset: 12, rangeLength: 3, text: "x" }]),
    ).toEqual({
      start: 10,
      end: 18,
      state: "modified",
    });
  });

  it("marks complete deletion as orphaned", () => {
    expect(
      transformAnchor(clean, [{ rangeOffset: 10, rangeLength: 10, text: "" }]),
    ).toEqual({
      start: 10,
      end: 10,
      state: "orphaned",
    });
  });

  it("handles multiple changes expressed against the original document", () => {
    expect(
      transformAnchor(clean, [
        { rangeOffset: 2, rangeLength: 0, text: "a" },
        { rangeOffset: 5, rangeLength: 0, text: "b" },
      ]),
    ).toEqual({ start: 12, end: 22, state: "shifted" });
  });
});
