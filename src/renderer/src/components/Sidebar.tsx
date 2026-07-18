import type { ReactElement, ReactNode } from "react";

type SidebarProps = {
  /** The modal diff-selector / changed-file tree once a session is active; the
   * rail stays quiet (an empty column) without one. */
  children?: ReactNode;
};

// Chrome only: the rail fills the resizable panel that owns its width (AppShell).
export function Sidebar({ children }: SidebarProps): ReactElement {
  return (
    <aside className="flex h-full min-w-0 flex-col border-r border-border bg-sidebar">
      {children ?? <div className="flex-1" />}
    </aside>
  );
}
