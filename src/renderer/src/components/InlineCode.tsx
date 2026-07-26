import { type ReactElement, type ReactNode } from "react";

/** An inert inline `code` span, the one way a backticked token renders wherever prose
 * names code: mono per the per-element type rule, on a faint tint with a tight radius
 * that marks the span's extent without the border a clickable chip carries — borders
 * here mean "this navigates". Mono at 0.9em because Geist Mono runs wide next to Geist
 * at the same nominal size. */
export function InlineCode({ children }: { children: ReactNode }): ReactElement {
  return (
    <code className="rounded-[4px] bg-foreground/8 px-1 py-0.5 font-mono text-[0.9em]">
      {children}
    </code>
  );
}
