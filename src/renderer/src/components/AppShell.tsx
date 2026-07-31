import type { ReactElement, ReactNode } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { TitleBar } from "@/components/TitleBar";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

type AppShellProps = {
  /** App-level notices that belong to the shell, not a session pane. */
  banner: ReactNode;
  /** The rail, or null when there is no review for it to index — the shell then gives the
   * whole width to the content well rather than framing it with an empty column. */
  sidebar: ReactNode | null;
  children: ReactNode;
};

// The frame every feature renders into: title bar on top, a resizable sidebar rail,
// content well. The rail width is dragged at the seam and remembered across reloads
// (useDefaultLayout → localStorage), keyed per panel id.
export function AppShell({ banner, sidebar, children }: AppShellProps): ReactElement {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "reviewer.shell",
    storage: localStorage,
  });

  // No rail, no seam, no panel group: the start screen is one full-width surface, and a
  // group with a single panel would still park a drag handle against the window edge.
  if (sidebar === null) {
    return (
      <div className="flex h-dvh flex-col">
        <TitleBar />
        {banner}
        {/* id read by TabBar's `aria-controls` — every tab controls this one region,
            since the "panel" a tab switches is the whole app surface, not a per-tab pane. */}
        <main id="app-content" className="min-h-0 flex-1 bg-background">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <TitleBar />
      {banner}
      <ResizablePanelGroup
        orientation="horizontal"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
        className="min-h-0 flex-1"
      >
        {/* max-md:hidden serves only the browser-run visual gates (375px viewport);
            the Electron window's minWidth (800) keeps the rail always visible. */}
        <ResizablePanel
          id="sidebar"
          defaultSize="256px"
          minSize="208px"
          maxSize="560px"
          groupResizeBehavior="preserve-pixel-size"
          className="max-md:hidden"
        >
          {sidebar}
        </ResizablePanel>
        <ResizableHandle className="max-md:hidden" />
        <ResizablePanel id="main" minSize="360px">
          {/* Same id as the sidebar-less branch above, and read the same way. */}
          <main id="app-content" className="h-full min-w-0 bg-background">
            {children}
          </main>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
