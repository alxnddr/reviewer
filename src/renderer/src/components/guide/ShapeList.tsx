import type { ReactElement } from "react";
import { countLabel } from "../../../../shared/plural";
import { symbolMarker, type GuideSymbol, type ShapeGroup } from "@/lib/guide";
import { cn } from "@/lib/utils";
import { FileTypeIcon } from "@/components/FileTypeIcon";
import { ChapterBadge } from "@/components/guide/ChapterBadge";
import {
  AnchorTarget,
  VISUAL_CODE_FACE,
  elementHint,
  type AnchorDoor,
} from "@/components/guide/anchor-door";

// The Shape tab: the outline diff (`shared/diff/outline.ts`) — the symbols the change added,
// removed or modified, as signatures without bodies, grouped by directory and file. It is the
// change's call stack read from the diff itself rather than from anything the author wrote, so
// it is there for a plain review with no visuals at all, and it is the check on the ones with:
// a picture that claims three new functions sits one tab away from the list of what is new.
//
// A modified symbol whose signature changed shows both — the new one, and the old one struck
// under it — because "takes a second argument now" is the most review-relevant fact a line of
// outline can carry. Each row is a door to the symbol's line, badged with the chapter that owns
// it; a symbol named from a hunk's context rather than its own changed line says so in its hint
// (`source`), since that is an inference.

function SymbolRow({ symbol, door }: { symbol: GuideSymbol; door: AnchorDoor }): ReactElement {
  const marker = symbolMarker(symbol.status);
  const note =
    symbol.source === "hunk-context" ? "body edit — named from the hunk's context" : undefined;
  return (
    <AnchorTarget
      door={door}
      anchor={symbol.anchor}
      hint={elementHint(note, symbol.anchor, symbol.badge)}
      label={`${marker} ${symbol.signature}, open its code`}
      className={cn(
        "flex w-full items-start gap-2 rounded px-1.5 py-0.5 text-xs leading-5 hover:bg-border/40",
        VISUAL_CODE_FACE,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "w-3 shrink-0 text-center",
          symbol.status === "added" && "text-diff-add-fg",
          symbol.status === "removed" && "text-diff-del-fg",
          symbol.status === "modified" && "text-warning",
        )}
      >
        {marker}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate text-foreground",
            symbol.status === "removed" &&
              "text-foreground/70 line-through decoration-diff-del-fg/50",
          )}
        >
          {symbol.signature}
        </span>
        {symbol.previousSignature !== null && (
          <span className="truncate text-text-faint line-through decoration-text-faint/60">
            {symbol.previousSignature}
          </span>
        )}
      </span>
      {symbol.badge !== null && <ChapterBadge badge={symbol.badge} className="mt-0.5" />}
    </AnchorTarget>
  );
}

export function ShapeList({
  groups,
  door,
}: {
  groups: readonly ShapeGroup[];
  door: AnchorDoor;
}): ReactElement {
  if (groups.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-text-muted">
        No declarations changed in a language the outline reads.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <section key={group.dir} className="flex flex-col gap-1.5">
          <h4 className="font-mono text-[11px] text-text-faint">
            {group.dir === "" ? "./" : `${group.dir}/`}
          </h4>
          {group.files.map((file) => (
            <div key={file.path} className="flex flex-col">
              <div className="flex items-center gap-1.5 px-1.5 pb-0.5 text-sm text-foreground">
                <FileTypeIcon path={file.path} className="size-3.5" />
                {file.name}
              </div>
              <div className="flex flex-col pl-3">
                {file.symbols.map((symbol, index) => (
                  <SymbolRow key={`${symbol.name}:${index}`} symbol={symbol} door={door} />
                ))}
                {file.omitted > 0 && (
                  <span className="px-1.5 text-xs text-text-faint">
                    {countLabel(file.omitted, "more symbol")}
                  </span>
                )}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
