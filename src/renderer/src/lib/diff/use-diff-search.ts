import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { CommentSlot } from "./comment-annotations";
import type { PatchFile } from "./patch";
import { buildSearchIndex, findMatches, type DiffLineRef } from "./search";

/** Find-in-diff, wired to CodeView's own scroll + selection API — the only way to
 * reach a virtualized surface, where off-screen lines are absent from the DOM and
 * the browser's native find cannot see them. The pure index/match half lives in
 * `search.ts`; this hook owns the UI state, the ⌘F/⌃F trigger, and the imperative
 * navigation: the active match line is scrolled to centre and selected, and the
 * selection *is* the highlight. Programmatic selection writes go through the React
 * handle, which always writes `notify: false` — so the highlight never feeds
 * DiffView's comment-add mirror, and a single-line search selection stays
 * invisible to the gutter `+` (which reads only deliberate multi-line ranges). */
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
): DiffSearchState {
  const [open, setOpen] = useState(false);
  const [query, setQueryText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  // 0-based index into `matches`; clamped by the navigation effect when the set
  // shrinks under it (a file list rebuild), reset to 0 on every query/flag change.
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusNonce, setFocusNonce] = useState(0);

  const index = useMemo(() => buildSearchIndex(files), [files]);
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
    const clamped = Math.min(Math.max(activeIndex, 0), matches.length - 1);
    if (clamped !== activeIndex) {
      setActiveIndex(clamped);
      return; // Re-runs with the corrected index; the paint happens then.
    }
    const match = matches[clamped];
    if (match === undefined) {
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
  }, [handleRef, open, matches, activeIndex]);

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
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "f") {
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
