import { useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { useDefaultLayout, type PanelImperativeHandle } from "react-resizable-panels";
import { TitleBar } from "@/components/TitleBar";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { useUiPrefsStore } from "@/stores/ui-prefs";

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
//
// The rail is also put away and brought back, from the title bar's SidebarToggle and from ⌘B.
// Three things had to agree for that to cost the reader the width they dragged to:
//
//   - **The library collapses it, not React.** `collapsible` + `collapsedSize={0}` and the
//     panel's imperative handle, rather than unmounting the panel: `useDefaultLayout` keys a
//     stored layout by the group's *set* of panel ids, so a rail that comes and goes would hand
//     that hook two layouts to reconcile instead of the one it stored a width for.
//   - **A collapse must not be mistaken for a new width.** `onlySaveAfterUserInteractions` is
//     what buys that: the layout is persisted when the reader drags the seam and not when this
//     effect drives the panel, so while the rail is away the stored layout is still the width
//     they left it at — through a quit, not just through the click.
//   - **Coming back is a `resize` to that stored width, never the handle's own `expand()`.**
//     `expand()` restores the size `collapse()` captured, and that capture is a field on an
//     in-memory panel registration: it is right within a session and simply absent after a
//     relaunch, where it falls through to `minSize` and hands back a 208px rail the reader
//     never asked for. It was observed doing exactly that. The stored layout is the durable
//     copy of the same number, so the panel is told what to be rather than asked to remember.
//
// `collapsible` also means dragging the seam past `minSize` closes the rail, which the seam
// could not do before. Two consequences, both handled: the panel's `onResize` keeps the toggle
// honest (the panel is the one authority on whether the rail is open, and `aria-pressed` reads
// the store), and a drag-collapse *is* a user interaction, so it does persist a zero — which is
// why a stored zero is read as "no remembered width" rather than restored as one.
/** The rail's width before the reader has dragged one, and the width it comes back to when a
 * collapse outlives the layout that remembered one. Named once so the two cannot disagree. */
const RAIL_DEFAULT_SIZE = "256px";

export function AppShell({ banner, sidebar, children }: AppShellProps): ReactElement {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "reviewer.shell",
    storage: localStorage,
    onlySaveAfterUserInteractions: true,
  });
  const railCollapsed = useUiPrefsStore((state) => state.railCollapsed);
  const setRailCollapsed = useUiPrefsStore((state) => state.setRailCollapsed);
  const railRef = useRef<PanelImperativeHandle | null>(null);
  const hasSidebar = sidebar !== null;

  // Drives the panel from the preference, including on the frame the rail first mounts — hence
  // `hasSidebar` in the deps and not just the flag: entering a review with the rail already put
  // away must not open it. `defaultLayout` is in there because the restore reads it, and it is
  // memoized on the stored string, so a drag re-runs this and finds nothing to do: the reopen
  // is behind `isCollapsed()`, which is also what keeps this from fighting the drag it is
  // watching, and `collapse()` no-ops on an already-collapsed panel.
  useEffect(() => {
    const rail = railRef.current;
    if (rail === null) {
      return;
    }
    if (railCollapsed) {
      rail.collapse();
    } else if (rail.isCollapsed()) {
      // A stored zero is a rail the reader dragged shut, not a width: restoring it would leave
      // the panel collapsed with the toggle claiming otherwise. Percent, spelled, because a
      // bare number means pixels to `resize` and the layout is a percentage.
      const stored = defaultLayout?.["sidebar"];
      rail.resize(stored !== undefined && stored > 0 ? `${stored}%` : RAIL_DEFAULT_SIZE);
    }
  }, [railCollapsed, hasSidebar, defaultLayout]);

  // No rail, no seam, no panel group: the start screen is one full-width surface, and a
  // group with a single panel would still park a drag handle against the window edge.
  if (!hasSidebar) {
    return (
      <div className="flex h-dvh flex-col">
        <TitleBar hasSidebar={false} />
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
      <TitleBar hasSidebar />
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
          defaultSize={RAIL_DEFAULT_SIZE}
          minSize="208px"
          maxSize="560px"
          collapsible
          collapsedSize={0}
          panelRef={railRef}
          groupResizeBehavior="preserve-pixel-size"
          className="max-md:hidden"
          onResize={(size, _id, previous) => {
            // `previous` is undefined on the panel's first measure, where a not-yet-laid-out
            // zero would otherwise read as "the reader closed it" and put the rail away on
            // every launch. After that, the panel is telling us what it is.
            if (previous !== undefined) {
              setRailCollapsed(size.asPercentage === 0);
            }
          }}
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
