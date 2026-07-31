import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { CommentSlot } from "../../../../shared/diff/comment-annotations";
import type { CommentNavEntry } from "./comment-navigation";
import { capturesScroll } from "../../../../shared/layers";
import { createScrollCapture, planScrollRestore } from "@/lib/scroll";

// Everything that moves the diff surface, in one place, because the only thing that
// matters about these five effects is how they *rank* against each other. They can all
// want the viewport in the same commit — a focused comment also selects its file; an
// activation carries both a persisted position and a focused file — and each scroll the
// reader did not ask for is a lost place in a long diff. So exactly one wins, and the
// ranking is: focus beats file-jump beats the activation restore.
//
// Two mechanisms enforce it, and both are deliberate. Declaration order settles which
// effect claims a commit first (React runs them in the order they are written). And every
// guard is a value-compare against a mount-seeded ref rather than a fire-once flag: the
// mount is then inert everywhere except the restore, and a StrictMode remount — which
// replays with the same values — stays inert too, where a boolean would flip and scroll.

export type DiffScrollOptions = {
  /** The session's persisted scroll position, applied once on mount. Read
   * only at activation: the view is keyed per session, so a mount IS an
   * activation, and later updates to it are this hook's own captures. */
  restoreScrollTop: number;
  selectedFilePath: string | null;
  /** The comment the reader is focused on (via `n`/`p` or the sidebar list), or null. */
  activeCommentId: string | null;
  /** The soloed layer, or null for the full diff. Its *change* resets the diff to the top. */
  activeLayerId: string | null;
  /** Every comment resolved against the loaded diff, in reading order. Passed in rather
   * than derived here: the floating counter already memoizes exactly this list and the
   * focus lookup below is only a `find` over it, so deriving it again would buy nothing
   * but the same sort run twice a render. */
  entries: readonly CommentNavEntry[];
  /** Reports a debounced scroll position back to the owning session's slice. */
  onScrollTop: (scrollTop: number) => void;
};

export type DiffScroll = {
  /** Put a comment's host row under the reader's eye — also the floating counter's
   * re-centre, which is why it is handed back rather than kept private. */
  scrollToComment: (entry: CommentNavEntry) => void;
  /** For the surface's `onScroll`: records the reader's place, debounced. */
  onScroll: (scrollTop: number) => void;
};

