import type { AnchorSpan, TextChange } from "./types.js";

/**
 * Applies an editor change event to a half-open anchor range. Changes are
 * processed from the end of the original document so their original offsets
 * remain valid while lower offsets are transformed.
 */
export function transformAnchor(anchor: AnchorSpan, changes: readonly TextChange[]): AnchorSpan {
  let current = { ...anchor };
  const ordered = [...changes].sort((left, right) => right.rangeOffset - left.rangeOffset);

  for (const change of ordered) {
    current = transformOne(current, change);
  }

  if (current.end <= current.start && current.state === "modified") {
    return { ...current, end: current.start, state: "orphaned" };
  }
  return current;
}

function transformOne(anchor: AnchorSpan, change: TextChange): AnchorSpan {
  const changeStart = change.rangeOffset;
  const changeEnd = change.rangeOffset + change.rangeLength;
  const insertedLength = change.text.length;
  const delta = insertedLength - change.rangeLength;

  if (change.rangeLength === 0) {
    if (changeStart <= anchor.start) {
      return {
        start: anchor.start + insertedLength,
        end: anchor.end + insertedLength,
        state: shiftedState(anchor.state),
      };
    }
    if (changeStart >= anchor.end) {
      return anchor;
    }
    return {
      start: anchor.start,
      end: anchor.end + insertedLength,
      state: "modified",
    };
  }

  if (changeEnd <= anchor.start) {
    return {
      start: anchor.start + delta,
      end: anchor.end + delta,
      state: shiftedState(anchor.state),
    };
  }
  if (changeStart >= anchor.end) {
    return anchor;
  }

  const start = Math.min(anchor.start, changeStart);
  const end = anchor.end >= changeEnd ? anchor.end + delta : changeStart + insertedLength;
  return {
    start,
    end: Math.max(start, end),
    state: "modified",
  };
}

function shiftedState(state: AnchorSpan["state"]): AnchorSpan["state"] {
  return state === "clean" ? "shifted" : state;
}
