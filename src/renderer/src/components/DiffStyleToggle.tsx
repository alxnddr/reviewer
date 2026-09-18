import type { ReactElement } from "react";
import { Columns2, Rows3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipHint } from "@/components/ui/tooltip";
import {
  activeTabStop,
  selectActiveSlice,
  useReviewStore,
  type ReviewState,
  type SessionsView,
} from "@/stores/review";
import { useUiPrefsStore } from "@/stores/ui-prefs";

// The layout switch only has meaning against a diff, so it appears with one
// (loading or loaded) and is absent at every dead end — nothing to lay out.
type DiffPresence = "absent" | "loading" | "present";

/** What the question is asked of: the strip's focus *and* the sessions behind it, because
 * both halves are needed — see below for why neither alone answers it. */
export type DiffPresenceView = SessionsView & Pick<ReviewState, "activeStartTabId">;

/** Whether the reader is looking at a diff, asked of the active **tab** rather than of the
 * active slice.
 *
 * The distinction is the whole of this function. A focused start tab is drawn *over* the
 * session it was opened from rather than instead of it (`activeTabStop`, `tab-strip.ts`), so
 * `activeSessionId` still names that session and its slice still holds a loaded diff. Reading
 * the slice alone therefore offered the split ⇄ unified switch on the start screen — a
 * control over a diff that is not on screen, contradicting both the rule above and the one
 * `TitleBar.tsx` states beside it. Reading the tab alone is no better: a start tab is not the
 * only dead end, and a session tab whose diff has not been asked for yet has nothing to lay
 * out either. So: the tab decides whether a diff is on screen at all, the slice decides which
 * of the two live answers it is.
 *
 * `loading` is kept distinct from `present` so the control does not flicker in mid-load — it
 * appears disabled with the first load and settles, rather than arriving when the diff does. */
export function selectDiffPresence(state: DiffPresenceView): DiffPresence {
  if (activeTabStop(state)?.kind !== "session") {
    return "absent";
  }
  const phase = selectActiveSlice(state)?.diff?.phase ?? null;
  if (phase === "loading") {
    return "loading";
  }
  return phase === "loaded" ? "present" : "absent";
}

/** Split ⇄ unified as one title-bar control, sitting left of the theme menu. The
 * icon names the current layout; the label names the switch the click performs. */
export function DiffStyleToggle(): ReactElement | null {
  const presence = useReviewStore(selectDiffPresence);
  // App-wide, not per-session: the layout the reader picked follows them across tabs and
  // relaunches (stores/ui-prefs).
  const diffStyle = useUiPrefsStore((state) => state.diffStyle);
  const setDiffStyle = useUiPrefsStore((state) => state.setDiffStyle);

  if (presence === "absent") {
    return null;
  }

  const split = diffStyle === "split";
  const Icon = split ? Columns2 : Rows3;

  return (
    // The icon names the current layout, which leaves the click itself unlabelled — the one
    // thing about this control a glyph genuinely cannot say. The hint says it.
    <TooltipHint
      side="bottom"
      align="end"
      content={split ? "Switch to unified view" : "Switch to split view"}
    >
      <Button
        variant="chrome"
        size="icon"
        className="app-region-no-drag"
        disabled={presence === "loading"}
        aria-label={`Switch to ${split ? "unified" : "split"} view`}
        onClick={() => setDiffStyle(split ? "unified" : "split")}
      >
        <Icon />
      </Button>
    </TooltipHint>
  );
}
