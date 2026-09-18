import type { ReactElement } from "react";
import { PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ShortcutHint } from "@/components/ui/kbd";
import { TooltipHint } from "@/components/ui/tooltip";
import { useUiPrefsStore } from "@/stores/ui-prefs";

/** The rail, put away and brought back. It sits left of the tab strip — the first thing after
 * the padding that clears the traffic lights — because it is chrome about the window, not about
 * the review: everything that acts on what is *in* the rail lives in the rail.
 *
 * One glyph in both states rather than swapping to `PanelLeftClose`: the control must not change
 * shape under a cursor that is about to press it a second time. What changes is `aria-pressed`,
 * and because that is where the state is, the accessible name is the noun — a screen reader
 * reads "Sidebar, toggle button, pressed", which says the state once. (DiffStyleToggle names the
 * verb instead, for the opposite reason: it has three states' worth of nothing to press against,
 * so the label is the only place its action can be said.) The tooltip carries the direction of
 * the next press and the chord, off the registry, so it and the sheet cannot name two keys. */
export function SidebarToggle(): ReactElement {
  const railCollapsed = useUiPrefsStore((state) => state.railCollapsed);
  const toggleRail = useUiPrefsStore((state) => state.toggleRail);

  return (
    <TooltipHint
      side="bottom"
      align="start"
      content={
        <ShortcutHint id="sidebar.toggle" label={railCollapsed ? "Show sidebar" : "Hide sidebar"} />
      }
    >
      <Button
        variant="chrome"
        size="icon"
        className="app-region-no-drag"
        aria-label="Sidebar"
        aria-pressed={!railCollapsed}
        onClick={toggleRail}
      >
        <PanelLeft />
      </Button>
    </TooltipHint>
  );
}
