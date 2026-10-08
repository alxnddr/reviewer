import type { ReactElement } from "react";
import { symbolMarker, type GuideSymbol } from "@/lib/guide";
import { cn } from "@/lib/utils";
import {
  AnchorTarget,
  VISUAL_CODE_FACE,
  elementHint,
  type AnchorDoor,
} from "@/components/guide/anchor-door";

// A chapter's changed symbols as a row of small chips — `+ shout`, `~ greet`, `− blobCache` —
// read off the outline diff and filtered to the chapter's extent (`chapterSymbols`). The name
// only, in mono; the full signature (and the one it replaced) is the hint, and the chip is a
// door to the symbol's line. Capped, because a chapter that rewrote a module would otherwise
// print its whole table of contents in a row meant to be glanced at.

const SHOWN = 8;

export function SymbolChips({
  symbols,
  door,
  className,
}: {
  symbols: readonly GuideSymbol[];
  door: AnchorDoor;
  className?: string;
}): ReactElement | null {
  if (symbols.length === 0) {
    return null;
  }
  const shown = symbols.slice(0, SHOWN);
  const rest = symbols.length - shown.length;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {shown.map((symbol, index) => {
        const marker = symbolMarker(symbol.status);
        const signature =
          symbol.previousSignature === null
            ? symbol.signature
            : `${symbol.previousSignature}\n→ ${symbol.signature}`;
        return (
          <AnchorTarget
            key={`${symbol.path}:${symbol.name}:${index}`}
            door={door}
            anchor={symbol.anchor}
            hint={elementHint(signature, symbol.anchor, null)}
            label={`${marker} ${symbol.name}, open its code`}
            className={cn(
              "flex h-6 items-center gap-1 rounded-md border border-border bg-diff-surface px-1.5 text-xs text-foreground hover:bg-border/40",
              VISUAL_CODE_FACE,
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                symbol.status === "added" && "text-diff-add-fg",
                symbol.status === "removed" && "text-diff-del-fg",
                symbol.status === "modified" && "text-warning",
              )}
            >
              {marker}
            </span>
            <span
              className={cn(
                symbol.status === "removed" && "line-through decoration-diff-del-fg/50",
              )}
            >
              {symbol.name}
            </span>
          </AnchorTarget>
        );
      })}
      {rest > 0 && <span className="text-xs text-text-faint">+{rest} more</span>}
    </div>
  );
}
