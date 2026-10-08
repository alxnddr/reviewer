import { useState, type ReactElement } from "react";
import { countLabel } from "../../../../shared/plural";
import type { AnchorSpan } from "../../../../shared/review";
import type { ModuleMapDir } from "@/lib/module-map";
import type { ChapterBadge, ShapeGroup } from "@/lib/guide";
import type { DepsGraph as DepsGraphModel } from "@/lib/deps-graph";
import { cn } from "@/lib/utils";
import { ModuleMap } from "@/components/guide/ModuleMap";
import { ShapeList } from "@/components/guide/ShapeList";
import { DepsGraph } from "@/components/guide/DepsGraph";
import type { AnchorDoor } from "@/components/guide/anchor-door";

// The card under the chapter strip: computed views of the whole change behind one segmented
// switch — **Map** (where the change is, by file and chapter) and **Shape** (what it declares,
// by symbol). Two tabs rather than two cards because they answer one question from two sides,
// and stacked they would push the chapters a screen further down a page whose point is to get
// the reader to the chapters. The choice is the reader's, per mount; nothing persists it, since
// the guide is read a handful of times per review and Map is the right first answer each time.
//
// A third tab, **Deps**, is the same question asked of the wiring: which modules now import
// which (`lib/deps-graph.ts`, `components/guide/DepsGraph.tsx`). It is offered only when the
// change touched an import statement, and absent otherwise rather than present and empty. The
// graph is read from lines, for the languages `shared/diff/imports.ts` knows: a tab that said "No
// dependency changes" on a C++ change, or on one whose rewiring hides in a `tsconfig`, would claim
// something it cannot know, where a missing tab claims nothing. The switch also stays two choices
// for the many changes that never touch an import. If the diff reloads without the edges while
// Deps is showing, the card falls back to Map rather than to an empty panel.
//
// Shape and Deps read lines, and a file past the read budget (`tooLargeToRead` in
// `shared/diff/outline.ts` — a generated or crafted file of tens of thousands of rows) is not
// read at all, to keep the window responsive. Both tabs then say which files they left out
// (`UnreadNote`), because an empty Shape would otherwise claim those files declare nothing. The
// Map tab needs no note: it sizes files by their counts, which it has for every file.

type View = "map" | "shape" | "deps";

const VIEWS: { id: View; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "shape", label: "Shape" },
  { id: "deps", label: "Deps" },
];

function caption(view: View, symbolCount: number, deps: DepsGraphModel): string {
  switch (view) {
    case "map":
      return "Files sized by changed lines, tinted by chapter";
    case "shape":
      return countLabel(symbolCount, "changed declaration");
    case "deps":
      return `${countLabel(deps.statements, "import")} added or removed, by module`;
  }
}

/** How many unread paths the note names before it counts the rest. */
const UNREAD_NAMED = 3;

/** The files Shape and Deps did not read, named — each a door into the diff. */
function UnreadNote({
  paths,
  onOpenFile,
}: {
  paths: readonly string[];
  onOpenFile: (path: string) => void;
}): ReactElement {
  const named = paths.slice(0, UNREAD_NAMED);
  const rest = paths.length - named.length;
  return (
    <p className="mt-3 text-xs text-text-faint">
      {`${countLabel(paths.length, "file")} too large to outline or read for imports: `}
      {named.map((path, index) => (
        <span key={path}>
          {index > 0 && ", "}
          <button
            type="button"
            onClick={() => onOpenFile(path)}
            className="font-mono text-text-muted underline-offset-2 hover:text-foreground hover:underline"
          >
            {path}
          </button>
        </span>
      ))}
      {rest > 0 && ` and ${rest} more`}
    </p>
  );
}

type MapCardProps = {
  root: ModuleMapDir;
  groups: readonly ShapeGroup[];
  slots: ReadonlyMap<string, number>;
  deps: DepsGraphModel;
  /** Code files left unread for size (`tooLargeToRead`), in diff order. */
  unread: readonly string[];
  badgeOf: (anchor: AnchorSpan | undefined) => ChapterBadge | null;
  door: AnchorDoor;
  onOpenFile: (path: string) => void;
};

export function MapCard({
  root,
  groups,
  slots,
  deps,
  unread,
  badgeOf,
  door,
  onOpenFile,
}: MapCardProps): ReactElement {
  const [chosen, setView] = useState<View>("map");
  const hasDeps = deps.edges.length > 0;
  const view = chosen === "deps" && !hasDeps ? "map" : chosen;
  const views = hasDeps ? VIEWS : VIEWS.filter((entry) => entry.id !== "deps");
  const symbolCount = groups.reduce(
    (sum, group) => sum + group.files.reduce((inner, file) => inner + file.symbols.length, 0),
    0,
  );
  return (
    <div className="rounded-xl border border-border bg-diff-surface shadow-xs">
      <div className="flex items-center gap-3 px-4 pt-3 pb-2">
        <div
          role="tablist"
          aria-label="Map, shape or dependencies of the change"
          className="flex rounded-lg bg-border/50 p-0.5"
        >
          {views.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={view === entry.id}
              onClick={() => setView(entry.id)}
              className={cn(
                "rounded-md px-3 py-0.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                view === entry.id
                  ? "bg-diff-surface text-foreground shadow-xs"
                  : "text-text-muted hover:text-foreground",
              )}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-text-faint">{caption(view, symbolCount, deps)}</span>
      </div>
      <div role="tabpanel" className="px-4 pb-4">
        {view === "map" && <ModuleMap root={root} slots={slots} onOpenFile={onOpenFile} />}
        {view === "shape" && <ShapeList groups={groups} door={door} />}
        {view === "deps" && <DepsGraph graph={deps} badgeOf={badgeOf} door={door} />}
        {view !== "map" && unread.length > 0 && (
          <UnreadNote paths={unread} onOpenFile={onOpenFile} />
        )}
      </div>
    </div>
  );
}
