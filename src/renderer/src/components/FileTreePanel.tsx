import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatus } from "@pierre/trees";
import { Search } from "lucide-react";
import { assertNever } from "../../../shared/assert";
import type { Comment } from "../../../shared/review";
import { countLabel } from "../../../shared/plural";
import { commentCountsByFile } from "@/lib/diff/comment-navigation";
import { RailFoot, RailNote } from "@/components/rail";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { TooltipHint } from "@/components/ui/tooltip";
import { ReadRing, readLabel } from "@/components/ReadRing";
import type { FileChangeStatus, PatchFile } from "../../../shared/diff/patch";
import { NO_READ_FILES, readPaths, tallyRead } from "@/lib/read-progress";
import { fuzzyMatches } from "@/lib/fuzzy";
import { selectActiveSlice, selectSoloedDiff, useReviewStore } from "@/stores/review";

function toTreeGitStatus(status: FileChangeStatus): GitStatus {
  switch (status) {
    case "added":
      return "added";
    case "modified":
      return "modified";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return assertNever(status);
  }
}

/** Stable empty arrays for the sessionless / unloaded case, so the selectors below return
 * one constant reference rather than a fresh [] per tick. */
const EMPTY_FILES: PatchFile[] = [];
const EMPTY_COMMENTS: Comment[] = [];

/** Changed-files tree for the loaded diff, behind a fuzzy path filter. Remount
 * with a new `key` when the listed subset changes identity — that also resets the filter,
 * which belongs to one subset, not the session.
 *
 * A section, so it reads its own state (the rail's rule, `ReviewRail.tsx`): the rail hands
 * it nothing but that key. */
export function FileTreePanel(): ReactElement {
  const [filter, setFilter] = useState("");
  // What the tree lists: the soloed subset, from the one derivation the rail and the code
  // view also read (`lib/soloed-diff.ts`), so a solo narrows all three to the same files.
  const files = useReviewStore((state) => selectSoloedDiff(state).files);
  // Counted against the loaded diff, not the tree's (possibly soloed) subset: the badge
  // is a property of the file, and the count is keyed on the path the tree rows carry —
  // which is why the files go in at all (a comment authored before a rename badges the
  // renamed row, the one its card is actually on).
  const loadedFiles = useReviewStore((state) => {
    const diff = selectActiveSlice(state)?.diff;
    return diff !== undefined && diff.phase === "loaded" ? diff.files : EMPTY_FILES;
  });
  const comments = useReviewStore((state) => selectActiveSlice(state)?.comments ?? EMPTY_COMMENTS);
  const commentCounts = useMemo(
    () => commentCountsByFile(loadedFiles, comments),
    [loadedFiles, comments],
  );
  const readFiles = useReviewStore((state) => selectActiveSlice(state)?.readFiles ?? NO_READ_FILES);
  const clearFilesRead = useReviewStore((state) => state.clearFilesRead);
  const visibleFiles = useMemo(
    () => files.filter((file) => fuzzyMatches(filter, file.path)),
    [files, filter],
  );
  // Over the panel's own listing, not the filtered view: a filter is a way of looking at
  // the set, not a change to it, so typing in the box must not move the progress readout.
  const tally = useMemo(() => tallyRead(files, readFiles), [files, readFiles]);

  return (
    <div data-file-tree className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 pt-2">
        <InputGroup>
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filter !== "") {
                event.stopPropagation();
                setFilter("");
              }
            }}
            placeholder="Filter files"
            aria-label="Filter files"
            spellCheck={false}
          />
        </InputGroup>
      </div>
      {visibleFiles.length === 0 ? (
        <RailNote>No files match the filter.</RailNote>
      ) : (
        // The tree model is immutable after creation, so a filter change means a
        // remount. Keyed by the matched subset rather than the query, so refining
        // a filter without changing its matches keeps expansion state.
        <ChangedFileTree
          key={visibleFiles.map((file) => file.path).join("\n")}
          files={visibleFiles}
          commentCounts={commentCounts}
          readPaths={readPaths(visibleFiles, readFiles)}
        />
      )}
      {files.length > 0 && <ReadStatusLine files={files} onClear={clearFilesRead} tally={tally} />}
    </div>
  );
}

