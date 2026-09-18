import type { ReactElement } from "react";
import { TabBar } from "@/components/TabBar";
import { DiffStyleToggle } from "@/components/DiffStyleToggle";
import { SettingsButton } from "@/components/SettingsButton";
import { SidebarToggle } from "@/components/SidebarToggle";
import { useReviewStore } from "@/stores/review";

type TitleBarProps = {
  /** Whether the shell is framing a rail at all. Handed down rather than re-derived here: the
   * shell is the one place that decides, and a second reading of "is there a review" could
   * disagree with it for a frame and leave a toggle over nothing. */
  hasSidebar: boolean;
};

// pl-24 clears the macOS traffic lights (hiddenInset, tuned in src/main/window.ts)
// with a gap so the tab strip doesn't crowd them; h-10 (40px) keeps the top
// chrome compact around the OS-fixed light cluster.
export function TitleBar({ hasSidebar }: TitleBarProps): ReactElement {
  // Any tab at all, not any *session*: a start tab is a tab, and a strip holding one is the
  // strip. With nothing open the app names itself instead, which is what the window says
  // before it is about anything.
  const hasTabs = useReviewStore((state) => state.tabs.length > 0);

  return (
    <header className="app-region-drag flex h-10 shrink-0 items-center gap-3 border-b border-border bg-sidebar pr-3 pl-24">
      {/* Absent on the start screen, where the shell renders no panel group: the same rule
          DiffStyleToggle follows — a control appears with the thing it acts on and is absent
          at every dead end. */}
      {hasSidebar && <SidebarToggle />}
      {hasTabs ? <TabBar /> : <h1 className="text-sm">Reviewer</h1>}
      {/* Draggable filler: the window must keep dragging right of the tab strip. */}
      <div className="min-w-6 flex-1" />
      {/* The header's gap-3 is sized for the tab strip; the trailing icon buttons
          already carry their own padding, so they group tighter than that. */}
      <div className="flex items-center gap-0.5">
        <DiffStyleToggle />
        <SettingsButton />
      </div>
    </header>
  );
}
