import type { ReactElement } from "react";
import { TabBar } from "@/components/TabBar";
import { DiffStyleToggle } from "@/components/DiffStyleToggle";
import { ThemeMenu } from "@/components/ThemeMenu";
import { useReviewStore } from "@/stores/review";

// pl-24 clears the macOS traffic lights (hiddenInset, tuned in src/main/window.ts)
// with a gap so the tab strip doesn't crowd them; h-10 (40px) keeps the top
// chrome compact around the OS-fixed light cluster.
export function TitleBar(): ReactElement {
  // Any tab at all, not any *session*: a start tab is a tab, and a strip holding one is the
  // strip. With nothing open the app names itself instead, which is what the window says
  // before it is about anything.
  const hasTabs = useReviewStore((state) => state.tabs.length > 0);

  return (
    <header className="app-region-drag flex h-10 shrink-0 items-center gap-3 border-b border-border bg-sidebar pr-3 pl-24">
      {hasTabs ? <TabBar /> : <h1 className="text-sm">Reviewer</h1>}
      {/* Draggable filler: the window must keep dragging right of the tab strip. */}
      <div className="min-w-6 flex-1" />
      {/* The header's gap-3 is sized for the tab strip; the trailing icon buttons
          already carry their own padding, so they group tighter than that. */}
      <div className="flex items-center gap-0.5">
        <DiffStyleToggle />
        <ThemeMenu />
      </div>
    </header>
  );
}
