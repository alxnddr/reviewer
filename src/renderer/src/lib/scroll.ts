/** What a session activation asks of the diff surface. The single scroll owner:
 * exactly one of these drives the one `scrollTo` per mount, so a persisted scroll
 * position and a file-jump can never both fire. Absence is a distinct arm — never
 * `0`-as-maybe. */
export type ScrollRestore =
  | { kind: "position"; position: number }
  | { kind: "item"; filePath: string }
  | { kind: "none" };

/** Position wins: a recorded scroll is the exact spot the reader left, so it
 * outranks the coarser file-jump. With no scroll but a focused file, jump to it;
 * with neither, the view starts at the top. A `scrollTop` of `0` is "top", which
 * needs no position restore, so it falls through to the file-jump / top arms —
 * both indistinguishable from a pixel-`0` scroll, so nothing is lost. */
export function planScrollRestore(
  scrollTop: number,
  selectedFilePath: string | null,
): ScrollRestore {
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

/** Leading-schedule, trailing-commit debounce (matching the store's write-back
 * shape): the first `notify` schedules, later ones only replace the pending
 * value, and the timer fires once with the latest. */
export function createScrollCapture(
  commit: (scrollTop: number) => void,
  delayMs: number = SCROLL_CAPTURE_DEBOUNCE_MS,
): ScrollCapture {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: number | null = null;

  function fire(): void {
    timer = null;
    if (pending !== null) {
      const value = pending;
      pending = null;
      commit(value);
    }
  }

  return {
    notify(scrollTop) {
      pending = scrollTop;
      if (timer === null) {
        timer = setTimeout(fire, delayMs);
      }
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        fire();
      }
    },
  };
}
