import type { ReactElement } from "react";
import { FolderOpen } from "lucide-react";
import { editorMeta } from "../../../shared/editors";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { repoEditorAvailability } from "@/lib/editor-target";
import { useEditorStore } from "@/stores/editor";
import { selectActiveSlice, useReviewStore } from "@/stores/review";
import { useSettingsStore } from "@/stores/settings";

// The repository itself, handed to the editor as a project — the other half of Open in Editor,
// and the answer to "I have read the argument, now let me go and work in this tree".
//
// It is in the title bar, which is not where the task that asked for it expected: that named
// "the overview screen header, next to the repo name", and the overview screen has had no
// header since the doc became a document (see `OverviewScreen.tsx` on why the bar went). The
// bar is where the repo name still is — the active tab reads `<repo> · base → head` — and it
// is the only chrome on screen from *both* the tour doc and the diff, which is what a door out
// of the app has to be. Mounted beside `SidebarToggle` for the same reason that one is here:
// this is chrome about the window's subject, not about anything inside the rail.
//
// Trailing group, between the diff toggle and Settings, so the three widen left to right: the
// diff on screen, the repository it came from, the app. Mounted only where the shell frames a
// review at all — `TitleBar`'s own `hasSidebar`, which is the shell's single answer to "is a
// session on screen", rather than a second reading of it that could disagree for a frame. The
// `sessionId` guard below is then what makes the click well-typed, not a second presence rule.
//
// Never hidden, only disabled, and disabled by `aria-disabled` rather than `disabled` — both
// are `OpenInEditorButton`'s rules and both are load-bearing here too: a control that vanishes
// on a frozen review teaches nothing, and a truly disabled button takes no pointer events, so
// the tooltip carrying the fix would never open.
export function OpenRepoInEditorButton(): ReactElement | null {
  const editor = useSettingsStore((state) => state.resolved.editor);
  const sessionId = useReviewStore((state) => state.activeSessionId);
  const repoName = useReviewStore((state) => selectActiveSlice(state)?.repo.name ?? null);
  const frozen = useReviewStore(
    (state) => selectActiveSlice(state)?.reviewDiff?.kind === "frozenPatch",
  );
  const open = useEditorStore((state) => state.open);

  if (sessionId === null) {
    return null;
  }

  const availability = repoEditorAvailability({ editor, frozen });
  const ready = availability === "ready";
  const hint = hintFor(availability, repoName, editor === "none" ? null : editorMeta(editor).label);

  return (
    <TooltipHint side="bottom" align="end" content={hint}>
      <Button
        variant="chrome"
        size="icon"
        className="app-region-no-drag"
        aria-label={hint}
        aria-disabled={!ready}
        onClick={() => {
          if (ready) {
            void open({ kind: "repo", sessionId });
          }
        }}
      >
        {/* A folder, where the file-level control is an `ExternalLink`. The glyph on a file's
            header band gets its subject from the row it sits on and only has to say the action;
            up here there is no row, so the glyph has to say the subject and the label says the
            action — which is the disagreement 023 took off the comment toolbar, read the other
            way round. */}
        <FolderOpen />
      </Button>
    </TooltipHint>
  );
}

/** The hint doubles as the label, as on the file control: the verb, the repository and the
 * editor while it can act; the reason and the fix while it cannot. The two refusals are worded
 * about the repository rather than about files, because that is what this button opens — the
 * file control's own sentences stay as they are. A value-returning switch with no default. */
function hintFor(
  availability: ReturnType<typeof repoEditorAvailability>,
  repoName: string | null,
  editorLabel: string | null,
): string {
  switch (availability) {
    case "ready":
      return `Open ${repoName ?? "the repository"} in ${editorLabel ?? "editor"}`;
    case "frozen":
      return "Locate the repository first to open it in an editor";
    case "noEditor":
      return "Choose an editor in Settings to open the repository";
  }
}
