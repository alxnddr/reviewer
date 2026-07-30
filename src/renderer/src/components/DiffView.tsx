import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { CodeView, type CodeViewHandle, type CodeViewProps } from "@pierre/diffs/react";
import type {
  CodeViewItem,
  CodeViewLayout,
  CodeViewOptions,
  DiffLineAnnotation,
  FileDiffContentsLoader,
  LineAnnotation,
} from "@pierre/diffs";
import { Check, ChevronDown, ChevronRight, Copy, Plus } from "lucide-react";
import type { ReviewAnchor } from "../../../shared/review";
import { Button } from "@/components/ui/button";
import { CommentEditor } from "@/components/CommentEditor";
import { CommentThread } from "@/components/CommentThread";
import { CommentNavIndicator } from "@/components/CommentNavIndicator";
import { DiffSearch } from "@/components/DiffSearch";
import { FileReadToggle } from "@/components/FileReadToggle";
import { TooltipHint } from "@/components/ui/tooltip";
import { useCopyFeedback } from "@/lib/copy-feedback";
import { useDiffSearch } from "@/lib/diff/use-diff-search";
import {
  indexOfComment,
  navigableEntries,
  orderedComments,
  type CommentNavEntry,
} from "@/lib/diff/comment-navigation";
import {
  buildCommentItems,
  pickAddAnchor,
  selectionRange,
  type CommentDraft,
  type CommentSlot,
  type HoveredLine,
} from "@/lib/diff/comment-annotations";
import type { PatchFile } from "@/lib/diff/patch";
import { expansionOptions } from "@/lib/diff/expand-context";
import { activeDiffThemePair } from "@/lib/diff/highlight-warmup";
import { capturesScroll } from "@/lib/layers";
import { createScrollCapture, planScrollRestore } from "@/lib/scroll";
import { selectActiveSlice, useReviewStore, type DiffStyle } from "@/stores/review";
import type { Comment } from "../../../shared/review";
import { useEffectiveDark, useThemeStore } from "@/stores/theme";

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
   * top (below); solo filtering of `files` is done upstream. */
  activeLayerId: string | null;
  /** The comment the reader is focused on (via `n`/`p` or the sidebar list), or
   * null. Its change scrolls the diff to that comment's line and rings its card;
   * the ring itself is driven through `buildCommentItems`. */
  activeCommentId: string | null;
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
};

// Two overrides injected through Pierre's `unsafeCSS` hatch — its own `@layer unsafe`, which outranks
// the theme's `@layer rendered`, so both win inside the shadow root without touching Pierre's themes:
//   1. The header stat counts (+n/−n) are hard-wired to the CODE font in the package stylesheet; they
//      are header chrome and must follow the header sans. No public var covers them.
//   2. The diff surface background is bridged to our `--diff-surface` token (it inherits through the
//      shadow boundary). Pierre derives `--diffs-bg` — and with it the code, header, separator, and
//      gutter backgrounds — from these `--diffs-*-bg` source vars, so the whole surface follows the
//      token while the per-span `--diffs-token-*` syntax colours stay Pierre's. Each theme's
//      `--diff-surface` already equals its Pierre editor bg, so this only moves pierre-dark, whose
//      surface is deliberately the neutral shell colour rather than Pierre's near-black — the diff
//      pane then matches the layer band and the shell instead of reading blacker than them.
const DIFF_UNSAFE_CSS = `
  [data-diffs-header="default"] [data-additions-count],
  [data-diffs-header="default"] [data-deletions-count] {
    font-family: var(--diffs-header-font-family, var(--diffs-header-font-fallback));
  }
  :host {
    --diffs-light-bg: var(--diff-surface);
    --diffs-dark-bg: var(--diff-surface);
    /* Content, not chrome: the diff code and its inline comment threads read back as
     * selectable text (the shell's body sets user-select:none, which otherwise
     * inherits through the shadow boundary and freezes the whole surface). */
    user-select: text;
    -webkit-user-select: text;
  }
`;

