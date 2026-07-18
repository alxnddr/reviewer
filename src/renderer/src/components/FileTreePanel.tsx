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
};

/** Changed-files tree for the loaded diff, behind a fuzzy path filter. Remount
 * with a new `key` when `files` changes identity — that also resets the filter,
 * which belongs to one subset, not the session. */
export function FileTreePanel({ files }: FileTreePanelProps): ReactElement {
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
        />
      )}
    </div>
  );
}

type ChangedFileTreeProps = {
  files: PatchFile[];
};

function ChangedFileTree({ files }: ChangedFileTreeProps): ReactElement {
  const selectedFilePath = useReviewStore(
    (state) => selectActiveSlice(state)?.selectedFilePath ?? null,
  );
  const selectFile = useReviewStore((state) => state.selectFile);

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
    onSelectionChange: (selected) => {
      const path = selected[0];
      if (path !== undefined) {
        selectFile(path);
      }
    },
  });

  // Only a post-mount change of the focused file (j/k stepping) scrolls its row into
  // view; a fresh mount — a new session, load, soloed layer, or filter change — is
  // left at the top, so a layer change resets the tree just as it resets the diff.
  // Seeded with the mount path and value-compared, so the mount stays inert (a
  // StrictMode replay with the same value too) where a fire-once flag would fire on
  // remount.
  const lastScrolledPath = useRef(selectedFilePath);
  // Keyboard next/prev (j/k) changes the store; mirror it into the tree. item.select()
  // ADDS to the tree's selection, so stale rows must be deselected first — otherwise
  // onSelectionChange reports the old path first and pushes the store back (oscillation).
  // The store steps through the full diff, so the selected path may be filtered out of
  // this tree — getItem/scrollToPath treat an unknown path as a no-op.
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
