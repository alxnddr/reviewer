import { describe, expect, it } from "vitest";
import {
  importReview,
  type Comment,
  type ImportedReview,
  type ReviewArtifact,
  type ReviewComment,
  type ReviewStamp,
} from "../../../shared/review";
import type { RepoInfo } from "../../../shared/git";
import {
  exportSourceFor,
  markdownCommentsFrom,
  reviewToMarkdown,
  serializeReview,
  type MarkdownComment,
} from "./review-export";

// A deterministic stamp: import assigns identity, so a fresh id per comment makes
// the round-trip reproducible. The authored projection compares with id stripped,
// so the actual values only need to be distinct.
function stamp(prefix: string): ReviewStamp {
  let counter = 0;
  return {
    newId: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${prefix}${String(counter).padStart(8, "0")}`;
    },
  };
}

const FIXTURE: ReviewArtifact = {
  version: 1,
  source: {
    kind: "local",
    repo: { path: "/repos/app", name: "app" },
    base: "main",
    head: "a".repeat(40),
  },
  patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
  comments: [
    { file: "src/a.ts", side: "additions", startLine: 10, endLine: 12, body: "first" },
    { file: "src/b.ts", side: "deletions", startLine: 3, endLine: 3, body: "second" },
  ],
  layers: [
    {
      id: "l1",
      label: "Validation",
      summary: "guards the input",
      ranges: [{ file: "src/a.ts", side: "additions", startLine: 10, endLine: 12 }],
    },
    {
      id: "l2",
      label: "Feature",
      summary: "adds the endpoint",
      ranges: [{ file: "src/b.ts", side: "deletions", startLine: 3, endLine: 3 }],
    },
  ],
};

function importFixture(artifact: ReviewArtifact, prefix: string): ImportedReview {
  const result = importReview(JSON.stringify(artifact), stamp(prefix));
  if (!result.ok) {
    throw new Error(`fixture failed to import: ${result.error}`);
  }
  return result.review;
}

/** The authored projection of an in-app comment: identity stripped, so the
 * comparison is over what the author wrote, never the app's assigned id. */
function authored(comment: Comment): ReviewComment {
  return {
    file: comment.file,
    side: comment.side,
    startLine: comment.startLine,
    endLine: comment.endLine,
    body: comment.body,
  };
}

describe("serializeReview", () => {
  it("round-trips the tour doc, and omits the key entirely when there is none", () => {
    const review = importFixture(FIXTURE, "cc");
    expect(review.overview).toBeNull();
    expect(serializeReview(review)).not.toHaveProperty("overview");

    const overview = { title: "Add the greeting API", body: "Why this exists." };
    const serialized = serializeReview({ ...review, overview });
    expect(serialized.overview).toEqual(overview);
    expect(importFixture(serialized, "dd").overview).toEqual(overview);
  });

  it("round-trips an edited comment and layer through export and re-import", () => {
    const review = importFixture(FIXTURE, "aa");

    // Edit a comment body, a layer summary, and the layer order — the three
    // authored mutations that must survive export.
    const edited: ImportedReview = {
      ...review,
      comments: review.comments.map((comment) =>
        comment.body === "first" ? { ...comment, body: "edited first" } : comment,
      ),
      layers: [review.layers[1]!, { ...review.layers[0]!, summary: "edited summary" }],
    };

    const serialized = serializeReview(edited);

    // The serialized object re-validates against the artifact schema
    // (serializeReview parses internally, but assert it explicitly here).
    expect(() => serializeReview(edited)).not.toThrow();

    const reimported = importFixture(serialized, "bb");

    // Comments equal on the authored projection (id reassigned on import).
    expect(reimported.comments.map(authored)).toEqual([
      authored(edited.comments[0]!),
      authored(edited.comments[1]!),
    ]);
    expect(reimported.comments.map((comment) => comment.body)).toContain("edited first");

    // Layer order and the edited summary survived.
    expect(reimported.layers.map((layer) => layer.id)).toEqual(["l2", "l1"]);
    expect(reimported.layers[1]!.summary).toBe("edited summary");
  });

  it("preserves a layer description and parent through the round-trip", () => {
    // description and parent (the rollup hierarchy) are authored layer fields no
    // earlier test exercises — a projection that dropped them
    // would still pass the id/label/summary/kind/ranges assertions above.
    const withHierarchy: ReviewArtifact = {
      ...FIXTURE,
      layers: [
        {
          ...FIXTURE.layers[0]!,
          description: "Guards the input.\n\nSee `parse` in [a](src/a.ts).",
        },
        { ...FIXTURE.layers[1]!, parent: "l1" },
      ],
    };

    const reimported = importFixture(serializeReview(importFixture(withHierarchy, "ee")), "ff");

    expect(reimported.layers[0]!.description).toBe(
      "Guards the input.\n\nSee `parse` in [a](src/a.ts).",
    );
    expect(reimported.layers[1]!.parent).toBe("l1");
  });

  it("is idempotent and emits no app-assigned identity or derived state", () => {
    const review = importFixture(FIXTURE, "cc");

    const once = serializeReview(review);
    const twice = serializeReview(importFixture(once, "dd"));
    expect(twice).toEqual(once);

    // The wire comment is the minimal authored shape — no id — and the JSON
    // carries no outdated flag anywhere (derived state stays out).
    for (const comment of once.comments) {
      expect(comment).not.toHaveProperty("id");
    }
    const text = JSON.stringify(once);
    expect(text).not.toContain("outdated");
    expect(text).not.toContain("00000000-0000-4000");
  });

  it("preserves the embedded patch verbatim and drops an absent one", () => {
    const withPatch = serializeReview(importFixture(FIXTURE, "ee"));
    expect(withPatch.patch).toBe(FIXTURE.patch);

    const { patch: _patch, ...noPatchArtifact } = FIXTURE;
    const withoutPatch = serializeReview(importFixture(noPatchArtifact, "ff"));
    expect(withoutPatch).not.toHaveProperty("patch");
  });
});

describe("reviewToMarkdown", () => {
  const comment = (
    file: string,
    side: MarkdownComment["side"],
    startLine: number,
    endLine: number,
    body: string,
    outdated = false,
  ): MarkdownComment => ({ file, side, startLine, endLine, body, outdated });

  it("renders layers as ordered sections with grouped comments and an outdated note", () => {
    const markdown = reviewToMarkdown({
      source: FIXTURE.source,
      overview: null,
      layers: [
        {
          id: "l1",
          label: "Validation",
          summary: "guards the input",
          ranges: [{ file: "src/a.ts", side: "additions", startLine: 1, endLine: 40 }],
        },
        {
          id: "l2",
          label: "Feature",
          summary: "adds the endpoint",
          ranges: [{ file: "src/b.ts", side: "deletions", startLine: 1, endLine: 40 }],
        },
      ],
      comments: [
        comment("src/a.ts", "additions", 12, 14, "range comment"),
        comment("src/a.ts", "additions", 5, 5, "drifted", true),
        comment("src/b.ts", "deletions", 3, 3, "on the old side"),
        comment("src/z.ts", "additions", 1, 1, "no layer covers me\nsecond line"),
      ],
    });

    expect(markdown).toMatchInlineSnapshot(`
      "# Review — app

      \`main\` … \`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\`

      ## Validation

      guards the input

      - \`src/a.ts\` L5 (outdated) — drifted
      - \`src/a.ts\` L12–14 — range comment

      ## Feature

      adds the endpoint

      - \`src/b.ts\` L3 (deletions) — on the old side

      ## Other comments

      - \`src/z.ts\` L1 — no layer covers me
        second line
      "
    `);
  });

  it("leads with the tour doc: its title is the document, its body the lead", () => {
    const markdown = reviewToMarkdown({
      source: FIXTURE.source,
      overview: {
        title: "Add the greeting API",
        body: "Why this exists.\n\nAnd what to notice in [a.ts](src/a.ts).",
      },
      layers: [
        {
          id: "l1",
          label: "Validation",
          summary: "guards the input",
          ranges: [],
        },
      ],
      comments: [],
    });

    expect(markdown).toMatchInlineSnapshot(`
      "# Add the greeting API

      Review — \`app\`

      \`main\` … \`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\`

      Why this exists.

      And what to notice in [a.ts](src/a.ts).

      ## Validation

      guards the input
      "
    `);
  });

  it("ends in exactly one trailing newline", () => {
    const markdown = reviewToMarkdown({
      source: FIXTURE.source,
      overview: null,
      layers: [],
      comments: [],
    });
    expect(markdown.endsWith("\n")).toBe(true);
    expect(markdown.endsWith("\n\n")).toBe(false);
  });
});

