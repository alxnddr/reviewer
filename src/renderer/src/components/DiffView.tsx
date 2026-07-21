import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import type {
  CodeViewLayout,
  CodeViewLineSelection,
  CodeViewOptions,
  DiffLineAnnotation,
  FileDiffContentsLoader,
  LineAnnotation,
} from "@pierre/diffs";
import { Check, Copy, Plus } from "lucide-react";
import type { ReviewAnchor } from "../../../shared/review";
import { Button } from "@/components/ui/button";
import { CommentEditor } from "@/components/CommentEditor";
import { CommentThread } from "@/components/CommentThread";
import { CommentNavIndicator } from "@/components/CommentNavIndicator";
import { DiffSearch } from "@/components/DiffSearch";
import { useDiffSearch } from "@/lib/diff/use-diff-search";
import { indexOfComment, navigableEntries, orderedComments } from "@/lib/diff/comment-navigation";
import { commentLocation } from "@/lib/comment-body";
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
import type { DiffStyle } from "@/stores/review";
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
  // A mirror of Pierre's active line selection (uncontrolled — Pierre still owns
  // it; this only observes) so the gutter `+` can name its action honestly: a
  // deliberate multi-line drag makes it a range add, an ordinary hover a line add.
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null);

  // Find-in-diff. The surface is virtualized, so off-screen lines never enter the
  // DOM and the browser's native find is blind to them; this searches the parsed
  // patch and navigates by driving the same handle used for file jumps. It
  // highlights the active match through Pierre's line selection (written
  // notify:false, so it never reaches `setSelection` above or the comment `+`).
  const search = useDiffSearch(handleRef, files);

  const items = useMemo(
    () => buildCommentItems(files, comments, { editingId, draft }, frozen, activeCommentId),
    [files, comments, editingId, draft, frozen, activeCommentId],
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
          <CommentAnnotationFrame>
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
          <CommentAnnotationFrame>
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
        <CommentAnnotationFrame>
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

  // The one scroll owner on activation. The empty deps make this a mount-once
  // snapshot of the persisted position — a mount IS an activation (the view is
  // keyed per session), and later changes to those props are this view's own
  // captures, not new activations. A recorded position wins over the file-jump, so
  // only one scrollTo ever fires. Instant — a tab switch is a keyboard/click
  // action, never animated. Position restore stays correct through virtualized
  // measurement: CodeView re-anchors the settled scroll as item heights resolve,
  // so no second call is needed.
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

  // Post-activation file jumps (tree click, j/k). Gated on an actual change of the
  // focused file from the last one jumped to — seeded with the activation snapshot,
  // so the mount (owned by the restore above) is a no-op and the two never both
  // fire. A value-compare, not a fire-once flag: a StrictMode remount replays with
  // the same value and stays inert, where a boolean guard would flip and jump.
  const lastJumpedPath = useRef(selectedFilePath);

  // Scroll to the focused comment (a sidebar click or an `n`/`p` step). Declared
  // BEFORE the file-jump effect below and seeding `lastJumpedPath`: `focusComment`
  // sets `activeCommentId` and `selectedFilePath` in one store write, so both change
  // in the same commit — running first and claiming the jump makes the file-jump
  // effect a no-op, so exactly one precise scroll fires (line/centre, not
  // file/start). Value-compare-seeded like the jumps, so a mount / StrictMode replay
  // is inert (the persisted-scroll restore owns the mount; the ring still paints from
  // `items`, so a tab bounce keeps the highlight without a competing scroll). A
  // placed comment centres on its line; an outdated one has no line, so its file
  // header is brought into view where it renders; an id with no host item here
  // (soloed out, unplaceable, or discarded) is a no-op.
  const lastFocusedCommentId = useRef(activeCommentId);
  useEffect(() => {
    if (activeCommentId === lastFocusedCommentId.current) {
      return;
    }
    lastFocusedCommentId.current = activeCommentId;
    if (activeCommentId === null) {
      return;
    }
    const handle = handleRef.current;
    if (handle === null) {
      return;
    }
    const entry = orderedComments(files, comments, frozen).find(
      (candidate) => candidate.comment.id === activeCommentId,
    );
    if (entry === undefined) {
      return;
    }
    // Claim the jump so the file-jump effect (next) doesn't also scroll to the file.
    lastJumpedPath.current = entry.comment.file;
    if (entry.status === "placed" && entry.line !== null) {
      handle.scrollTo({
        type: "line",
        id: entry.comment.file,
        lineNumber: entry.line,
        side: entry.comment.side,
        align: "center",
        behavior: "instant",
      });
    } else {
      handle.scrollTo({
        type: "item",
        id: entry.comment.file,
        align: "start",
        behavior: "instant",
      });
    }
  }, [activeCommentId, files, comments, frozen]);

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
          location={commentLocation(navActive.comment)}
          outdated={navActive.status === "outdated"}
          onPrevious={() => onStepComment(-1)}
          onNext={() => onStepComment(1)}
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
        items={items}
        options={options}
        onScroll={(scrollTop) => {
          // A soloed layer's scroll is derived view state — never the reader's place
          // in the full diff, so it must not be captured or persisted.
          if (capturesScroll(activeLayerIdRef.current)) {
            capture.notify(scrollTop);
          }
        }}
        className="h-full overflow-y-auto"
        onSelectedLinesChange={setSelection}
        renderHeaderFilenameSuffix={(item) =>
          binaryPaths.has(item.id) ? (
            <span className="font-mono text-xs text-text-muted">binary</span>
          ) : null
        }
        renderHeaderMetadata={(item) => <CopyPathButton path={item.id} />}
        renderAnnotation={renderAnnotation}
        renderGutterUtility={(getHoveredLine, item) => (
          // size-6 (24px) meets the hit-target floor; the glyph stays 12px so
          // the affordance still reads as a gutter micro-control. Accent is the add
          // trigger (only one shows at a time, on the hovered line). The label names
          // the real action: a range when a deliberate multi-line drag covers this
          // file, a single line otherwise.
          <Button
            type="button"
            size="icon-xs"
            // Keep the primary fill solid on hover: the default variant's
            // `hover:bg-primary/80` reads as the add affordance dimming, not lifting.
            className="hover:bg-primary"
            aria-label={
              selectionRange(selection, item.id) === null
                ? "Add a comment on this line"
                : "Add a comment on the selected lines"
            }
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
              // A deliberate multi-line drag that covers this `+` commits its range;
              // otherwise the single hovered line. Clear the selection either way so
              // its highlight does not linger under the opened editor.
              const anchor = pickAddAnchor(item.id, hovered, handle?.getSelectedLines() ?? null);
              if (anchor !== null) {
                openDraft(item.id, anchor);
                handle?.clearSelectedLines();
              }
            }}
          >
            <Plus />
          </Button>
        )}
      />
    </div>
  );
}

type CopyPathButtonProps = { path: string };

/** How long the copied check glyph stands in for the copy glyph after a click. */
const COPY_FEEDBACK_MS = 1500;

/** Header-band affordance that puts the file's repo-relative path on the clipboard.
 * The check only shows once the clipboard write resolves — a failed write keeps the
 * copy glyph, never a false success. size-6 (icon-xs) matches the gutter `+`'s
 * micro-control scale and meets the hit-target floor. */
function CopyPathButton({ path }: CopyPathButtonProps): ReactElement {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Copy file path"
      className="text-text-muted"
      onClick={() => {
        navigator.clipboard.writeText(path).then(
          () => setCopied(true),
          // A denied/failed write only skips the feedback; there is no state to roll
          // back, and the header band is no place for an error surface.
          () => undefined,
        );
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

type CommentAnnotationFrameProps = { children: ReactNode };

/** Insets the comment surface off the code column and caps its measure so a long
 * thread stays readable — the annotation slot itself spans the full line width. */
function CommentAnnotationFrame({ children }: CommentAnnotationFrameProps): ReactElement {
  return <div className="max-w-2xl px-4 py-2 pl-14">{children}</div>;
}