// Pierre lays its top padding out as a margin above the virtualized container, so
// the first file's sticky header carries an 8px gap that only shows when scrolled
// fully to the top — once the header sticks to top:0 it hides the margin, which
// reads as the topmost band having a taller top than its stuck twin. Zero the top
// so the first band's height is honest at rest; the inter-file gap and tail
// padding stay at Pierre's default 8px.
const DIFF_LAYOUT: CodeViewLayout = { paddingTop: 0, paddingBottom: 8, gap: 8 };

// Pierre memoizes its portal host (`SlotPortals`, CodeView.js) on a shallow compare of the
// render props, and one failed compare re-renders EVERY visible file's slots — both header
// buttons, the gutter `+`, and every comment card, tooltip trees included. An inline arrow
// fails that compare on every DiffView render, so none of them is written inline: the two
// that close over nothing are module constants, the two that need this view's data are
// `useCallback`s keyed on that data alone, and every slot's contents are a `memo` leaf, so a
// portal re-render that does happen repaints only the file whose slot actually changed.
type DiffCodeViewProps = CodeViewProps<CommentSlot>;
type HeaderSlotRenderer = NonNullable<DiffCodeViewProps["renderHeaderPrefix"]>;
type GutterUtilityRenderer = NonNullable<DiffCodeViewProps["renderGutterUtility"]>;

// The file's own disclosure, at the head of its header band: a folded file is
// still a file in the diff, and the twisty is what says so. It leads the name
// for the same reason a tree's does — the thing that opens a row goes before
// the row's name, not after everything else on it.
const renderHeaderPrefix: HeaderSlotRenderer = (item) => <FileFoldToggle path={item.id} />;

// The read control alone at the outer edge — the band's most-reached-for
// corner, and where every reviewer's hand already goes for it.
const renderHeaderMetadata: HeaderSlotRenderer = (item) => <FileReadToggle path={item.id} />;

/** The Pierre diff surface, untouched: themes, gutters, and bands come from
 * pierre-light/pierre-dark inside the component's shadow root; shell tokens stop here.
 * Comments ride Pierre's own annotation API (a React subtree in an annotation slot,
 * never a shadow-DOM restyle): each comment renders on its anchored line, an
 * outdated one at the file header, and the gutter `+` / a line selection open the
 * editor. */
