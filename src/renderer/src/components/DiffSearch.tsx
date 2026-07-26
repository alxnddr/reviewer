import { useEffect, useRef, type ReactElement } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";

type DiffSearchProps = {
  query: string;
  caseSensitive: boolean;
  matchCount: number;
  /** 1-based position of the active match, or 0 when there are none. */
  activePosition: number;
  /** Changes on every ⌘F so the field re-focuses and selects even while open. */
  focusNonce: number;
  onQueryChange: (query: string) => void;
  onToggleCase: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
};

/** The find-in-diff bar: a floating overlay above the virtualized surface (the one
 * place a query can reach off-screen lines — the browser's native find cannot).
 * Presentational and self-contained: it holds the input focus and its own key
 * gestures (Enter/⇧Enter to step, Esc to close), and reports every other action up
 * to `useDiffSearch`, which owns the matching and the scroll/highlight. */
export function DiffSearch({
  query,
  caseSensitive,
  matchCount,
  activePosition,
  focusNonce,
  onQueryChange,
  onToggleCase,
  onNext,
  onPrevious,
  onClose,
}: DiffSearchProps): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus and select on open and on every re-trigger (focusNonce), so a second ⌘F
  // while the bar is already up re-selects the query for an immediate overtype.
  useEffect(() => {
    const input = inputRef.current;
    if (input !== null) {
      input.focus();
      input.select();
    }
  }, [focusNonce]);

  const hasQuery = query.length > 0;
  const noMatches = matchCount === 0;

  return (
    <div
      role="search"
      // The kit's floating-surface idiom (select/dropdown/combobox all use it): a
      // hairline `ring-foreground/10` rather than `border-border`, which on the dark
      // themes is a near-invisible grey and left the bar with no edge against the
      // diff. Kept a rounded rect, not the stepper's pill — this one holds a field,
      // and the two overlays should stay tellable apart at a glance.
      className="absolute top-2 right-3 z-20 flex items-center gap-1 rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
    >
      <div className="relative">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-text-muted"
        />
        <Input
          ref={inputRef}
          type="text"
          aria-label="Find in diff"
          placeholder="Find in diff"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (event.shiftKey) {
                onPrevious();
              } else {
                onNext();
              }
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
          className="h-7 w-52 pl-7"
        />
      </div>
      {/* Tabular figures keep the count from reflowing as it ticks through matches. */}
      <span className="min-w-14 px-1 text-center text-xs text-text-muted tabular-nums">
        {hasQuery ? (noMatches ? "No results" : `${activePosition}/${matchCount}`) : ""}
      </span>
      <Toggle
        size="sm"
        aria-label="Match case"
        pressed={caseSensitive}
        onPressedChange={onToggleCase}
        className="size-7 min-w-7 p-0"
      >
        <CaseSensitive />
      </Toggle>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Previous match"
        disabled={noMatches}
        onClick={onPrevious}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Next match"
        disabled={noMatches}
        onClick={onNext}
      >
        <ChevronDown />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Close find" onClick={onClose}>
        <X />
      </Button>
    </div>
  );
}
