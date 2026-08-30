import { diff3Merge } from "node-diff3";

interface OkRegion {
  ok: string[];
}

interface ConflictRegion {
  conflict: {
    a: string[];
    o: string[];
    b: string[];
  };
}

export interface ThreeWayMergeResult {
  merged: string;
  conflicted: boolean;
}

/** Merge Local and Remote changes derived independently from Base. */
export function threeWayMerge(
  base: string,
  local: string,
  remote: string,
): ThreeWayMergeResult {
  const regions = diff3Merge(
    tokenize(local),
    tokenize(base),
    tokenize(remote),
  ) as Array<OkRegion | ConflictRegion>;
  const output: string[] = [];
  let conflicted = false;
  for (const region of regions) {
    if ("ok" in region) {
      output.push(...region.ok);
    } else {
      conflicted = true;
    }
  }
  return { merged: conflicted ? "" : output.join(""), conflicted };
}

function tokenize(value: string): string[] {
  return value.match(/\s+|[^\s]+/gu) ?? [];
}
