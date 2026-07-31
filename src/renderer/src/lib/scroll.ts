import { createDebouncer } from "../../../shared/debounce";

/** What a session activation asks of the diff surface. The single scroll owner:
 * exactly one of these drives the one `scrollTo` per mount, so a pending comment, a
 * persisted scroll position and a file-jump can never two-of-them fire. Absence is a
 * distinct arm — never `0`-as-maybe. */
export type ScrollRestore =
  | { kind: "comment"; commentId: string }
  | { kind: "position"; position: number }
  | { kind: "item"; filePath: string }
  | { kind: "none" };

/** The mount half of `use-diff-scroll`'s ranking — focus beats file-jump beats the
 * activation restore — as a value, since a mount is where all three can be true at once.
 *
 * A comment the reader focused whose scroll has not been performed yet wins outright:
 * that mount *is* the click (the tour doc unmounts the diff pane, so opening a finding
 * from it mounts the surface), and it names a line, which every arm below is a coarser
 * approximation of. Then position: a recorded scroll is the exact spot the reader left,
 * so it outranks the coarser file-jump. With no scroll but a focused file, jump to it;
 * with neither, the view starts at the top. A `scrollTop` of `0` is "top", which needs no
 * position restore, so it falls through to the file-jump / top arms — both
 * indistinguishable from a pixel-`0` scroll, so nothing is lost. */
export function planScrollRestore(
  scrollTop: number,
  selectedFilePath: string | null,
  pendingCommentScroll: string | null,
): ScrollRestore {
  if (pendingCommentScroll !== null) {
    return { kind: "comment", commentId: pendingCommentScroll };
  }
  if (scrollTop > 0) {
    return { kind: "position", position: scrollTop };
  }
  if (selectedFilePath !== null) {
    return { kind: "item", filePath: selectedFilePath };
  }
  return { kind: "none" };
}

/** Coalesces a burst of scroll events into one slice write. Short so a switch
 * captures a near-current position, but non-zero so a fast scroll is not a write
 * per frame; the disk write-back is debounced separately. */
export const SCROLL_CAPTURE_DEBOUNCE_MS = 150;

export type ScrollCapture = {
  /** Record the latest scroll position; commits after the debounce window. */
  notify: (scrollTop: number) => void;
  /** Commit any pending position now — the unmount/tab-switch path, so the last
   * scroll before a switch is never dropped by an unfired debounce timer. */
  flush: () => void;
};

/** Leading-schedule, trailing-commit debounce, on the shared primitive (`shared/debounce.ts`)
 * that also backs the store's write-backs and main's session persist: the first `notify`
 * schedules, later ones only replace the pending value, and the timer fires once with the
 * latest. */
export function createScrollCapture(
  commit: (scrollTop: number) => void,
  delayMs: number = SCROLL_CAPTURE_DEBOUNCE_MS,
): ScrollCapture {
  const debouncer = createDebouncer<number>({ delayMs, onFire: commit });
  return {
    notify: (scrollTop) => debouncer.notify(scrollTop),
    flush: () => debouncer.flush(),
  };
}
