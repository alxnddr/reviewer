import { useCallback, useMemo, useRef, type ReactElement } from "react";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import type { FileDiffContentsLoader } from "@pierre/diffs";
import type { ReviewAnchor } from "../../../shared/review";
import { CommentNavIndicator } from "@/components/CommentNavIndicator";
import { DiffSearch } from "@/components/DiffSearch";
import { useCommentSlots } from "@/components/diff/DiffCommentSlots";
import {
  renderHeaderMetadata,
  renderHeaderPrefix,
  useHeaderFilenameSuffix,
} from "@/components/diff/DiffFileHeader";
import { useGutterUtility } from "@/components/diff/DiffGutterAdd";
import { useDiffSearch } from "@/lib/diff/use-diff-search";
import { indexOfComment, navigableEntries, orderedComments } from "@/lib/diff/comment-navigation";
import { buildCommentItems, type CommentSlot } from "../../../shared/diff/comment-annotations";
import type { PatchFile } from "../../../shared/diff/patch";
import { useDiffOptions } from "@/lib/diff/use-diff-options";
import { useDiffScroll } from "@/lib/diff/use-diff-scroll";
import type { DiffStyle } from "@/stores/ui-prefs";
import type { Comment } from "../../../shared/review";

type DiffViewProps = {
  files: PatchFile[];
  /** The session's comments (imported + manual), anchored onto the diff below. */
  comments: Comment[];
  /** True when the diff is a review's frozen embedded patch: anchors place on
   * their authored lines directly, never re-resolved against a re-derived diff. */
  frozen: boolean;
  selectedFilePath: string | null;
  diffStyle: DiffStyle;
  /** The session's persisted scroll position, applied once on mount. Read
   * only at activation: this view is keyed per session, so a mount IS an
   * activation, and later updates to it are this component's own captures. */
  restoreScrollTop: number;
  /** The soloed layer, or null for the full diff. Its *change* resets the diff to the
   * top (in `useDiffScroll`); solo filtering of `files` is done upstream. */
  activeLayerId: string | null;
  /** The comment the reader is focused on (via `n`/`p` or the sidebar list), or
   * null. Rings its card and positions the floating counter; the ring itself is driven
   * through `buildCommentItems`. */
  activeCommentId: string | null;
  /** The focused comment this surface still owes a scroll to, or null. Separate from
   * `activeCommentId` because it survives the surface being unmounted — which is how
   * opening a finding from the tour doc, the commit that mounts this view, scrolls at
   * all. `useDiffScroll` consumes it through `onCommentScrolled`. */
  pendingCommentScroll: string | null;
  /** Files rendered as a header band with the body folded away — the reader's own
   * disclosures, plus the fold that rides on marking a file read. */
  collapsedPaths: ReadonlySet<string>;
  /** Fold a file away or open it back up: the header's disclosure, and what the surface
   * calls before jumping to something inside a folded file. */
  onSetFileCollapsed: (path: string, collapsed: boolean) => void;
  /** Loads full file text so Pierre can expand unchanged context around a hunk;
   * null when no live repo backs the diff (a frozen artifact) or the selection
   * has no two readable refs — the expander is then off and no git read fires. */
  loadDiffFiles: FileDiffContentsLoader | null;
  /** Reports a debounced scroll position back to the owning session's slice. */
  onScrollTop: (scrollTop: number) => void;
  /** Curation, routed to the owning session's slice. */
  onAddComment: (anchor: ReviewAnchor, body: string) => void;
  onEditComment: (commentId: string, body: string) => void;
  onDiscardComment: (commentId: string) => void;
  /** Comment step-through, routed to the owning session's slice — drives the
   * floating navigator's prev/next and close. */
  onStepComment: (direction: 1 | -1) => void;
  onClearActiveComment: () => void;
  /** Clears the pending scroll once this surface has served it. */
  onCommentScrolled: (commentId: string) => void;
};

/** The Pierre diff surface, untouched: themes, gutters, and bands come from
 * pierre-light/pierre-dark inside the component's shadow root; shell tokens stop here.
 * Comments ride Pierre's own annotation API (a React subtree in an annotation slot,
 * never a shadow-DOM restyle): each comment renders on its anchored line, an
 * outdated one at the file header, and the gutter `+` / a line selection open the
 * editor.
 *
 * What is left here is the wiring: the items the surface draws, and the five slot
 * renderers it draws them through. Every one of those is passed by name — Pierre
 * memoizes its portal host (`SlotPortals`, CodeView.js) on a shallow compare of the
 * render props, and a single inline arrow fails that compare on every render of this
 * component, re-rendering every visible file's header buttons, gutter `+` and comment
 * cards. The slots themselves live in `components/diff/`, the surface's options and its
 * scrolling in `lib/diff/`. */
