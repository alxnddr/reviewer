import type { ReactElement } from "react";
import type { ChapterBadge as Badge } from "@/lib/guide";
import { cn } from "@/lib/utils";

// The small boxed chapter number a visual element, a changed symbol or a map tile wears — `02`,
// `04.2` — derived from the layer that owns the element's anchor (`createBadgeLookup`), never
// authored. Neutral ink in a hairline box, the way Capy's guide sets it: the badge is a cross-
// reference, and colour on the page is spent on change (green, red) and nothing else.

export function ChapterBadge({
  badge,
  className,
}: {
  badge: Badge;
  className?: string;
}): ReactElement {
  return (
    <span
      aria-label={`chapter ${badge.ordinal}`}
      className={cn(
        "inline-flex h-4 shrink-0 items-center rounded-[4px] border border-border-strong/70 px-1 font-mono text-[11px] leading-none tabular-nums text-text-muted",
        className,
      )}
    >
      {badge.text}
    </span>
  );
}
