import type { ReactElement } from "react";
import { Columns2, Rows3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

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
  const diffStyle = useReviewStore((state) => state.diffStyle);
  const setDiffStyle = useReviewStore((state) => state.setDiffStyle);

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
        variant="ghost"
        size="icon"
        // Match the theme trigger: the ghost hover (bg-muted) is invisible on the
        // bg-sidebar titlebar, so the wash comes from the border tone, with dark:
        // twins to outrank the variant's own dark arm.
        className="app-region-no-drag hover:bg-border/60 dark:hover:bg-border/60"
        disabled={presence === "loading"}
        aria-label={`Switch to ${split ? "unified" : "split"} view`}
        onClick={() => setDiffStyle(split ? "unified" : "split")}
      >
        <Icon />
      </Button>
    </TooltipHint>
  );
}