export function DiffView({
  files,
  comments,
  frozen,
  selectedFilePath,
  diffStyle,
  restoreScrollTop,
  activeLayerId,
  activeCommentId,
  pendingCommentScroll,
  collapsedPaths,
  onSetFileCollapsed,
  loadDiffFiles,
  onScrollTop,
  onAddComment,
  onEditComment,
  onDiscardComment,
  onStepComment,
  onClearActiveComment,
  onCommentScrolled,
}: DiffViewProps): ReactElement {
  const handleRef = useRef<CodeViewHandle<CommentSlot>>(null);
  const { editingId, draft, openDraft, renderAnnotation } = useCommentSlots({
    onAddComment,
    onEditComment,
    onDiscardComment,
  });

  // Find-in-diff. The surface is virtualized, so off-screen lines never enter the
  // DOM and the browser's native find is blind to them; this searches the parsed
  // patch and navigates by driving the same handle used for file jumps. It
  // highlights the active match through Pierre's line selection — a collapsed
  // single-line one, which the comment `+` reads as no range at all.
  // Folded files stay searchable — the match is in the diff whether or not its body
  // is on screen — so the hook is handed the fold state and the way to undo it.
  const search = useDiffSearch(handleRef, files, collapsedPaths, onSetFileCollapsed);

  const items = useMemo(
    () =>
      buildCommentItems(
        files,
        comments,
        { editingId, draft },
        frozen,
        activeCommentId,
        diffStyle,
        collapsedPaths,
      ),
    [files, comments, editingId, draft, frozen, activeCommentId, diffStyle, collapsedPaths],
  );

  // Every comment resolved against the loaded diff, in reading order — one sort, read
  // by both the floating counter below and the focus scroll in `useDiffScroll`.
  const entries = useMemo(
    () => orderedComments(files, comments, frozen),
    [files, comments, frozen],
  );

  // The floating counter's position, derived defensively: the same navigable order
  // `stepComment` walks, and the active comment's 1-based place in it. A focused id
  // that isn't in the list (soloed out, unplaceable, or just discarded) resolves to
  // −1, which hides the counter rather than showing a phantom position.
  const navEntries = useMemo(() => navigableEntries(entries), [entries]);
  const navIndex = activeCommentId === null ? -1 : indexOfComment(navEntries, activeCommentId);
  const navActive = navIndex >= 0 ? (navEntries[navIndex] ?? null) : null;

  // A binary change is otherwise indistinguishable from a pure rename (both render
  // header-only, zero hunks) — the header says which one the reader is looking at.
  const binaryPaths = useMemo(
    () => new Set(files.filter((file) => file.isBinary).map((file) => file.path)),
    [files],
  );

  const options = useDiffOptions(diffStyle, loadDiffFiles);
  const renderHeaderFilenameSuffix = useHeaderFilenameSuffix(binaryPaths);
  const renderGutterUtility = useGutterUtility(handleRef, openDraft);

  const { scrollToComment, onScroll } = useDiffScroll(handleRef, {
    restoreScrollTop,
    selectedFilePath,
    pendingCommentScroll,
    activeLayerId,
    entries,
    onScrollTop,
    onCommentScrolled,
  });

  // The diff is the largest thing on screen and, until this, the only region of the app a
  // keyboard could not reach: Pierre owns the scroll container and renders it with no
  // tabindex, and a scroll box that is not focusable gets no PgDn, no space bar, no arrows —
  // a reader without a pointer simply could not move down a file. Everything else it needs
  // is already there (the browser scrolls a focused overflow container for free), so all
  // that is set here is the focus stop and the label that says what the region is. Done
  // through `containerRef` rather than a wrapper, because the wrapper would not be the
  // scroll box and focusing it would scroll nothing.
  const surfaceRef = useCallback((node: HTMLDivElement | null): void => {
    if (node === null) {
      return;
    }
    node.tabIndex = 0;
    node.setAttribute("role", "region");
    node.setAttribute("aria-label", "Diff");
  }, []);

  // The CodeView container is the scroll context; without overflow-y the document
  // itself grows by the diff's full height and the shell chrome scrolls away. The
  // relative wrapper hosts the floating find bar above that scroll context so the
  // bar stays put while the diff scrolls beneath it.
  return (
    <div className="relative h-full">
      {navActive !== null && (
        <CommentNavIndicator
          position={navIndex + 1}
          count={navEntries.length}
          onPrevious={() => onStepComment(-1)}
          onNext={() => onStepComment(1)}
          onRecenter={() => scrollToComment(navActive)}
          onClose={onClearActiveComment}
        />
      )}
      {search.open && (
        <DiffSearch
          query={search.query}
          caseSensitive={search.caseSensitive}
          matchCount={search.matchCount}
          activePosition={search.activePosition}
          focusNonce={search.focusNonce}
          onQueryChange={search.setQuery}
          onToggleCase={search.toggleCaseSensitive}
          onNext={search.goToNext}
          onPrevious={search.goToPrevious}
          onClose={search.closeSearch}
        />
      )}
      <CodeView
        ref={handleRef}
        containerRef={surfaceRef}
        items={items}
        options={options}
        onScroll={onScroll}
        // The focus ring is inset: the surface is flush against the pane's edges, so an
        // outset ring would be clipped on three sides and read as a stray line on the fourth.
        className="h-full overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        renderHeaderPrefix={renderHeaderPrefix}
        renderHeaderFilenameSuffix={renderHeaderFilenameSuffix}
        renderHeaderMetadata={renderHeaderMetadata}
        renderAnnotation={renderAnnotation}
        renderGutterUtility={renderGutterUtility}
      />
    </div>
  );
}