type ReadStatusLineProps = {
  files: PatchFile[];
  tally: ReturnType<typeof tallyRead>;
  onClear: (paths: readonly string[]) => void;
};

/** The rail's foot: how far through this listing the reader is, in one quiet line under
 * the tree — the place a desktop app has always put a count of what is above it.
 *
 * It is present from the first render rather than appearing once progress exists: a status
 * line that materialises after the first click is a layout shift, and reading `0 of 12` is
 * how a reader finds out there is progress to make at all.
 *
 * It counts what the tree lists, which under a soloed layer is that chapter — so it stays
 * the answer to "how far through what I am looking at", and its reset can only ever undo
 * what it counted. */
function ReadStatusLine({ files, tally, onClear }: ReadStatusLineProps): ReactElement {
  return (
    <RailFoot>
      <ReadRing tally={tally} />
      <span className="min-w-0 truncate tabular-nums">{readLabel(tally)}</span>
      {tally.read > 0 && (
        <TooltipHint
          side="top"
          align="end"
          content={files.length === tally.total ? "Mark these files unread" : "Mark unread"}
        >
          <Button
            variant="chrome"
            size="xs"
            onClick={() => onClear(files.map((file) => file.path))}
            className="ml-auto shrink-0 text-text-muted"
          >
            Reset
          </Button>
        </TooltipHint>
      )}
    </RailFoot>
  );
}

type ChangedFileTreeProps = {
  files: PatchFile[];
  /** How many comments each file carries, for the per-file count badge. Keyed by
   * `PatchFile.path`; a file with none gets no badge. */
  commentCounts: Map<string, number>;
  /** Which of these files the reader has been through, resolved against the loaded diff's
   * content upstream so a row never has to re-derive a signature per render. */
  readPaths: ReadonlySet<string>;
};

