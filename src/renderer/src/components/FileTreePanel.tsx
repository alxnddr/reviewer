import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatus } from "@pierre/trees";
import { Search } from "lucide-react";
import { assertNever } from "../../../shared/assert";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import type { FileChangeStatus, PatchFile } from "@/lib/diff/patch";
import { fuzzyMatches } from "@/lib/fuzzy";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

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

type FileTreePanelProps = {
  files: PatchFile[];
  /** How many comments each file carries, for the per-file count badge. Keyed by
   * `PatchFile.path`; a file with none gets no badge. */
  commentCounts: Map<string, number>;
};

/** Changed-files tree for the loaded diff, behind a fuzzy path filter. Remount
 * with a new `key` when `files` changes identity — that also resets the filter,
 * which belongs to one subset, not the session. */
export function FileTreePanel({ files, commentCounts }: FileTreePanelProps): ReactElement {
  const [filter, setFilter] = useState("");
  const visibleFiles = useMemo(
    () => files.filter((file) => fuzzyMatches(filter, file.path)),
    [files, filter],
  );

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
        <p className="px-3 py-3 text-xs text-text-muted">No files match the filter.</p>
      ) : (
        // The tree model is immutable after creation, so a filter change means a
        // remount. Keyed by the matched subset rather than the query, so refining
        // a filter without changing its matches keeps expansion state.
        <ChangedFileTree
          key={visibleFiles.map((file) => file.path).join("\n")}
          files={visibleFiles}
          commentCounts={commentCounts}
        />
      )}
    </div>
  );
}

type ChangedFileTreeProps = {
  files: PatchFile[];
  commentCounts: Map<string, number>;
};

function ChangedFileTree({ files, commentCounts }: ChangedFileTreeProps): ReactElement {
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
    // Per-file comment count on the right of its row; files with none stay bare.
    renderRowDecoration: (context) => {
      if (context.item.kind !== "file") {
        return null;
      }
      const count = countsRef.current.get(context.item.path) ?? 0;
      if (count === 0) {
        return null;
      }
      return { text: String(count), title: count === 1 ? "1 comment" : `${count} comments` };
    },
  });

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

  return (
    <div className="min-h-0 flex-1 py-2">
      <FileTree model={model} className="h-full" />
    </div>
  );
}