export function useDiffScroll(
  handleRef: RefObject<CodeViewHandle<CommentSlot> | null>,
  {
    restoreScrollTop,
    selectedFilePath,
    activeCommentId,
    activeLayerId,
    entries,
    onScrollTop,
  }: DiffScrollOptions,
): DiffScroll {
  // The one scroll owner on activation. The empty deps make this a mount-once
  // snapshot of the persisted position — a mount IS an activation (the view is
  // keyed per session), and later changes to those props are this view's own
  // captures, not new activations. A recorded position wins over the file-jump, so
  // only one scrollTo ever fires. Instant — a tab switch is a keyboard/click
  // action, never animated. Position restore stays correct through virtualized
  // measurement: CodeView re-anchors the settled scroll as item heights resolve,
  // so no second call is needed.
  // oxlint-disable react-hooks/exhaustive-deps -- the empty deps are the design stated above: a mount-once activation snapshot, not a subscription to the props it reads
  useLayoutEffect(() => {
    const handle = handleRef.current;
    if (handle === null) {
      return;
    }
    const restore = planScrollRestore(restoreScrollTop, selectedFilePath);
    if (restore.kind === "position") {
      handle.scrollTo({ type: "position", position: restore.position, behavior: "instant" });
    } else if (restore.kind === "item") {
      handle.scrollTo({ type: "item", id: restore.filePath, align: "start", behavior: "instant" });
    }
  }, []);
  // oxlint-enable react-hooks/exhaustive-deps

  // Post-activation file jumps (tree click, j/k). Gated on an actual change of the
  // focused file from the last one jumped to — seeded with the activation snapshot,
  // so the mount (owned by the restore above) is a no-op and the two never both
  // fire. A value-compare, not a fire-once flag: a StrictMode remount replays with
  // the same value and stays inert, where a boolean guard would flip and jump.
  const lastJumpedPath = useRef(selectedFilePath);

  // Put a comment's host row under the reader's eye. A placed comment centres on its
  // own line; an outdated one has no line on this diff — it renders at the file
  // header — so its file is brought to the top instead. Pure viewport: it touches no
  // store state, which is what lets the stepper's counter re-run it as a re-centre
  // after the reader has scrolled off, without re-triggering the focus effect below.
  // The scroll target is the entry's host `path`, never `comment.file`: an anchor
  // authored before a rename names a path no item carries, and the item is keyed by the
  // file's current one — the same resolution that placed the annotation.
  const scrollToComment = useCallback(
    (entry: CommentNavEntry): void => {
      const handle = handleRef.current;
      if (handle === null) {
        return;
      }
      if (entry.status === "placed" && entry.line !== null) {
        handle.scrollTo({
          type: "line",
          id: entry.path,
          lineNumber: entry.line,
          side: entry.comment.side,
          align: "center",
          behavior: "instant",
        });
      } else {
        handle.scrollTo({
          type: "item",
          id: entry.path,
          align: "start",
          behavior: "instant",
        });
      }
    },
    [handleRef],
  );

  // Scroll to the focused comment (a sidebar click or an `n`/`p` step). Declared
  // BEFORE the file-jump effect below and seeding `lastJumpedPath`: `focusComment`
  // sets `activeCommentId` and `selectedFilePath` in one store write, so both change
  // in the same commit — running first and claiming the jump makes the file-jump
  // effect a no-op, so exactly one precise scroll fires (line/centre, not
  // file/start). Value-compare-seeded like the jumps, so a mount / StrictMode replay
  // is inert (the persisted-scroll restore owns the mount; the ring still paints from
  // `items`, so a tab bounce keeps the highlight without a competing scroll). An id
  // with no host item here (soloed out, unplaceable, or discarded) is a no-op.
  const lastFocusedCommentId = useRef(activeCommentId);
  useEffect(() => {
    if (activeCommentId === lastFocusedCommentId.current) {
      return;
    }
    lastFocusedCommentId.current = activeCommentId;
    if (activeCommentId === null) {
      return;
    }
    const entry = entries.find((candidate) => candidate.comment.id === activeCommentId);
    if (entry === undefined) {
      return;
    }
    // Claim the jump so the file-jump effect (next) doesn't also scroll to the file.
    // The host path, matching what `focusComment` put in `selectedFilePath`.
    lastJumpedPath.current = entry.path;
    scrollToComment(entry);
  }, [activeCommentId, entries, scrollToComment]);

  useEffect(() => {
    if (selectedFilePath === lastJumpedPath.current) {
      return;
    }
    lastJumpedPath.current = selectedFilePath;
    if (selectedFilePath !== null) {
      // Instant: file jumps come from clicks and keyboard, never animated.
      handleRef.current?.scrollTo({
        type: "item",
        id: selectedFilePath,
        align: "start",
        behavior: "instant",
      });
    }
  }, [handleRef, selectedFilePath]);

  // Read at scroll time so a solo whose scroll fires inside the capture debounce
  // is gated by the state at the moment it scrolled, not at commit.
  const activeLayerIdRef = useRef(activeLayerId);
  activeLayerIdRef.current = activeLayerId;
  // Changing the active layer — soloing one, stepping to the next, or clearing back
  // to the full diff — resets the view to the top, so each layer (and the full diff
  // on deactivation) starts at its chapter-intro band instead of inheriting where
  // the last view was left. Seeded with the mount value and value-compared, so the
  // mount stays a no-op — that is the persisted-position restore's job,
  // and a StrictMode replay with the same value stays inert where a fire-once flag
  // would clobber a real position. Instant — layer changes are keyboard/click, never
  // animated. While a layer is active this reset is not captured (capturesScroll is
  // false), so it never rewrites the full diff's persisted scroll; the deactivation
  // reset lands on the full diff and is the session's own to persist.
  const lastLayerId = useRef(activeLayerId);
  useLayoutEffect(() => {
    if (activeLayerId === lastLayerId.current) {
      return;
    }
    lastLayerId.current = activeLayerId;
    handleRef.current?.scrollTo({ type: "position", position: 0, behavior: "instant" });
  }, [handleRef, activeLayerId]);

  // Capture rides CodeView's public onScroll (internally subscribeToScroll) — no
  // DOM polling. Debounced so a fast scroll is not a write per frame, and flushed
  // on unmount so the last position before a tab switch survives.
  const capture = useMemo(() => createScrollCapture(onScrollTop), [onScrollTop]);
  useEffect(() => () => capture.flush(), [capture]);

  const onScroll = useCallback(
    (scrollTop: number): void => {
      // A soloed layer's scroll is derived view state — never the reader's place
      // in the full diff, so it must not be captured or persisted.
      if (capturesScroll(activeLayerIdRef.current)) {
        capture.notify(scrollTop);
      }
    },
    [capture],
  );

  return { scrollToComment, onScroll };
}
