import { memo, useCallback, type ReactElement } from "react";
import type { CodeViewProps } from "@pierre/diffs/react";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";
import type { CommentSlot } from "../../../../shared/diff/comment-annotations";
import { Button } from "@/components/ui/button";
import { FileReadToggle } from "@/components/FileReadToggle";
import { TooltipHint } from "@/components/ui/tooltip";
import { useCopyFeedback } from "@/lib/copy-feedback";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

// The three slots Pierre lets us hang chrome off a file's header band, and what this app
// puts in each: the fold twisty ahead of the name, the copy affordance (and the binary
// tell) right after it, and the read control alone at the far edge.
//
// Every one of them is handed to CodeView by name — a module constant where it closes over
// nothing, a `useCallback` where it needs this view's data — because Pierre memoizes the
// portal host that owns every slot on the surface (`SlotPortals`, CodeView.js) on a shallow
// compare of the render props, and one failed compare re-renders EVERY visible file's slots,
// tooltip trees included. The contents are `memo` leaves that read their own state for the
// same reason: a slot that closes over a prop of the view cannot have a stable identity, and
// a leaf with its own subscription repaints only the file whose state actually changed.
type HeaderSlotRenderer = NonNullable<CodeViewProps<CommentSlot>["renderHeaderPrefix"]>;

// The file's own disclosure, at the head of its header band: a folded file is
// still a file in the diff, and the twisty is what says so. It leads the name
// for the same reason a tree's does — the thing that opens a row goes before
// the row's name, not after everything else on it.
export const renderHeaderPrefix: HeaderSlotRenderer = (item) => <FileFoldToggle path={item.id} />;

// The read control alone at the outer edge — the band's most-reached-for
// corner, and where every reviewer's hand already goes for it.
export const renderHeaderMetadata: HeaderSlotRenderer = (item) => <FileReadToggle path={item.id} />;

/** Copying the path belongs to the name, not to the band's trailing controls: it acts on
 * the text it sits beside, so it follows the name directly rather than travelling to the
 * far corner where the read control lives. Keyed on `binaryPaths` alone — which the view
 * memoizes on `files`, so this identity survives every other state change it holds, and
 * the one thing that does move it (a new file list) rebuilds the items and re-renders the
 * portals regardless. */
export function useHeaderFilenameSuffix(binaryPaths: ReadonlySet<string>): HeaderSlotRenderer {
  return useCallback<HeaderSlotRenderer>(
    (item) => <FileNameSuffix path={item.id} binary={binaryPaths.has(item.id)} />,
    [binaryPaths],
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
