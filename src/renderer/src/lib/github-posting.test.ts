import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { postableDigest, type GitHubStatus } from "../../../shared/github-posting";
import { NO_RESOLUTIONS, withResolution } from "../../../shared/comment-resolution";
import { POST_BATCH_MAX } from "../../../shared/github-posting";
import type { Comment } from "../../../shared/review";
import type { GitHubCheckState } from "./github-links";
import {
  afterPost,
  cardNote,
  cardNoteText,
  editedSincePosted,
  NO_POSTING,
  pendingCount,
  postable,
  postAllBatch,
  postRequestComments,
  tokenCovers,
  tokenCoverage,
  tokenExpiryLabel,
  tokenFormOffered,
  unverifiedReason,
  type PostingState,
} from "./github-posting";

// What the screen offers for posting: the token that covers a pull request, which comments Post
// all sends, what a post's answer does to the state. Main decides again; these decide what is
// drawn.

const PR = { host: "github.com" as const, owner: "Acme", repo: "widget", number: 7 };

function comment(id: string, postableText: string | null = "For the author."): Comment {
  return {
    id,
    file: "a.ts",
    side: "additions",
    startLine: 1,
    endLine: 1,
    body: "finding",
    ...(postableText === null ? {} : { postable: postableText }),
  };
}

