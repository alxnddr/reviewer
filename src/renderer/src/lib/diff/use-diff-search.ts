import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { CommentSlot } from "../../../../shared/diff/comment-annotations";
import type { PatchFile } from "../../../../shared/diff/patch";
import { clamp } from "../../../../shared/clamp";
import {
  buildSearchIndex,
  findMatches,
  partialSignature,
  type DiffLineRef,
  type SearchIndexLine,
} from "./search";
import { modalOpen } from "@/lib/shortcut-guard";

/** The unopened-search index: a stable empty array, so the bar going unused never pays for
 * `buildSearchIndex`'s walk of every hunk line (and its per-line `lowerText` allocation) —
 * on the repo's `preview:huge` scenario alone that is 100k objects nobody asked for. */
const EMPTY_INDEX: readonly SearchIndexLine[] = [];

/** Find-in-diff, wired to CodeView's own scroll + selection API — the only way to
 * reach a virtualized surface, where off-screen lines are absent from the DOM and
 * the browser's native find cannot see them. The pure index/match half lives in
 * `search.ts`; this hook owns the UI state, the ⌘F/⌃F trigger, and the imperative
 * navigation: the active match line is scrolled to centre and selected, and the
 * selection *is* the highlight. A search highlight is always a collapsed single-line
 * selection, so it stays invisible to the gutter `+`, which reads only deliberate
 * multi-line ranges. */
export type DiffSearchState = {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  matchCount: number;
  /** 1-based position of the active match for display, or 0 when there are none. */
  activePosition: number;
  /** Bumped on every ⌘F so the input can re-focus and select even while open. */
  focusNonce: number;
  openSearch: () => void;
  closeSearch: () => void;
  setQuery: (query: string) => void;
  toggleCaseSensitive: () => void;
  goToNext: () => void;
  goToPrevious: () => void;
};

export function useDiffSearch(
  handleRef: RefObject<CodeViewHandle<CommentSlot> | null>,
  files: readonly PatchFile[],
  /** Files whose body is folded away. A folded file's lines are still in the parsed
   * patch — and so still findable — but they are not on the surface, so navigating to
   * one has to open it first. */
  collapsedPaths: ReadonlySet<string>,
  /** Open a folded file. Called instead of scrolling; the expansion re-runs the
   * navigation effect below, which then finds the line and lands on it. */
  onExpand: (path: string, collapsed: boolean) => void,
): DiffSearchState {
  const [open, setOpen] = useState(false);
  const [query, setQueryText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  // 0-based index into `matches`; clamped by the navigation effect when the set
  // shrinks under it (a file list rebuild), reset to 0 on every query/flag change.
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusNonce, setFocusNonce] = useState(0);

  // `files` keeps its identity across a context expansion — Pierre hydrates the affected
  // `fileDiff` in place (see `partialSignature`'s doc in `search.ts`) — so `files` alone is
  // not a sufficient memo key: an expanded file's newly-revealed lines would otherwise stay
  // permanently unfound because the index that omits them never rebuilds. Building itself
  // stays gated on `open` — the walk of every hunk line only has to run once the bar exists
  // to want it.
  const filesPartialSignature = partialSignature(files);
  // `buildSearchIndex` never reads the signature itself — it walks `files`, whose
  // *content* the signature stands in for — but it has to be a dependency so the memo
  // reacts to the in-place hydration the comment above describes.
  // oxlint-disable react-hooks/exhaustive-deps -- filesPartialSignature is a deliberate
  // rebuild trigger, not a value the callback body needs to read
  const index = useMemo(
    () => (open ? buildSearchIndex(files) : EMPTY_INDEX),
    [open, files, filesPartialSignature],
  );
  // oxlint-enable react-hooks/exhaustive-deps
  const matches = useMemo(
    () => findMatches(index, { text: query, caseSensitive }),
    [index, query, caseSensitive],
  );

  // Read the live match set from navigation callbacks without making them depend
  // on it — the callbacks stay referentially stable so the overlay never rebinds.
  const matchesRef = useRef<readonly DiffLineRef[]>(matches);
  matchesRef.current = matches;

  // The one place the highlight is painted. Runs on open, on every match-set
  // change (new query, rebuilt files), and on every active-index change (next/
  // prev). Closing — or an empty result set — clears the selection so no stray
  // line stays lit behind a closed bar. Instant scroll: navigation is a keyboard/
  // click action, and a smooth animation through a virtualized list only janks.
  useEffect(() => {
    const handle = handleRef.current;
    if (handle === null) {
      return;
    }
    if (!open || matches.length === 0) {
      handle.clearSelectedLines();
      return;
    }
    const clamped = clamp(activeIndex, 0, matches.length - 1);
    if (clamped !== activeIndex) {
      setActiveIndex(clamped);
      return; // Re-runs with the corrected index; the paint happens then.
    }
    const match = matches[clamped];
    if (match === undefined) {
      return;
    }
    // A folded file has no line to select or scroll to. Open it and stop: the fold state
    // is a dependency of this effect, so the expansion re-runs it and the *next* pass —
    // with the body on the surface — does the landing. Two declarative passes rather than
    // a scroll fired at a file that is still a bare header.
    if (collapsedPaths.has(match.fileId)) {
      onExpand(match.fileId, false);
      return;
    }
    handle.setSelectedLines({
      id: match.fileId,
      range: { start: match.lineNumber, end: match.lineNumber, side: match.side },
    });
    handle.scrollTo({
      type: "line",
      id: match.fileId,
      lineNumber: match.lineNumber,
      side: match.side,
      align: "center",
      behavior: "instant",
    });
  }, [handleRef, open, matches, activeIndex, collapsedPaths, onExpand]);

  const openSearch = useCallback(() => {
    setOpen(true);
    setFocusNonce((nonce) => nonce + 1);
  }, []);

  const closeSearch = useCallback(() => setOpen(false), []);

  // A new query (or a case-flag flip) restarts navigation from the first match, so
  // the reader lands on the top hit rather than wherever the last query left off.
  const setQuery = useCallback((next: string) => {
    setQueryText(next);
    setActiveIndex(0);
  }, []);
  const toggleCaseSensitive = useCallback(() => {
    setCaseSensitive((value) => !value);
    setActiveIndex(0);
  }, []);

  // Next/prev wrap around the ends so the last hit steps back to the first — the
  // count read-out makes the wrap legible. No-ops with an empty set.
  const goToNext = useCallback(() => {
    const count = matchesRef.current.length;
    if (count > 0) {
      setActiveIndex((current) => (current + 1) % count);
    }
  }, []);
  const goToPrevious = useCallback(() => {
    const count = matchesRef.current.length;
    if (count > 0) {
      setActiveIndex((current) => (current - 1 + count) % count);
    }
  }, []);

  // ⌘F / ⌃F opens (or re-focuses) the bar. Window-level so it fires wherever focus
  // sits in the diff pane; there is no native find to preempt (no menu binds ⌘F),
  // and preventDefault keeps the browser find-of-nothing from flashing.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "f" &&
        // Not from under a sheet: the find bar would open on a diff the reader cannot see,
        // and steal the focus the dialog is holding.
        !modalOpen()
      ) {
        event.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openSearch]);

  return {
    open,
    query,
    caseSensitive,
    matchCount: matches.length,
    activePosition: matches.length === 0 ? 0 : Math.min(activeIndex, matches.length - 1) + 1,
    focusNonce,
    openSearch,
    closeSearch,
    setQuery,
    toggleCaseSensitive,
    goToNext,
    goToPrevious,
  };
}
