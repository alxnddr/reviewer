import { describe, expect, it } from "vitest";
import { MOVED_BLOCK_PATCH } from "../../../../shared/diff/fixtures";
import { ANALYSIS_CACHE_KEY, parsePatch } from "../../../../shared/diff/patch";
import { NO_FILES } from "../soloed-diff";
import { movedBlocksFor, NO_MOVED_BLOCKS } from "./moved-blocks";

// The memo is the whole module, and the property worth pinning is identity: the items builder
// keys a `useMemo` on this array, so a fresh one per call would rebuild every item on every
// render — and re-run a ~7 ms pass on the way.

describe("movedBlocksFor", () => {
  it("answers the same array for the same file list", () => {
    const files = parsePatch(MOVED_BLOCK_PATCH, ANALYSIS_CACHE_KEY);
    const first = movedBlocksFor(files);
    expect(movedBlocksFor(files)).toBe(first);
    expect(first).toHaveLength(1);
  });

  it("re-detects for a differently-identified list of the same patch", () => {
    // A reload replaces `diff.files` wholesale, which is exactly when the answer must be
    // recomputed rather than served from the old diff's entry.
    const reloaded = parsePatch(MOVED_BLOCK_PATCH, ANALYSIS_CACHE_KEY);
    const again = parsePatch(MOVED_BLOCK_PATCH, ANALYSIS_CACHE_KEY);
    expect(movedBlocksFor(reloaded)).not.toBe(movedBlocksFor(again));
    expect(movedBlocksFor(reloaded)).toEqual(movedBlocksFor(again));
  });

  it("finds nothing in a diff with no files, and has a stable empty list for one", () => {
    // `NO_FILES` is the same shared empty list every fileless diff phase hands around, so
    // this is also the assertion that the pass costs nothing on a session that never loaded.
    expect(movedBlocksFor(NO_FILES)).toEqual([]);
    expect(NO_MOVED_BLOCKS).toEqual([]);
  });
});
