import { createDebouncer } from "../../../shared/debounce";
import type { ReviewSide } from "../../../shared/review";

/** A scroll the reader asked for that the diff surface has not performed yet — the one
 * kind that survives the surface not being mounted, because the click that asks for it is
 * routinely the click that mounts it (all three of these are reachable from the tour doc,
 * which replaces the diff pane). The store holds one at a time and the hook consumes it;
 * `slice.ts`'s `pendingScroll` is where the rest of that reasoning lives.
 *
 * One union rather than a field per kind: at most one of these can be outstanding, and two
 * nullable fields would let a served comment jump leave a line jump standing to fire at
 * whatever mounts next — the exact failure the request-not-a-flag design exists to prevent.
 *
 * `comment` names a finding and lets the hook resolve where it hosts (a placed one centres
 * on its line, a stranded one lands on its file header). `line` names the place directly,
 * already placed against the loaded diff by the action that asked — a prose reference has
 * no annotation to look up, so the store resolves it and asks for nothing when it drifted.
 * `file` is the coarsest and the one with the most call sites: every gesture that picks a
 * whole file — a rail row, a chapter's file row, a bare-path reference, j/k, ⇧R — lands the
 * file's header at the top, which is what picking a file has always meant here.
 *
 * `file` being in this union at all is the fix for a bug worth naming, because the shape
 * that had it looks reasonable: a file jump used to be *only* something the surface watched
 * for (`use-diff-scroll`'s `lastJumpedPath` compare), which cannot see the jump that mounts
 * the surface — so from the tour doc the rail moved onto the file and the diff pane stayed
 * exactly where the session's recorded scroll had left it. The reader was told they had
 * arrived and they had not. */
export type PendingScroll =
  | { kind: "comment"; commentId: string }
  | { kind: "file"; path: string }
  | ({ kind: "line" } & LineTarget);

/** One line of one file, on one side: where a reference's chip lands. The line is the
 * *placed* one, not the authored `startLine` — the action that builds this resolves the
 * reference against the loaded diff first, so a target that exists is the only kind that
 * ever reaches the surface. */
export type LineTarget = { path: string; line: number; side: ReviewSide };

/** Whether two requests are the same one. The hook reports back what it served and the
 * store clears only that, so a jump the reader made in between is never dropped on the
 * floor; a value compare rather than identity, because the request travels store → props →
 * effect and nothing on that path promises to hand back the same object. */
export function samePendingScroll(a: PendingScroll, b: PendingScroll): boolean {
  switch (a.kind) {
    case "comment":
      return b.kind === "comment" && a.commentId === b.commentId;
    case "file":
      return b.kind === "file" && a.path === b.path;
    case "line":
      return b.kind === "line" && a.path === b.path && a.line === b.line && a.side === b.side;
  }
}

/** What a session activation asks of the diff surface. The single scroll owner:
 * exactly one of these drives the one `scrollTo` per mount, so a pending jump, a
 * persisted scroll position and a file-jump can never two-of-them fire. Absence is a
 * distinct arm — never `0`-as-maybe. */
export type ScrollRestore =
  | PendingScroll
  | { kind: "position"; position: number }
  | { kind: "item"; filePath: string }
  | { kind: "none" };

/** The mount half of `use-diff-scroll`'s ranking — focus beats file-jump beats the
 * activation restore — as a value, since a mount is where all three can be true at once.
 *
 * An outstanding request wins outright: that mount *is* the click (the tour doc unmounts
 * the diff pane, so opening a finding or a reference from it mounts the surface), and it is
 * what the reader asked for one frame ago. Then position: a recorded scroll is the exact
 * spot the reader left, so it outranks the `item` arm below — which is the file focus the
 * *session* carried in, a restored preference rather than a request.
 *
 * That last distinction is the whole reason a `file` request exists beside the `item` arm:
 * the two name the same scroll and rank on opposite sides of position, and reading them as
 * one is the bug where a chapter's file row moved the rail and left the diff where it was.
 * With no scroll but a focused file, jump to it; with neither, the view starts at the top.
 * A `scrollTop` of `0` is "top", which needs no position restore, so it falls through to
 * the file-jump / top arms — both indistinguishable from a pixel-`0` scroll, so nothing is
 * lost. */
export function planScrollRestore(
  scrollTop: number,
  selectedFilePath: string | null,
  pending: PendingScroll | null,
): ScrollRestore {
  if (pending !== null) {
    return pending;
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