export function DiffView({
  files,
  comments,
  frozen,
  selectedFilePath,
  diffStyle,
  restoreScrollTop,
  activeLayerId,
  activeCommentId,
  collapsedPaths,
  onSetFileCollapsed,
  loadDiffFiles,
  onScrollTop,
  onAddComment,
  onEditComment,
  onDiscardComment,
  onStepComment,
  onClearActiveComment,
}: DiffViewProps): ReactElement {
  const dark = useEffectiveDark();
  const themeSelection = useThemeStore((state) => state.selection);
  const handleRef = useRef<CodeViewHandle<CommentSlot>>(null);
  // Curation UI state (which comment is open for editing, an in-flight new
  // comment) lives here and is folded into the items' annotations so a version
  // bump follows every visible change — CodeView reuses an item record and only
  // re-renders its slots when the version changes.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CommentDraft | null>(null);

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

  // The floating counter's position, derived defensively: the same navigable order
  // `stepComment` walks, and the active comment's 1-based place in it. A focused id
  // that isn't in the list (soloed out, unplaceable, or just discarded) resolves to
  // −1, which hides the counter rather than showing a phantom position.
  const navEntries = useMemo(
    () => navigableEntries(orderedComments(files, comments, frozen)),
    [files, comments, frozen],
  );
  const navIndex = activeCommentId === null ? -1 : indexOfComment(navEntries, activeCommentId);
  const navActive = navIndex >= 0 ? (navEntries[navIndex] ?? null) : null;

  // A binary change is otherwise indistinguishable from a pure rename (both render
  // header-only, zero hunks) — the header says which one the reader is looking at.
  const binaryPaths = useMemo(
    () => new Set(files.filter((file) => file.isBinary).map((file) => file.path)),
    [files],
  );

  // One editor is on-screen at a time: opening a draft closes any open edit, and
  // opening an edit closes any in-flight draft — the two-editor state is never
  // reachable from either direction.
  const openDraft = useCallback((fileId: string, anchor: ReviewAnchor) => {
    setEditingId(null);
    setDraft({ fileId, anchor });
  }, []);
  const openEdit = useCallback((commentId: string) => {
    setDraft(null);
    setEditingId(commentId);
  }, []);

  // enableGutterUtility surfaces the add affordance on line hover; its click is
  // wired through renderGutterUtility below (Pierre rejects pairing that render
  // hook with onGutterUtilityClick — only one gutter API at a time).
  // enableLineSelection lets a gutter drag pick a multi-line range; the `+` reads
  // that selection at click time to add on a range. onLineSelected is left unwired
  // on purpose — it fires on a plain click, so wiring it to open the editor would
  // hijack every stray click; the `+` stays the one deliberate commit gesture.
  const options = useMemo(
    (): CodeViewOptions<CommentSlot> => ({
      // themeType picks which side of the pool's light/dark pair this view paints, so it follows the
      // shell's appearance. `theme` mirrors the pool's active pair, but NOT to tokenize (a per-view
      // theme is disregarded once a worker pool is in use — the pool owns tokenizing, DiffThemeSync):
      // it is the render trigger for a same-appearance switch. Pierre's onThemeChange only invalidates
      // the element pool and never renders, so pushing a new pool theme alone leaves a mounted view
      // untouched when themeType doesn't change (dark→dark). Carrying the pair here makes CodeView's
      // options unequal across that switch, so it re-renders and re-highlights off the pool's new theme.
      themeType: dark ? "dark" : "light",
      theme: activeDiffThemePair(themeSelection),
      diffStyle,
      stickyHeaders: true,
      layout: DIFF_LAYOUT,
      hunkSeparators: "line-info",
      unsafeCSS: DIFF_UNSAFE_CSS,
      enableGutterUtility: true,
      enableLineSelection: true,
      // Context expansion: the loader is null unless a live repo backs the diff,
      // so a frozen artifact gets no expander and never fires a git read.
      ...expansionOptions(loadDiffFiles),
    }),
    [dark, themeSelection, diffStyle, loadDiffFiles],
  );

  const renderAnnotation = useCallback(
    (annotation: LineAnnotation<CommentSlot> | DiffLineAnnotation<CommentSlot>): ReactNode => {
      const slot = annotation.metadata;
      if (slot.kind === "draft") {
        return (
          <CommentAnnotationFrame twoColumn={slot.twoColumn}>
            <CommentEditor
              initialBody=""
              saveLabel="Comment"
              onSave={(body) => {
                onAddComment(slot.anchor, body);
                setDraft(null);
              }}
              onCancel={() => setDraft(null)}
            />
          </CommentAnnotationFrame>
        );
      }
      if (slot.editing) {
        return (
          <CommentAnnotationFrame twoColumn={slot.twoColumn}>
            <CommentEditor
              initialBody={slot.comment.body}
              saveLabel="Save"
              onSave={(body) => {
                onEditComment(slot.comment.id, body);
                setEditingId(null);
              }}
              onCancel={() => setEditingId(null)}
            />
          </CommentAnnotationFrame>
        );
      }
      return (
        <CommentAnnotationFrame twoColumn={slot.twoColumn}>
          <CommentThread
            comment={slot.comment}
            outdated={slot.outdated}
            active={slot.active}
            onEdit={() => openEdit(slot.comment.id)}
            onDiscard={() => onDiscardComment(slot.comment.id)}
          />
        </CommentAnnotationFrame>
      );
    },
    [openEdit, onAddComment, onEditComment, onDiscardComment],
  );

  // Copying the path belongs to the name, not to the band's trailing controls: it acts on
  // the text it sits beside, so it follows the name directly rather than travelling to the
  // far corner where the read control lives. Keyed on `binaryPaths` alone — which is
  // memoized on `files`, so this identity survives every other state change this view
  // holds, and the one thing that does move it (a new file list) rebuilds the items and
  // re-renders the portals regardless.
  const renderHeaderFilenameSuffix = useCallback<HeaderSlotRenderer>(
    (item) => <FileNameSuffix path={item.id} binary={binaryPaths.has(item.id)} />,
    [binaryPaths],
  );

  // The gutter add affordance. Nothing about the live line selection is threaded through
  // here: the button reads it from the handle when it needs it, so a drag's per-line
  // deltas never reach React at all.
  const renderGutterUtility = useCallback<GutterUtilityRenderer>(
    (getHoveredLine, item) => (
      <GutterAddButton
        getHoveredLine={getHoveredLine}
        item={item}
        handleRef={handleRef}
        onOpenDraft={openDraft}
      />
    ),
    [openDraft],
  );

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
  const scrollToComment = useCallback((entry: CommentNavEntry): void => {
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
  }, []);

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
    const entry = orderedComments(files, comments, frozen).find(
      (candidate) => candidate.comment.id === activeCommentId,
    );
    if (entry === undefined) {
      return;
    }
    // Claim the jump so the file-jump effect (next) doesn't also scroll to the file.
    // The host path, matching what `focusComment` put in `selectedFilePath`.
    lastJumpedPath.current = entry.path;
    scrollToComment(entry);
  }, [activeCommentId, files, comments, frozen, scrollToComment]);

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
  }, [selectedFilePath]);

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
  }, [activeLayerId]);

  // Capture rides CodeView's public onScroll (internally subscribeToScroll) — no
  // DOM polling. Debounced so a fast scroll is not a write per frame, and flushed
  // on unmount so the last position before a tab switch survives.
  const capture = useMemo(() => createScrollCapture(onScrollTop), [onScrollTop]);
  useEffect(() => () => capture.flush(), [capture]);

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
        onScroll={(scrollTop) => {
          // A soloed layer's scroll is derived view state — never the reader's place
          // in the full diff, so it must not be captured or persisted.
          if (capturesScroll(activeLayerIdRef.current)) {
            capture.notify(scrollTop);
          }
        }}
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

