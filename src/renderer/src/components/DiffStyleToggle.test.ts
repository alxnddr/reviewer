import { describe, expect, it } from "vitest";
import type { SessionId } from "../../../shared/session";
import { selectDiffPresence, type DiffPresenceView } from "@/components/DiffStyleToggle";
import { createSessionSlice, type SessionSlice } from "@/stores/review";
import { MULTI_STATUS_PATCH } from "../../../shared/diff/fixtures";
import { parsePatch } from "../../../shared/diff/patch";

// The one rule the title bar's layout switch follows, and the one it shipped disagreeing
// with: the control is about the diff *on screen*, so it answers to the active tab and not
// to the active slice.
//
// The two are not the same question, which is the bug this pins. A start tab is drawn over
// the session it was opened from, so focusing one leaves `activeSessionId` — and that
// session's loaded diff — standing underneath (`activeTabStop`, stores/review/tab-strip.ts).
// The selector used to read the slice alone, so the switch stayed in the title bar on the
// start screen, offering to lay out a diff nobody was looking at. Both `DiffStyleToggle`'s
// own header and `TitleBar.tsx`'s said it should be absent there, so there was nothing but
// prose between the code and the rule — which is what this file replaces.
//
// It is a pure function over the store's shape rather than a render, because vitest runs
// `node` here with no DOM (see CLAUDE.md): the component's whole decision is this selector,
// so testing the selector is testing the decision.
const SESSION_ID = "11111111-1111-4111-8111-111111111111" as SessionId;

function view(session: SessionSlice | null, activeStartTabId: string | null): DiffPresenceView {
  return {
    sessions: session === null ? {} : { [SESSION_ID]: session },
    activeSessionId: session === null ? null : SESSION_ID,
    activeStartTabId,
  };
}

function slice(diff: SessionSlice["diff"]): SessionSlice {
  return createSessionSlice(
    { id: SESSION_ID, repo: { path: "/tmp/fixture", name: "fixture" } },
    { diff },
  );
}

const LOADED: SessionSlice["diff"] = {
  phase: "loaded",
  loadId: 1,
  files: parsePatch(MULTI_STATUS_PATCH, "DiffStyleToggle.test"),
};

describe("selectDiffPresence", () => {
  it("is absent on a first-run window, which has no tab at all", () => {
    expect(selectDiffPresence(view(null, null))).toBe("absent");
  });

  it("is absent on a start tab, even with a loaded diff in the session behind it", () => {
    expect(selectDiffPresence(view(slice(LOADED), "start-1"))).toBe("absent");
  });

  it("is present on a session tab with a loaded diff", () => {
    expect(selectDiffPresence(view(slice(LOADED), null))).toBe("present");
  });

  // The distinction that keeps the control from flickering in halfway through a load: it is
  // drawn disabled from the first request rather than arriving with the files.
  it("is loading on a session tab whose diff is still on its way", () => {
    expect(selectDiffPresence(view(slice({ phase: "loading" }), null))).toBe("loading");
  });

  it("is absent on a session tab that has not asked for a diff yet", () => {
    expect(selectDiffPresence(view(slice({ phase: "idle" }), null))).toBe("absent");
  });
});
