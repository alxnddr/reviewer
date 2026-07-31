import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shallow } from "zustand/shallow";
import { createSessionSlice, useReviewStore, type SessionSlice } from "@/stores/review";

// A performance contract with no type or lint rule behind it, and no DOM test environment
// here to render TabBar and count its renders (vitest.config.ts runs `node`), so it is
// asserted against the source instead, the way DiffView.test.ts asserts its own.
//
// `setSlice` (stores/review/slice.ts) reallocates the whole top-level `sessions` record on every
// write to any session's slice -- unconditionally, before its own no-op guard even runs, for
// any call that does change something. A plain `useReviewStore((state) => state.sessions)`
// subscription therefore re-rendered every tab on every mutation to every session, including
// the up-to-60 Hz `previewBrush` calls a commit-brush drag fires. TabBar only ever reads a
// session's `repo`, `reviewOrigin` and `overview` (fixed at creation, never rewritten in
// place) off the record, so it only needs to re-render when a session actually opens or
// closes -- i.e. when the *set* of ids changes, not its contents.
const SOURCE = readFileSync(join(__dirname, "TabBar.tsx"), "utf8");

describe("TabBar's sessions subscription", () => {
  it("subscribes to the session id set via useShallow, not to the whole sessions record", () => {
    expect(SOURCE).toMatch(
      /useReviewStore\(useShallow\(\(state\) => Object\.keys\(state\.sessions\)\)\)/u,
    );
    expect(SOURCE).not.toMatch(/useReviewStore\(\(state\) => state\.sessions\)/u);
  });
});

// The regex above only pins the wiring; it says nothing about whether that wiring actually
// buys the re-render skip it is there for. `useShallow` decides whether to re-render by
// comparing the *previous* selector output against the *next* one with `shallow` -- so
// exercising that same comparison, against real store transitions produced by real actions
// (not a hand-built pair of arrays), is what actually pins the behavioural contract: a slice
// mutation must leave `Object.keys(sessions)` shallow-equal (no re-render), while a session
// opening or closing must not (a re-render).
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION_ID = "22222222-2222-4222-8222-222222222222";

function seedSlice(id: string): SessionSlice {
  // A slice that has already been derived (so nothing re-fetches under the mutations below),
  // mid-diff-load; everything else is the factory's default.
  return createSessionSlice(
    { id, repo: { path: "/repo", name: "repo" } },
    { diff: { phase: "loading" }, needsDerive: false, requestTicket: 1 },
  );
}

describe("the shallow-equality outcome TabBar's subscription relies on", () => {
  beforeEach(() => {
    // `closeSession` reaches for `window.reviewer` (optional-chained: no bridge needed for
    // this to run, just a `window` to chain off of in this DOM-less environment).
    vi.stubGlobal("window", {});
    useReviewStore.setState({
      boot: "ready",
      sessions: { [SESSION_ID]: seedSlice(SESSION_ID) },
      activeSessionId: SESSION_ID,
      tabs: [{ kind: "session", id: SESSION_ID }],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays shallow-equal to itself across a slice mutation that adds or removes no session", () => {
    const before = useReviewStore.getState().sessions;
    const keysBefore = Object.keys(before);
    useReviewStore.getState().setScrollTop(80);
    // Sanity: the record itself was reallocated (that is exactly what used to re-render
    // TabBar) even though which sessions exist did not change.
    expect(useReviewStore.getState().sessions).not.toBe(before);
    expect(useReviewStore.getState().sessions[SESSION_ID]?.scrollTop).toBe(80);
    expect(shallow(keysBefore, Object.keys(useReviewStore.getState().sessions))).toBe(true);
  });

  it("goes shallow-unequal when a session opens", () => {
    const keysBefore = Object.keys(useReviewStore.getState().sessions);
    useReviewStore.setState({
      sessions: {
        ...useReviewStore.getState().sessions,
        [SECOND_SESSION_ID]: seedSlice(SECOND_SESSION_ID),
      },
      tabs: [...useReviewStore.getState().tabs, { kind: "session", id: SECOND_SESSION_ID }],
    });
    expect(shallow(keysBefore, Object.keys(useReviewStore.getState().sessions))).toBe(false);
  });

  it("goes shallow-unequal when a session closes", () => {
    useReviewStore.setState({
      sessions: {
        ...useReviewStore.getState().sessions,
        [SECOND_SESSION_ID]: seedSlice(SECOND_SESSION_ID),
      },
      tabs: [...useReviewStore.getState().tabs, { kind: "session", id: SECOND_SESSION_ID }],
    });
    const keysBefore = Object.keys(useReviewStore.getState().sessions);
    useReviewStore.getState().closeSession(SECOND_SESSION_ID);
    expect(shallow(keysBefore, Object.keys(useReviewStore.getState().sessions))).toBe(false);
  });
});
