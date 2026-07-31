import { useState, type ReactElement } from "react";
import { ReviewRail } from "@/components/ReviewRail";
import { SelectionPanel, SelectionRow } from "@/components/SelectionPanel";
import { selectActiveSlice, useReviewStore } from "@/stores/review";

// The rail, top to bottom: the diff it is about, then the review's stops, then the
// files — widest scope first, one section bar each (see rail.tsx, which owns every bar
// and row the four widgets below are built from).
//
// The diff section is modal where the others are not: opened, its picker takes the
// rail, because everything below it is *about* the diff being picked and a picker
// squeezed into a third of a 256px column can show three commits. What it no longer
// does is take the bar with it — the bar stays, names the loaded diff throughout, and
// its twisty is the way back. Keyed per session in App, so the picker starts closed
// each time a session is entered (its diff is already loaded).
//
// What is left in this file is that switch and the disclosure state it switches around:
// the loaded rail itself is `ReviewRail`, which also documents where the sections below
// it get their state from.

export function SidebarNav(): ReactElement {
  const diff = useReviewStore((state) => selectActiveSlice(state)?.diff ?? null);
  // Disclosure of the diff picker. Closed by default: a session arrives with its diff
  // already chosen, so the rail opens on what is in it.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Disclosure of the comment overview: collapsed it's a one-line count bar; expanded
  // it becomes a resizable panel above the layers/tree stack. Per-session (SidebarNav
  // is keyed by the active session), so it resets like the picker on a tab switch —
  // and held here rather than in the rail, so a trip through the picker leaves it be.
  const [commentsExpanded, setCommentsExpanded] = useState(false);
  // The same disclosure for the layers list, and the same per-session reset — but open
  // by default: an artifact's layers *are* the reading order it was written in, so the
  // walkthrough is what the rail should offer first, with the tree underneath.
  const [layersExpanded, setLayersExpanded] = useState(true);

  // A tree only exists for a loaded diff; every other phase (idle, loading,
  // empty, failed) forces the picker open and holds it there — there is nothing to
  // browse, and the picker is where the reviewer recovers by choosing another diff.
  const treeReady = diff !== null && diff.phase === "loaded";
  const showTree = treeReady && !pickerOpen;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      // Escape leaves the picker, from anywhere inside it — the gesture every transient
      // surface in the app answers to. Not while a field has focus: a combobox eats its
      // own Escape to close its popup, and the filter field's Escape clears the filter,
      // so a key that also closed the panel out from under either would be the second
      // thing it did. Scoped to the rail rather than the window: the diff pane has its
      // own Escape (leaving the comment walk), and a key can only mean one thing at a
      // time in the region the reader is actually in.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !pickerOpen || !treeReady) {
          return;
        }
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
        ) {
          return;
        }
        event.preventDefault();
        setPickerOpen(false);
      }}
    >
      <SelectionRow
        expanded={!showTree}
        onToggle={() => setPickerOpen((open) => !open)}
        locked={!treeReady}
      />
      {showTree && diff.phase === "loaded" ? (
        <ReviewRail
          diff={diff}
          layersExpanded={layersExpanded}
          onToggleLayers={() => setLayersExpanded((value) => !value)}
          commentsExpanded={commentsExpanded}
          onToggleComments={() => setCommentsExpanded((value) => !value)}
        />
      ) : (
        <SelectionPanel />
      )}
    </div>
  );
}