const A = comment("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const B = comment("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const BARE = comment("cccccccc-cccc-4ccc-8ccc-cccccccccccc", null);
const BLANK = comment("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "   ");

const OUTSIDE_B: GitHubCheckState = {
  status: "checked",
  check: { kind: "compared", head: "a".repeat(40), outside: [B.id] },
  staleBecause: null,
};

function status(tokens: GitHubStatus["tokens"]): GitHubStatus {
  return { tokens, exposedBy: [] };
}

describe("tokenCovers", () => {
  it("is the owner's token, case aside, or a classic one", () => {
    const fine = { kind: "fineGrained" as const, login: "me", owner: "acme", expiresAt: null };
    const classic = { kind: "classic" as const, login: "me", owner: null, expiresAt: null };
    expect(tokenCovers(null, PR)).toBe(false);
    expect(tokenCovers(status([]), PR)).toBe(false);
    expect(tokenCovers(status([fine]), PR)).toBe(true);
    expect(tokenCovers(status([{ ...fine, owner: "other" }]), PR)).toBe(false);
    expect(tokenCovers(status([classic]), PR)).toBe(true);
    expect(tokenCovers(status([classic]), null)).toBe(false);
  });
});

describe("what may be posted", () => {
  it("leaves out a comment with no text for the author, one on GitHub, and one outside its diff", () => {
    const posted: PostingState = {
      ...NO_POSTING,
      posted: { comments: { [A.id]: { state: "pending", postable: null } }, unverified: null },
    };
    expect(postable(A, NO_POSTING, null)).toBe(true);
    expect(postable(BARE, NO_POSTING, null)).toBe(false);
    expect(postable(BLANK, NO_POSTING, null)).toBe(false);
    expect(postable(A, posted, null)).toBe(false);
    expect(postable(B, NO_POSTING, OUTSIDE_B)).toBe(false);
  });

  it("posts all that may go, in the review's order", () => {
    const ids = (check: GitHubCheckState | null): string[] =>
      postAllBatch([B, BARE, A], NO_POSTING, check, NO_RESOLUTIONS).map((c) => c.id);
    expect(ids(null)).toEqual([B.id, A.id]);
    expect(ids(OUTSIDE_B)).toEqual([A.id]);
  });

  it("leaves out what the reader marked skipped or disagree, and keeps addressed", () => {
    // Marks key on a comment's content (`commentFingerprint`), so each finding is its own.
    const [first, second, third] = ["one", "two", "three"].map((body, i) => ({
      ...comment(`eeeeeee${i}-eeee-4eee-8eee-eeeeeeeeeeee`),
      body,
    }));
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("three comments");
    }
    let marks = withResolution(NO_RESOLUTIONS, first, "skipped");
    marks = withResolution(marks, second, "disagree");
    marks = withResolution(marks, third, "addressed");
    const sent = postAllBatch([first, second, third], NO_POSTING, null, marks);
    expect(sent.map((c) => c.id)).toEqual([third.id]);
  });

  it("takes one post's worth at a time", () => {
    const many = Array.from({ length: POST_BATCH_MAX + 5 }, (_, i) =>
      comment(`0000000${i % 10}-0000-4000-8000-${String(i).padStart(12, "0")}`),
    );
    expect(postAllBatch(many, NO_POSTING, null, NO_RESOLUTIONS)).toHaveLength(POST_BATCH_MAX);
  });

  it("asks with ids and digests only", () => {
    expect(postRequestComments([A, BARE])).toEqual([
      { id: A.id, postable: postableDigest("For the author.") },
    ]);
  });
});

describe("afterPost", () => {
  const busy: PostingState = { ...NO_POSTING, busy: true };

  it("records outcomes and states", () => {
    const next = afterPost(busy, [A.id, B.id], {
      ok: true,
      value: {
        outcomes: {
          [A.id]: { kind: "posted" },
          [B.id]: { kind: "failed", failure: { code: "lineNotInDiff" } },
        },
        state: { comments: { [A.id]: { state: "pending", postable: null } }, unverified: null },
        stoppedBy: null,
      },
    });
    expect(next.busy).toBe(false);
    expect(pendingCount(next)).toBe(1);
    expect(cardNote(next, B.id)).toEqual({ kind: "failed", failure: { code: "lineNotInDiff" } });
    expect(cardNote(next, A.id)).toBeNull();
    expect(next.failure).toBeNull();
  });

  it("holds a moved head as the question, and changes nothing else", () => {
    const next = afterPost(busy, [A.id], {
      ok: false,
      failure: { code: "headMoved", head: "b".repeat(40) },
    });
    expect(next.headMoved).toEqual({ head: "b".repeat(40), ids: [A.id] });
    expect(next.outcomes).toEqual({});
  });
});

describe("describing a token", () => {
  it("says whose repositories, claiming nothing narrower", () => {
    expect(tokenCoverage({ owner: null })).toBe("Any public repository");
    expect(tokenCoverage({ owner: "acme" })).toBe("acme");
  });

  it("says when GitHub reported no expiry, and when one has passed", () => {
    const now = Date.UTC(2026, 9, 3);
    expect(tokenExpiryLabel(null, now)).toBe("No expiry reported");
    expect(tokenExpiryLabel("2026-01-01T00:00:00.000Z", now)).toMatch(/^Expired /u);
    expect(tokenExpiryLabel("2027-01-01T00:00:00.000Z", now)).toMatch(/^Expires /u);
  });
});

describe("the review's findings, in the renderer", () => {
  it("(C5) knows a postable edited since it went", () => {
    const state: PostingState = {
      ...NO_POSTING,
      posted: {
        comments: { [A.id]: { state: "pending", postable: postableDigest("For the author.") } },
        unverified: null,
      },
    };
    expect(editedSincePosted(state, A)).toBe(false);
    expect(editedSincePosted(state, { ...A, postable: "Reworded." })).toBe(true);
    // A record with no digest claims nothing.
    expect(
      editedSincePosted(
        {
          ...state,
          posted: { comments: { [A.id]: { state: "pending", postable: null } }, unverified: null },
        },
        { ...A, postable: "Reworded." },
      ),
    ).toBe(false);
  });

  it("(C7) says the states were not checked, only when there are states to doubt", () => {
    expect(unverifiedReason(NO_POSTING)).toBeNull();
    expect(
      unverifiedReason({
        ...NO_POSTING,
        posted: { comments: {}, unverified: { code: "network" } },
      }),
    ).toBeNull();
    expect(
      unverifiedReason({
        ...NO_POSTING,
        posted: {
          comments: { [A.id]: { state: "pending", postable: null } },
          unverified: { code: "network" },
        },
      }),
    ).toEqual({ code: "network" });
  });

  it("(C8) keeps what stopped a batch partway, and says it on the cards it did not reach", () => {
    const next = afterPost({ ...NO_POSTING, busy: true }, [A.id, B.id], {
      ok: true,
      value: {
        outcomes: {
          [A.id]: { kind: "failed", failure: { code: "rateLimited", resetAt: 0, scope: "token" } },
          [B.id]: { kind: "skipped", because: { code: "rateLimited", resetAt: 0, scope: "token" } },
        },
        state: { comments: {}, unverified: null },
        stoppedBy: { code: "rateLimited", resetAt: 0, scope: "token" },
      },
    });
    expect(next.failure).toMatchObject({ code: "rateLimited" });
    expect(next.stoppedPartway).toBe(true);
    expect(cardNote(next, B.id)).toMatchObject({ kind: "skipped" });
    expect(cardNoteText(cardNote(next, B.id), false)?.hint).toMatch(
      /^The batch stopped before this comment\./u,
    );
  });

  it("hands a card's selector the stored outcome itself, so React sees a stable snapshot", () => {
    const state: PostingState = {
      ...NO_POSTING,
      outcomes: { [A.id]: { kind: "failed", failure: { code: "network" } } },
    };
    expect(cardNote(state, A.id)).toBe(state.outcomes[A.id]);
    expect(cardNote(state, A.id)).toBe(cardNote(state, A.id));
  });

  it("(C11e) says 'Not in GitHub's diff' once, not twice", () => {
    const note = { kind: "failed", failure: { code: "lineNotInDiff" } } as const;
    expect(cardNoteText(note, true)).toBeNull();
    expect(cardNoteText(note, false)?.label).toBe("Not in GitHub's diff");
  });
});

describe("the token field", () => {
  it("is offered only once main has said the run is not exposed", () => {
    expect(tokenFormOffered(null)).toBe(false);
    expect(tokenFormOffered({ tokens: [], exposedBy: ["remote-debugging-port"] })).toBe(false);
    expect(tokenFormOffered({ tokens: [], exposedBy: [] })).toBe(true);
  });

  it("is drawn only inside that guard — held against the source, which has no DOM here", () => {
    const source = readFileSync(
      join(__dirname, "..", "components", "settings", "GitHubTokens.tsx"),
      "utf8",
    );
    expect(source).toMatch(/const offered = tokenFormOffered\(status\);/u);
    expect(source.match(/<form\b/gu)).toHaveLength(1);
    expect(source.match(/type="password"/gu)).toHaveLength(1);
    expect(source).toMatch(/\{offered && \(\s*<form\b/u);
  });
});
