import type { ReactElement, ReactNode } from "react";

type SidebarProps = {
  /** The rail's sections once a session is active — the diff bar and, under it, the
   * picker or the review's own stops; the rail stays quiet (an empty column) without
   * a session. */
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