type FileFoldToggleProps = { path: string };

/** The file's disclosure twisty. Folding is the reader's own — any file can be put away,
 * read or not — but it is also the tail of marking a file read: a file you are done with
 * stops spending pane height, and the ones still owed rise to meet you. The header stays,
 * so a folded file is one click from being read again.
 *
 * Reads the fold state from the store rather than taking it as a prop, for the same reason
 * `FileReadToggle` beside it does: a header slot that closes over one of DiffView's props
 * cannot have a stable render-prop identity, and without that Pierre re-renders every
 * visible file's slots on every DiffView render. Its own subscription repaints the one
 * twisty that changed, and the folded body follows separately through the item's `version`.
 * Safe because exactly one DiffView is mounted — the active session's (`key=`). */
const FileFoldToggle = memo(function FileFoldToggle({ path }: FileFoldToggleProps): ReactElement {
  const collapsed = useReviewStore(
    (state) => selectActiveSlice(state)?.collapsedFiles.has(path) ?? false,
  );
  const setFileCollapsed = useReviewStore((state) => state.setFileCollapsed);
  return (
    // The path is already the loudest thing on the band, so the hint names the verb alone
    // rather than repeating it back — unlike the aria-label, which has no band to lean on.
    <TooltipHint content={collapsed ? "Expand file" : "Collapse file"} side="bottom" align="start">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `Expand ${path}` : `Collapse ${path}`}
        className="text-text-muted"
        onClick={() => setFileCollapsed(path, !collapsed)}
      >
        {collapsed ? <ChevronRight /> : <ChevronDown />}
      </Button>
    </TooltipHint>
  );
});

