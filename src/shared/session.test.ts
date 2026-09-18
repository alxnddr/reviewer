import { describe, expect, it } from "vitest";
import type { CommitSelection } from "./git";
import type { ReviewDiff } from "./review";
import { NO_PROGRESS } from "./review-progress";
import { repinSession, withStoredPin, type Session } from "./session";

// The two rules a review's pin keeps once it is open: how a re-seat moves it (`repinSession`,
// shared by the launch re-pin and Locate Repository…), and that a renderer write-back cannot move
// it back (`withStoredPin`). Both pure, so the table is read here rather than through a store, a
// bridge and a git fixture.

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const PATCH = "diff --git a/src/a.ts b/src/a.ts\n";
const BOX = { path: "/home/box/app", name: "app" };
const LOCAL = { path: "/work/app", name: "app" };
const FROZEN: ReviewDiff = { kind: "frozenPatch", patch: PATCH };
const LIVE: ReviewDiff = { kind: "refs", base: SHA_A, head: SHA_B };
const SUBRANGE: CommitSelection = { kind: "commitRange", first: SHA_B, last: SHA_B };

/** A review opened frozen on a machine without its repo — the state both rules start from. */
function reviewSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    source: { kind: "local", repo: BOX },
    base: null,
    head: null,
    commitSelection: null,
    selectedFilePath: null,
    scrollTop: 0,
    comments: [],
    layers: [],
    overview: null,
    reviewDiff: FROZEN,
    reviewSubrange: null,
    reviewOrigin: { repo: BOX, base: SHA_A, head: SHA_B, patch: PATCH, reviewedHead: null },
    reviewPath: "/reviews/x.reviewer.json",
    ...NO_PROGRESS,
    ...overrides,
  };
}

describe("repinSession", () => {
  it("answers the same session when neither the repo nor the kind of pin moved", () => {
    const session = reviewSession();
    // Identity, so a caller can skip a write that would change nothing.
    expect(repinSession(session, { repo: BOX, reviewDiff: FROZEN })).toBe(session);
  });

  it("thaws onto the checkout, starting on the whole diff", () => {
    expect(repinSession(reviewSession(), { repo: LOCAL, reviewDiff: LIVE })).toMatchObject({
      source: { kind: "local", repo: LOCAL },
      reviewDiff: LIVE,
      reviewSubrange: null,
    });
  });

  it("keeps a subrange across a relocation that leaves the review live", () => {
    // Its SHAs are commits of the same authored refs, wherever the checkout moved to.
    const live = reviewSession({ reviewDiff: LIVE, reviewSubrange: SUBRANGE });
    expect(repinSession(live, { repo: LOCAL, reviewDiff: LIVE }).reviewSubrange).toEqual(SUBRANGE);
  });

  it("drops the subrange when a live review freezes", () => {
    const live = reviewSession({
      source: { kind: "local", repo: LOCAL },
      reviewDiff: LIVE,
      reviewSubrange: SUBRANGE,
    });
    expect(repinSession(live, { repo: LOCAL, reviewDiff: FROZEN }).reviewSubrange).toBeNull();
  });
});

describe("withStoredPin", () => {
  it("keeps main's pin over a write-back that left before the re-seat", () => {
    const stored = reviewSession({ source: { kind: "local", repo: LOCAL }, reviewDiff: LIVE });
    const stale = reviewSession({ scrollTop: 420, readTotal: 3 });

    // The reader's state wins; the pin is main's.
    expect(withStoredPin(stale, stored)).toEqual({
      ...stale,
      source: { kind: "local", repo: LOCAL },
      reviewDiff: LIVE,
    });
  });

  it("lets the reader's subrange through on a live review, and never onto a frozen one", () => {
    const narrowed = reviewSession({ reviewDiff: LIVE, reviewSubrange: SUBRANGE });

    expect(withStoredPin(narrowed, reviewSession({ reviewDiff: LIVE })).reviewSubrange).toEqual(
      SUBRANGE,
    );
    expect(withStoredPin(narrowed, reviewSession()).reviewSubrange).toBeNull();
  });

  it("passes a plain repo session, or one main no longer has, through untouched", () => {
    const plain = reviewSession({ reviewDiff: null, reviewOrigin: null });
    expect(withStoredPin(plain, plain)).toBe(plain);

    const incoming = reviewSession();
    expect(withStoredPin(incoming, undefined)).toBe(incoming);
  });
});
