import { clamp } from "../../../../shared/clamp";
import type { SessionId } from "../../../../shared/session";
import type { ReviewState } from "./state";

// The strip as a value: what a stop is, and the four rearrangements the store performs on a
// list of them. Everything here is pure — the arrangements are list-to-list, and the one
// counter is handed out by a factory rather than kept here — which is what lets `tabs.ts`
// (the drag, the close, the accelerators) and the two opening modules (`open.ts`, `boot.ts`,
// which place an arriving session) share the rules without either reaching into the other.

/** A start tab's identity. Renderer-only and meaningless outside this window's lifetime —
 * unlike a session id, which main assigns and persists. */
export type StartTabId = string;

/** One stop in the tab strip: a session, or a start screen. */
export type TabStop = { kind: "session"; id: SessionId } | { kind: "start"; id: StartTabId };

/** One store's supply of start tab ids, each distinguishing its tab from the next. A counter
 * rather than a clock or a random source, for the same reason `promptCopySequence` is one: it
 * only has to differ from the values before it, and a counter is the same in a test as it is
 * in the app.
 *
 * A factory rather than a module counter so the ids belong to a store instead of to this
 * file — two stores are two strips, and a tab of one is not a tab of the other. */
export function createStartTabIds(): () => StartTabId {
  let startTabSequence = 0;
  return () => {
    startTabSequence += 1;
    return `start-${startTabSequence}`;
  };
}

/** Whether two stops are the same tab. Exported for the strip, which has to find the focused
 * stop's position in the list — and cannot do it by session id alone, since the session a
 * focused start tab is drawn over is still the active one underneath. */
export function sameTabStop(a: TabStop, b: TabStop): boolean {
  return a.kind === b.kind && a.id === b.id;
}

/** Which stop the reader is on. A focused start tab wins: it is drawn over the active session
 * rather than instead of it, so `activeSessionId` is still set underneath. */
export function activeTabStop(
  state: Pick<ReviewState, "activeStartTabId" | "activeSessionId">,
): TabStop | null {
  if (state.activeStartTabId !== null) {
    return { kind: "start", id: state.activeStartTabId };
  }
  return state.activeSessionId === null ? null : { kind: "session", id: state.activeSessionId };
}

/** The strip rebuilt against a fresh listing from main, holding whatever arrangement the reader
 * has made of it.
 *
 * Main owns which sessions exist and knows nothing about start tabs, so this is the one place
 * the two facts meet: every stop that still names a live session keeps its slot, every start
 * tab keeps its slot, sessions main has that the strip does not are appended in main's own
 * order, and stops for sessions that are gone drop out. `at` places the appended ones somewhere
 * other than the end — which is what makes a review opened *from* a start tab land in that
 * tab's slot rather than at the back of the strip. */
export function reconcileTabs(
  tabs: TabStop[],
  sessionIds: readonly SessionId[],
  at?: number,
): TabStop[] {
  const live = new Set(sessionIds);
  const kept = tabs.filter((stop) => stop.kind === "start" || live.has(stop.id));
  const known = new Set(kept.filter((stop) => stop.kind === "session").map((stop) => stop.id));
  const added: TabStop[] = sessionIds
    .filter((id) => !known.has(id))
    .map((id) => ({ kind: "session", id }));
  if (added.length === 0) {
    return kept;
  }
  const index = at === undefined ? kept.length : clamp(at, 0, kept.length);
  return [...kept.slice(0, index), ...added, ...kept.slice(index)];
}

/** A session taking a start tab's slot: that stop becomes this session's, wherever the
 * session's own stop happens to be at the time.
 *
 * This is the browser's new-tab-page rule, and it is the whole reason the strip is an ordered
 * list rather than "sessions, then start tabs". Opening a review from the third tab leaves the
 * review *as* the third tab — a fresh tab appearing at the far end while the spent front door
 * stays put is a strip rearranging itself behind the reader's back.
 *
 * A start tab that is no longer there (closed while a native picker was up) leaves the strip
 * alone: the session keeps whatever slot it was given, which is the end. */
export function claimStartTabSlot(
  tabs: TabStop[],
  from: StartTabId,
  sessionId: SessionId,
): TabStop[] {
  if (!tabs.some((stop) => stop.kind === "start" && stop.id === from)) {
    return tabs;
  }
  const without = tabs.filter((stop) => stop.kind !== "session" || stop.id !== sessionId);
  const slot = without.findIndex((stop) => stop.kind === "start" && stop.id === from);
  return [
    ...without.slice(0, slot),
    { kind: "session", id: sessionId },
    ...without.slice(slot + 1),
  ];
}

/** The stop that takes over when `index` is closed: the right neighbour, else the left, else
 * nothing — over the whole strip, so closing a session can land on a start tab and the other
 * way round. The one rule every tabbed app has, applied to a strip with two kinds of tab. */
export function neighbourStop(tabs: TabStop[], index: number): TabStop | null {
  return tabs[index + 1] ?? tabs[index - 1] ?? null;
}

/** The nearest *session* to `index`, searching right then left — what `activeSessionId` has to
 * be re-pointed at when the session it names is closed.
 *
 * It is not the same question as `neighbourStop`, and conflating them is a real bug: the
 * neighbour may be a start tab, and the pointer must name a session or nothing (see the
 * invariant on `activeSessionId`). Leaving it on a deleted id gives the shell a session that
 * resolves to no slice — the diff pane with nothing behind it. */
export function nearestSessionStop(tabs: TabStop[], index: number): SessionId | null {
  for (let step = 1; step <= tabs.length; step += 1) {
    const right = tabs[index + step];
    if (right?.kind === "session") {
      return right.id;
    }
    const left = tabs[index - step];
    if (left?.kind === "session") {
      return left.id;
    }
  }
  return null;
}