function ChangedFileTree({
  files,
  commentCounts,
  readPaths: read,
}: ChangedFileTreeProps): ReactElement {
  const selectedFilePath = useReviewStore(
    (state) => selectActiveSlice(state)?.selectedFilePath ?? null,
  );
  const selectFile = useReviewStore((state) => state.selectFile);

  // Pierre builds the tree once (its options are captured at construction), so the
  // decoration renderer must read counts through a ref to stay current: a comment
  // add/discard updates the ref, and the badge refreshes on the next row render
  // (scroll/expand/select) rather than a full remount that would drop tree state.
  const countsRef = useRef(commentCounts);
  countsRef.current = commentCounts;

  // Read state rides the same ref, but unlike a comment count it cannot wait for the next
  // incidental row render: the mark is the reader's own click, and feedback that arrives
  // on the next scroll is feedback that reads as a bug. The effect below repaints for it.
  const readRef = useRef(read);
  readRef.current = read;

  // What the store already believes, read at callback time — the echo filter below.
  const selectedRef = useRef(selectedFilePath);
  selectedRef.current = selectedFilePath;

  const { model } = useFileTree({
    paths: files.map((file) => file.path),
    gitStatus: files.map((file) => ({
      path: file.path,
      status: toTreeGitStatus(file.status),
    })),
    // 24px rows (Pierre's own compact preset): the dense-tool register — a
    // changed-files list is scanned, not read.
    density: "compact",
    initialExpansion: "open",
    initialSelectedPaths: selectedFilePath === null ? [] : [selectedFilePath],
    // Pierre reports EVERY selection change, programmatic ones included: the callback
    // rides a store subscription, not a click handler. So the mirror effect below —
    // which pushes the store's focused file INTO the tree — comes straight back here,
    // and routing that echo through `selectFile` would run the full "the reader
    // clicked a file" policy, which dismisses the comment walk. That is how jumping
    // to a comment in another file used to kill its own focus one tick later: the
    // floating stepper never appeared, or vanished on the first step that crossed a
    // file. An echo is exactly a report that already matches the store, so dropping
    // it costs no real gesture — clicking the row that is already selected is a
    // no-op by definition.
    onSelectionChange: (selected) => {
      const path = selected[0];
      if (path !== undefined && path !== selectedRef.current) {
        selectFile(path);
      }
    },
    // One decoration slot per row, so it answers the one question a progress-tracking
    // reader is scanning for: what is still owed here. An unread file owes its comments,
    // so it wears the count; a read file owes nothing, so it wears the check instead —
    // its comments were on screen in the file the reader just finished. A read file with
    // findings keeps the count in its hover title, where it costs no width.
    renderRowDecoration: (context) => {
      if (context.item.kind !== "file") {
        return null;
      }
      const count = countsRef.current.get(context.item.path) ?? 0;
      const comments = countLabel(count, "comment");
      if (readRef.current.has(context.item.path)) {
        return { text: "✓", title: count === 0 ? "Read" : `Read · ${comments}` };
      }
      if (count === 0) {
        return null;
      }
      return { text: String(count), title: comments };
    },
  });

  // Repaint the rows when the read set changes. The decoration renderer was captured at
  // construction and Pierre exposes no way to invalidate one row's decoration, so this
  // re-renders the whole tree through the one public lever that always does
  // (`setComposition` has no early-out) — handing back the composition it already holds,
  // which changes nothing about the tree but its painted output. Selection, expansion and
  // scroll all live in the controller and survive it; a remount would lose all three.
  // Seeded with the mount value and value-compared, so the mount itself stays inert and a
  // StrictMode replay with the same set does not repaint twice.
  const lastPainted = useRef(read);
  useEffect(() => {
    if (read === lastPainted.current) {
      return;
    }
    lastPainted.current = read;
    model.setComposition(model.getComposition());
  }, [model, read]);

  // Only a post-mount change of the focused file (j/k stepping) scrolls its row into
  // view; a fresh mount — a new session, load, soloed layer, or filter change — is
  // left at the top, so a layer change resets the tree just as it resets the diff.
  // Seeded with the mount path and value-compared, so the mount stays inert (a
  // StrictMode replay with the same value too) where a fire-once flag would fire on
  // remount.
  const lastScrolledPath = useRef(selectedFilePath);
  // Anything that moves the focused file without touching the tree — j/k, a comment
  // jump, a file link in the chapter prose — changes the store; mirror it into the
  // tree. item.select() ADDS to the tree's selection, so stale rows must be deselected
  // first, or the tree ends up multi-selected. Every write here echoes back through
  // onSelectionChange; the guard above is what keeps that echo from re-entering the
  // store. The store steps through the full diff, so the selected path may be filtered
  // out of this tree — getItem/scrollToPath treat an unknown path as a no-op.
  useEffect(() => {
    if (selectedFilePath === null) {
      return;
    }
    const selected = model.getSelectedPaths();
    const alreadySelected = selected.length === 1 && selected[0] === selectedFilePath;
    if (!alreadySelected) {
      for (const path of selected) {
        if (path !== selectedFilePath) {
          model.getItem(path)?.deselect();
        }
      }
      if (!selected.includes(selectedFilePath)) {
        model.getItem(selectedFilePath)?.select();
      }
    }
    if (selectedFilePath !== lastScrolledPath.current) {
      model.scrollToPath(selectedFilePath);
    }
    lastScrolledPath.current = selectedFilePath;
  }, [model, selectedFilePath]);

  // Top inset only: the tree needs air under the filter box, but the bottom of the listing
  // is already closed by the status line's own top border — padding there just strands the
  // last row above a rule and makes the panel look like it stopped short of its section.
  return (
    <div className="min-h-0 flex-1 pt-2">
      <FileTree model={model} className="h-full" />
    </div>
  );
}