describe("markdownCommentsFrom", () => {
  const comment: Comment = {
    file: "gone.ts",
    side: "additions",
    startLine: 1,
    endLine: 1,
    body: "still here",
    id: "00000000-0000-4000-8000-000000000001",
  };

  it("flags a comment whose file is absent from a re-derived diff as outdated", () => {
    const [projected] = markdownCommentsFrom([comment], [], false);
    expect(projected?.outdated).toBe(true);
  });

  it("never flags outdated against a frozen embedded patch", () => {
    const [projected] = markdownCommentsFrom([comment], [], true);
    expect(projected?.outdated).toBe(false);
  });
});

describe("exportSourceFor", () => {
  const repo: RepoInfo = { path: "/repo", name: "app" };
  const HEAD = "a".repeat(40);
  const LAST = "b".repeat(40);
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  it("exports a branch comparison as refs, no patch needed", () => {
    const plan = exportSourceFor({ kind: "branches", base: "main", head: "feature" }, repo, HEAD);
    expect(plan).toEqual({
      source: { kind: "local", repo, base: "main", head: "feature" },
      needsPatch: false,
    });
  });

  it("freezes a commit range, recording its endpoints as the source", () => {
    const plan = exportSourceFor({ kind: "commitRange", first: HEAD, last: LAST }, repo, HEAD);
    expect(plan).toEqual({
      source: { kind: "local", repo, base: HEAD, head: LAST },
      needsPatch: true,
    });
  });

  it("sources a working-tree diff at HEAD and freezes it", () => {
    const plan = exportSourceFor({ kind: "uncommitted" }, repo, HEAD);
    expect(plan).toEqual({
      source: { kind: "local", repo, base: HEAD, head: HEAD },
      needsPatch: true,
    });
  });

  it("falls back to the empty-tree hash for an unborn repo's working tree", () => {
    const plan = exportSourceFor({ kind: "uncommitted" }, repo, null);
    expect(plan).toEqual({
      source: { kind: "local", repo, base: EMPTY_TREE, head: EMPTY_TREE },
      needsPatch: true,
    });
  });
});
