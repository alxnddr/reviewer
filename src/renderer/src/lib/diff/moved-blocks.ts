import { detectMovedBlocks, type MovedBlock } from "../../../../shared/diff/moved";
import type { PatchFile } from "../../../../shared/diff/patch";

// Where the moved-block fact is computed, and the answer to "not per render".
//
// `detectMovedBlocks` is pure and cheap *for a pass over the whole diff* — ~7 ms on a real
// one, ~40 ms on a synthetic diff an order of magnitude larger (`moved.ts`) — which is
// nothing once per load and far too much in a render body that runs on every keystroke in
// the find bar. So it is memoised on the identity of the file list, exactly as
// `lib/soloed-diff.ts` memoises the coverage walk, and for the same reason: `diff.files` is
// replaced wholesale on load and never mutated in place, so identity is the honest key and
// a `WeakMap` lets a closed session's answer be collected with the diff it was about.
//
// It is deliberately keyed on the **full** loaded file list rather than a solo's subset.
// A move is a fact about the review; which files are on screen is a question about the
// reader. Computing it per solo would cost the pass again on every chapter step and could
// answer differently each time — with a file hidden, a deletion run is free to match some
// *other* addition run, so one line could read "moved from A" in the full diff and "moved
// from B" inside a chapter. The one place the solo is allowed to matter is whether a note
// is drawn at all (`movedAnnotationsByFile`).

const cache = new WeakMap<readonly PatchFile[], MovedBlock[]>();

/** The moved blocks of one loaded diff, computed once per file list. Same array in, same
 * array out — so a `useMemo` keyed on it does not rebuild the items underneath it. */
export function movedBlocksFor(files: readonly PatchFile[]): MovedBlock[] {
  const hit = cache.get(files);
  if (hit !== undefined) {
    return hit;
  }
  const blocks = detectMovedBlocks(files);
  cache.set(files, blocks);
  return blocks;
}

/** A stable empty list for the diff phases that have no files, so a caller does not key a
 * cache entry — or fail a memo — with a fresh `[]` per render. */
export const NO_MOVED_BLOCKS: readonly MovedBlock[] = [];
