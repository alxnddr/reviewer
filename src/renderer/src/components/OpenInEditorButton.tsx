import { memo, type ReactElement } from "react";
import { ExternalLink } from "lucide-react";
import { editorMeta } from "../../../shared/editors";
import type { ReviewSide } from "../../../shared/review";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { editorAvailability, editorTargetFor, fileForPath } from "@/lib/editor-target";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { selectActiveSlice, useReviewStore } from "@/stores/review";
import { useSettingsStore } from "@/stores/settings";

// The one Open in Editor control, drawn in two places: after a file's name on its header band
// (the whole file, at its first line in the diff) and on a comment's hover toolbar (that
// comment's line). A memo leaf with its own subscriptions, for the reason every other control
// on the diff surface is (`DiffFileHeader.tsx`): a slot that closes over a prop of the view
// cannot keep a stable render-prop identity, and a leaf that reads its own state repaints only
// the file whose state changed.
//
// It is never hidden, only disabled. A control that vanishes on a frozen review or before an
// editor is chosen tells the reader nothing; one that stays and says why — "locate the
// repository first", "choose an editor" — is the affordance for the fix. Disabled is spelled
// `aria-disabled` rather than `disabled`, because a disabled button receives no pointer events
// and the tooltip carrying that sentence would never open.

type OpenInEditorButtonProps = {
  /** The file, as the diff names it (`PatchFile.path`, or an anchor's authored path). */
  path: string;
  /** Where in it to land — a diff-side line, translated to the file on disk — or nothing, for
   * the file's own opening line. Two primitives rather than one object so the memo compare
   * holds across a parent's re-render. */
  anchorSide?: ReviewSide;
  anchorLine?: number;
  hintSide: "top" | "bottom";
  hintAlign: "start" | "center" | "end";
  className?: string;
};

export const OpenInEditorButton = memo(function OpenInEditorButton({
  path,
  anchorSide,
  anchorLine,
  hintSide,
  hintAlign,
  className,
}: OpenInEditorButtonProps): ReactElement {
  const editor = useSettingsStore((state) => state.resolved.editor);
  const sessionId = useReviewStore((state) => state.activeSessionId);
  const frozen = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewDiff?.kind === "frozenPatch",
  );
  // The lookup answers the same object while the diff is the same, so this subscription is
  // quiet across every state change that is not a new file list.
  const file = useReviewStore((state) => {
    const diff = selectActiveSlice(state)?.diff;
    return diff?.phase === "loaded" ? fileForPath(diff.files, path) : null;
  });
  const open = useEditorStore((state) => state.open);

  const availability = editorAvailability({ editor, frozen, file });
  const ready = availability === "ready";
  const hint = hintFor(availability, editor === "none" ? null : editorMeta(editor).label);

  return (
    <TooltipHint content={hint} side={hintSide} align={hintAlign}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={hint}
        aria-disabled={!ready}
        className={cn(
          "text-text-muted",
          !ready && "cursor-default opacity-40 hover:bg-transparent hover:text-text-muted",
          className,
        )}
        onClick={() => {
          if (!ready || sessionId === null) {
            return;
          }
          // A file the loaded diff does not carry (a comment whose file dropped out) still
          // names a path; main decides whether the checkout has it.
          const target =
            file === null
              ? { path }
              : editorTargetFor(
                  file,
                  anchorSide === undefined || anchorLine === undefined
                    ? null
                    : { side: anchorSide, line: anchorLine },
                );
          void open({ sessionId, ...target });
        }}
      >
        <ExternalLink />
      </Button>
    </TooltipHint>
  );
});

/** The hint doubles as the label: the verb and the editor while it can act, the reason and
 * the fix while it cannot. A value-returning switch with no default, so a new availability
 * has to be given a sentence before the build passes. */
function hintFor(
  availability: ReturnType<typeof editorAvailability>,
  label: string | null,
): string {
  switch (availability) {
    case "ready":
      return `Open in ${label ?? "editor"}`;
    case "frozen":
      return "Locate the repository first to open files in an editor";
    case "noEditor":
      return "Choose an editor in Settings to open files";
    case "deleted":
      return "Deleted by this change; nothing on disk to open";
  }
}
