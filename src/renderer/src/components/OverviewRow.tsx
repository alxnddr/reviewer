import type { ReactElement } from "react";
import { Compass, Undo2 } from "lucide-react";
import { RAIL_GLYPH, RailSection } from "@/components/rail";
import { ShortcutHint } from "@/components/ui/kbd";

// The tour doc's own row in the rail, above the layers.
//
// It used to be the first `treeitem` inside the layer tree, which put it one indent level
// deep in a widget whose every other row solos a layer — and it is not a layer. It carries
// no files, no ordinal, no read tally, nothing can be soloed to it, and selecting it goes
// through `openOverview` rather than `setActiveLayer`. The tree had to special-case it at
// every turn: its own id namespace, a branch in `select`, a row with half its fields nulled
// out, and a click handler that skipped the click-again-to-clear rule the real rows follow.
//
// Out here it is what it always was — a sibling of the Layers section, not a member of it —
// and the tree below it is uniformly layers. It is a `RailSection` like the bars above and
// below it, because that is the level it sits at: the rail reads Diff / Overview / Layers /
// Comments / files, top to bottom.
//
// A review need not have one. Absent, the rail simply starts at Layers.
//
// It carries its own bottom border, unconditionally — unlike the two sections below it,
// whose borders come and go with their disclosure (open, they fill a resize panel and the
// seam handle draws the line instead). This row is never a panel and never opens, so there
// is no state in which something else would draw it: without the border the row runs
// straight into the Layers bar and the two read as one two-line block.
//
// ── The ↩ ────────────────────────────────────────────────────────────────────────────────
// The row always opens the overview; what differs is *where* the document opens, and the row
// tells the truth about it. While the reader is on a trip (`docTrip` in `stores/review/
// slice.ts`: the document closed and they have not navigated by their own hand since) it will
// reopen on the exact paragraph they left, so the row carries a trailing ↩ and its hint says
// "Back to where you were". On their first navigation — a file step, a layer, a comment — the
// mark goes, at once and unanimated, and the row is the plain door to the hub again.
//
// This is the whole visible surface of the return, deliberately. The reader asked for a way
// back that is there after an accidental click or a glance and is *not* there once they have
// moved on; a back button on the diff is on offer for ever, a history stack records ordinary
// movement, and a peek taxes the common case of clicking a file to go and review it. A mark
// on the row that already goes back needs no new control, no new key (`o` is unchanged and
// the hint takes it from `lib/shortcuts.ts`) and nothing drawn on the diff. With the sidebar
// hidden there is no mark and `o` behaves identically.

type OverviewRowProps = {
  /** Whether the doc is the reader's current stop — the store clears the soloed layer when
   * it opens, so this and a selected layer row are mutually exclusive by construction. */
  selected: boolean;
  /** Whether opening the doc now returns the reader to the place they left it — a live trip.
   * A prop, not a store read: rows take props, and `ReviewRail` is the section that knows. */
  returning: boolean;
  onOpen: () => void;
};

export function OverviewRow({ selected, returning, onOpen }: OverviewRowProps): ReactElement {
  return (
    <RailSection
      // The doc discloses nothing — there is one of it and it is either your stop or it
      // isn't — so it passes null and `RailSection` holds the twisty's slot empty. A row
      // that skipped the slot would hang its glyph and its label a step left of every
      // other section in the rail.
      expanded={null}
      selected={selected}
      bordered={true}
      onSelect={onOpen}
      aria-current={selected ? "page" : undefined}
      // The same glyph the chapter band uses for the door back here, so the stop and the
      // way to it are recognisably one thing.
      icon={<Compass aria-hidden="true" className={RAIL_GLYPH} />}
      tooltip={
        <ShortcutHint
          id="overview.toggle"
          {...(returning ? { label: "Back to where you were" } : {})}
        />
      }
    >
      <span className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate">Overview</span>
        {returning && (
          <>
            <Undo2 data-doc-returning aria-hidden="true" className={RAIL_GLYPH} />
            <span className="sr-only">, back to where you were</span>
          </>
        )}
      </span>
    </RailSection>
  );
}
