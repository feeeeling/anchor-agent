import { describe, expect, it } from "vitest";
import { threeWayMerge } from "../src/three-way-merge.js";

describe("threeWayMerge", () => {
  it("combines independent local and remote prose edits", () => {
    expect(
      threeWayMerge(
        "The quick brown fox.",
        "The very quick brown fox.",
        "The quick brown cat.",
      ),
    ).toEqual({ merged: "The very quick brown cat.", conflicted: false });
  });

  it("reports overlapping edits as a conflict", () => {
    expect(
      threeWayMerge(
        "The quick brown fox.",
        "The quick brown dog.",
        "The quick brown cat.",
      ).conflicted,
    ).toBe(true);
  });

  it("accepts identical changes as a false conflict", () => {
    expect(threeWayMerge("one two", "one three", "one three")).toEqual({
      merged: "one three",
      conflicted: false,
    });
  });
});
