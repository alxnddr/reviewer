import type { ReactElement } from "react";
import { Columns2, Rows3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { selectActiveSlice, useReviewStore } from "@/stores/review";
import { useUiPrefsStore } from "@/stores/ui-prefs";

// The layout switch only has meaning against a diff, so it appears with one
// (loading or loaded) and is absent at every dead end — nothing to lay out.
type DiffPresence = "absent" | "loading" | "present";

function selectDiffPresence(state: ReturnType<typeof useReviewStore.getState>): DiffPresence {
  const phase = selectActiveSlice(state)?.diff?.phase ?? null;
  if (phase === "loading") {
    return "loading";
  }
  return phase === "loaded" ? "present" : "absent";
}

/** Split ⇄ unified as one title-bar control, sitting left of the theme menu. The
 * icon names the current layout; the label names the switch the click performs. */
export function DiffStyleToggle(): ReactElement | null {
  const presence = useReviewStore(selectDiffPresence);
  // App-wide, not per-session: the layout the reader picked follows them across tabs and
  // relaunches (stores/ui-prefs).
  const diffStyle = useUiPrefsStore((state) => state.diffStyle);
  const setDiffStyle = useUiPrefsStore((state) => state.setDiffStyle);

  if (presence === "absent") {
    return null;
  }

  const split = diffStyle === "split";
  const Icon = split ? Columns2 : Rows3;

  return (
    // The icon names the current layout, which leaves the click itself unlabelled — the one
    // thing about this control a glyph genuinely cannot say. The hint says it.
    <TooltipHint
      side="bottom"
      align="end"
      content={split ? "Switch to unified view" : "Switch to split view"}
    >
      <Button
        variant="chrome"
        size="icon"
        className="app-region-no-drag"
        disabled={presence === "loading"}
        aria-label={`Switch to ${split ? "unified" : "split"} view`}
        onClick={() => setDiffStyle(split ? "unified" : "split")}
      >
        <Icon />
      </Button>
    </TooltipHint>
  );
}