type FileNameSuffixProps = { path: string; binary: boolean };

/** What follows the file's name on the band: the copy affordance, and — on a binary
 * change — the word that says which of the two header-only shapes this is (a binary
 * change and a pure rename both render zero hunks). */
const FileNameSuffix = memo(function FileNameSuffix({
  path,
  binary,
}: FileNameSuffixProps): ReactElement {
  return (
    <span className="flex items-center gap-1">
      <CopyPathButton path={path} />
      {binary ? <span className="text-xs text-text-muted">binary</span> : null}
    </span>
  );
});

type CopyPathButtonProps = { path: string };

/** Affordance sitting just after the file's name that puts its repo-relative path on
 * the clipboard. The check only shows once the clipboard write resolves — a failed
 * write keeps the copy glyph, never a false success. size-6 (icon-xs) matches the
 * gutter `+`'s micro-control scale and meets the hit-target floor. */
function CopyPathButton({ path }: CopyPathButtonProps): ReactElement {
  const { copied, confirm } = useCopyFeedback();

  return (
    // The hint doubles as the success message: the check glyph alone says *something*
    // happened, the word says what, and both revert together when the timer runs out.
    <TooltipHint content={copied ? "Path copied" : "Copy file path"} side="bottom" align="start">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Copy file path"
        className="text-text-muted"
        onClick={() => {
          navigator.clipboard.writeText(path).then(
            confirm,
            // A denied/failed write only skips the feedback; there is no state to roll
            // back, and the header band is no place for an error surface.
            () => {},
          );
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </TooltipHint>
  );
}

type GutterAddButtonProps = {
  getHoveredLine: Parameters<GutterUtilityRenderer>[0];
  item: CodeViewItem<CommentSlot>;
  handleRef: RefObject<CodeViewHandle<CommentSlot> | null>;
  onOpenDraft: (fileId: string, anchor: ReviewAnchor) => void;
};

/** The gutter `+`: the one deliberate gesture that opens the comment editor, on the
 * hovered line or on a deliberate multi-line drag.
 *
 * Pierre's line selection is never mirrored into React. It fires a change on every line
 * delta of a gutter drag, so a mirror would cost a DiffView render — and, through the
 * portal host, a re-render of every visible file's slots — per line dragged over. The
 * anchor has always been read imperatively at click time; the label is read the same way,
 * on the way in to the button. It cannot be read at render time instead: Pierre renders
 * this slot once per item and then moves it between gutter rows, so a render-time read
 * would freeze the label at whatever was selected when the file was first painted. */
const GutterAddButton = memo(function GutterAddButton({
  getHoveredLine,
  item,
  handleRef,
  onOpenDraft,
}: GutterAddButtonProps): ReactElement {
  // True while a deliberate multi-line drag covers this file. Re-read on every way the
  // button can be reached, each of which lands before the hint's 700 ms delay elapses or
  // the accessible name is announced. All four are needed and none is redundant: `enter`
  // for the button materializing under a resting pointer (Pierre places it in response to
  // the hover, so the move that caused the hover was dispatched to the line number, not to
  // a button that did not exist yet — the browser then re-fires only the boundary events);
  // `move` for a selection that changes while the pointer is already inside; `down` for
  // touch and pen, which can tap without ever having hovered; `focus` for the keyboard.
  // Repeats are free: React bails out of a setState that does not change the value.
  const [ranged, setRanged] = useState(false);
  const syncRanged = useCallback((): void => {
    setRanged(selectionRange(handleRef.current?.getSelectedLines() ?? null, item.id) !== null);
  }, [handleRef, item.id]);

  return (
    // size-6 (24px) meets the hit-target floor; the glyph stays 12px so
    // the affordance still reads as a gutter micro-control. Accent is the add
    // trigger (only one shows at a time, on the hovered line). The label names
    // the real action: a range when a deliberate multi-line drag covers this
    // file, a single line otherwise — and the hint says the same, because a bare
    // `+` in a gutter is the one glyph here that could plausibly mean expand.
    <TooltipHint
      side="right"
      align="center"
      content={ranged ? "Comment on the selected lines" : "Comment on this line"}
    >
      <Button
        type="button"
        size="icon-xs"
        // Keep the primary fill solid on hover: the default variant's
        // `hover:bg-primary/80` reads as the add affordance dimming, not lifting.
        className="hover:bg-primary"
        aria-label={ranged ? "Add a comment on the selected lines" : "Add a comment on this line"}
        onPointerEnter={syncRanged}
        onPointerMove={syncRanged}
        onPointerDown={syncRanged}
        onFocus={syncRanged}
        // Replacing Pierre's default `[data-utility-button]` drops the
        // stacking lift and gutter offset it carried (z-index + a negative
        // right margin in the gutter's own lh/ch metric); without them our
        // composite paints under, and sits inside, the line-number column.
        // Restore Pierre's exact values so the affordance clears the numbers.
        style={{ position: "relative", zIndex: 4, marginRight: "calc(-1lh + 1ch)" }}
        onClick={() => {
          const handle = handleRef.current;
          const raw = getHoveredLine();
          // Narrow Pierre's file|diff hovered union to an anchor-side line, or
          // null (a file-mode row with no side, never a diff gutter).
          let hovered: HoveredLine | null = null;
          if (raw !== undefined && "side" in raw) {
            const side = raw.side;
            if (side === "additions" || side === "deletions") {
              hovered = { lineNumber: raw.lineNumber, side };
            }
          }
          // A deliberate multi-line drag that covers this `+` commits its range,
          // clamped to the hunk it was committed from — hunks render contiguously,
          // so a drag across the separator would otherwise anchor across collapsed
          // context no hunk covers. Otherwise the single hovered line. Clear the
          // selection either way so its highlight does not linger under the opened
          // editor.
          const anchor = pickAddAnchor(
            item.id,
            hovered,
            handle?.getSelectedLines() ?? null,
            item.type === "diff" ? item.fileDiff.hunks : [],
          );
          if (anchor !== null) {
            onOpenDraft(item.id, anchor);
            handle?.clearSelectedLines();
            setRanged(false);
          }
        }}
      >
        <Plus />
      </Button>
    </TooltipHint>
  );
});

type CommentAnnotationFrameProps = { twoColumn: boolean; children: ReactNode };

/** The band a comment sits in, and the inset that keeps it readable.
 *
 * Two elements, because they do opposite jobs. The outer one takes the annotation
 * slot's full line width and paints `--comment-band`: on a light theme the card
 * wants to be white — paper, at full text contrast — and a white card on a white
 * diff has nothing left to make it *noticeable*, so the emphasis moves off the card
 * and onto the row holding it. The inner one caps the measure.
 *
 * The cap is set against the *lane*, so it follows how this particular file is
 * painting — `twoColumn`, not the view's mode, since a new or deleted file stays
 * single-column even in split (see `rendersTwoColumns`). Beside two columns a
 * comment belongs to the file, not to one column of it, and has to read as clearly
 * out-spanning a lane: anything near a single lane width looks like a mistake, so it
 * takes `5xl` and claims well past the half. Against one column there is nothing to
 * out-span and the cap goes back to serving the prose — `2xl` is around 75
 * characters, and the width the split case needs would only be line length here. */
function CommentAnnotationFrame({
  twoColumn,
  children,
}: CommentAnnotationFrameProps): ReactElement {
  return (
    <div className="bg-comment-band py-3 pr-4 pl-14">
      <div className={twoColumn ? "max-w-5xl" : "max-w-2xl"}>{children}</div>
    </div>
  );
}
