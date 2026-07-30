import { describe, expect, it } from "vitest";
import {
  importReview,
  type Comment,
  type ImportedReview,
  type ReviewArtifactDraft,
  type ReviewComment,
  type ReviewLayer,
  type ReviewStamp,
} from "../../../shared/review";
import type { RepoInfo } from "../../../shared/git";
import { buildHugeAdditionPatch, MULTI_STATUS_PATCH, RENAMES_PATCH } from "./diff/fixtures";
import { parsePatch } from "./diff/patch";
import {
  commentsToPrompt,
  commentToPrompt,
  exportSourceFor,
  markdownCommentsFrom,
  nestLayers,
  PROMPT_SNIPPET_MAX_LINES,
  promptCommentsFrom,
  reviewToMarkdown,
  serializeReview,
  type MarkdownComment,
  type PromptComment,
  type PromptReview,
} from "./review-export";

// A deterministic stamp: import assigns identity, so a fresh id per comment and layer makes
// the round-trip reproducible. The authored projection compares with identity stripped,
// so the actual values only need to be distinct.
function stamp(prefix: string): ReviewStamp {
  let counter = 0;
  return {
    newId: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${prefix}${String(counter).padStart(10, "0")}`;
    },
  };
}

const FIXTURE: ReviewArtifactDraft = {
  repo: "/repos/app",
  base: "main",
  head: "a".repeat(40),
  patch: "diff --git a/src/a.ts b/src/a.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
  comments: [
    { file: "src/a.ts", side: "additions", startLine: 10, endLine: 12, body: "first" },
    { file: "src/b.ts", side: "deletions", startLine: 3, endLine: 3, body: "second" },
  ],
  layers: [
    {
      label: "Validation",
      summary: "guards the input",
      ranges: [{ file: "src/a.ts", side: "additions", startLine: 10, endLine: 12 }],
    },
    {
      label: "Feature",
      summary: "adds the endpoint",
      ranges: [{ file: "src/b.ts", side: "deletions", startLine: 3, endLine: 3 }],
    },
  ],
};

function importFixture(artifact: ReviewArtifactDraft, prefix: string): ImportedReview {
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
  it("writes the repo as the bare path the artifact carries, refs flat beside it", () => {
    const serialized = serializeReview(importFixture(FIXTURE, "aa"));
    expect(serialized.repo).toBe("/repos/app");
    expect(serialized.base).toBe("main");
    expect(serialized.head).toBe("a".repeat(40));
    // The display name is derived on import, never written back.
    expect(JSON.stringify(serialized)).not.toContain('"name"');
  });

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
    const reimported = importFixture(serialized, "bb");

    // Comments equal on the authored projection (id reassigned on import).
    expect(reimported.comments.map(authored)).toEqual([
      authored(edited.comments[0]!),
      authored(edited.comments[1]!),
    ]);
    expect(reimported.comments.map((comment) => comment.body)).toContain("edited first");

    // Layer order and the edited summary survived.
    expect(reimported.layers.map((layer) => layer.label)).toEqual(["Feature", "Validation"]);
    expect(reimported.layers[1]!.summary).toBe("edited summary");
  });

  it("re-nests the flat layers on the way out, dropping the stamped id and parent", () => {
    const nested: ReviewArtifactDraft = {
      ...FIXTURE,
      layers: [
        {
          label: "Group",
          summary: "the theme",
          children: [
            {
              label: "Inner",
              description: "Guards the input.\n\nSee `parse` in [a](src/a.ts).",
              ranges: [{ file: "src/a.ts", side: "additions", startLine: 10, endLine: 12 }],
              children: [{ label: "Deepest", ranges: [] }],
            },
          ],
        },
        {
          label: "Tail",
          ranges: [{ file: "src/b.ts", side: "deletions", startLine: 3, endLine: 3 }],
        },
      ],
    };

    const serialized = serializeReview(importFixture(nested, "ee"));

    // The tree comes back exactly as authored — no ids, no parents, and no empty
    // `children`/`ranges` keys the author never wrote.
    expect(serialized.layers).toEqual([
      {
        label: "Group",
        summary: "the theme",
        children: [
          {
            label: "Inner",
            description: "Guards the input.\n\nSee `parse` in [a](src/a.ts).",
            ranges: [{ file: "src/a.ts", side: "additions", startLine: 10, endLine: 12 }],
            children: [{ label: "Deepest" }],
          },
        ],
      },
      {
        label: "Tail",
        ranges: [{ file: "src/b.ts", side: "deletions", startLine: 3, endLine: 3 }],
      },
    ]);

    // ...and re-importing it rebuilds the same flat outline, depth-first.
    const reimported = importFixture(serialized, "ff");
    expect(reimported.layers.map((layer) => layer.label)).toEqual([
      "Group",
      "Inner",
      "Deepest",
      "Tail",
    ]);
    expect(reimported.layers[2]!.parent).toBe(reimported.layers[1]!.id);
  });

  it("is idempotent and emits no app-assigned identity or derived state", () => {
    const review = importFixture(FIXTURE, "cc");

    const once = serializeReview(review);
    const twice = serializeReview(importFixture(once, "dd"));
    expect(twice).toEqual(once);

    // The wire comment is the minimal authored shape — no id — and the JSON
    // carries no outdated flag anywhere (derived state stays out).
    for (const comment of once.comments ?? []) {
      expect(comment).not.toHaveProperty("id");
    }
    const text = JSON.stringify(once);
    expect(text).not.toContain("outdated");
    expect(text).not.toContain("00000000-0000-4000");
  });

  it("omits the half a review does not carry rather than writing an empty array", () => {
    const review = importFixture(FIXTURE, "gg");
    expect(serializeReview({ ...review, layers: [] })).not.toHaveProperty("layers");
    expect(serializeReview({ ...review, comments: [] })).not.toHaveProperty("comments");
  });

  it("preserves the embedded patch verbatim and drops an absent one", () => {
    const withPatch = serializeReview(importFixture(FIXTURE, "ee"));
    expect(withPatch.patch).toBe(FIXTURE.patch);

    const { patch: _patch, ...noPatchArtifact } = FIXTURE;
    const withoutPatch = serializeReview(importFixture(noPatchArtifact, "ff"));
    expect(withoutPatch).not.toHaveProperty("patch");
  });
});

describe("nestLayers", () => {
  it("keeps sibling order and treats a parent naming no layer as a root", () => {
    const nested = nestLayers([
      { id: "a", label: "A", ranges: [] },
      { id: "b", label: "B", parent: "a", ranges: [] },
      { id: "c", label: "C", parent: "a", ranges: [] },
      { id: "d", label: "D", parent: "ghost", ranges: [] },
    ]);

    expect(nested).toEqual([
      { label: "A", children: [{ label: "B" }, { label: "C" }] },
      { label: "D" },
    ]);
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

  const REPO: RepoInfo = { path: "/repos/app", name: "app" };
  const HEAD = "a".repeat(40);

  it("renders layers as ordered sections with grouped comments and an outdated note", () => {
    const markdown = reviewToMarkdown({
      repo: REPO,
      base: "main",
      head: HEAD,
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

  it("omits the deck line for a layer that carries only a label", () => {
    const markdown = reviewToMarkdown({
      repo: REPO,
      base: "main",
      head: HEAD,
      overview: null,
      layers: [
        {
          id: "l1",
          label: "Bare",
          ranges: [{ file: "src/a.ts", side: "additions", startLine: 1, endLine: 40 }],
        },
      ],
      comments: [comment("src/a.ts", "additions", 2, 2, "covered")],
    });

    expect(markdown).toMatchInlineSnapshot(`
      "# Review — app

      \`main\` … \`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\`

      ## Bare

      - \`src/a.ts\` L2 — covered
      "
    `);
  });

  it("leads with the tour doc: its title is the document, its body the lead", () => {
    const markdown = reviewToMarkdown({
      repo: REPO,
      base: "main",
      head: HEAD,
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
      repo: REPO,
      base: "main",
      head: HEAD,
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

  it("resolves a comment authored before a rename against the renamed file", () => {
    // The app hosts this one on `src/edit.txt` and shows it placed; an export that
    // looked the file up by its current path alone would print it outdated. The
    // exported anchor stays the authored path — that is what the artifact carries.
    const beforeRename: Comment = {
      ...comment,
      file: "src/old-edit.txt",
      side: "deletions",
      startLine: 2,
      endLine: 2,
    };
    const [projected] = markdownCommentsFrom(
      [beforeRename],
      parsePatch(RENAMES_PATCH, "test"),
      false,
    );
    expect(projected?.outdated).toBe(false);
    expect(projected?.file).toBe("src/old-edit.txt");
  });
});

describe("exportSourceFor", () => {
  const repo: RepoInfo = { path: "/repo", name: "app" };
  const HEAD = "a".repeat(40);
  const LAST = "b".repeat(40);
  const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

  it("exports a branch comparison as refs, no patch needed", () => {
    const plan = exportSourceFor({ kind: "branches", base: "main", head: "feature" }, repo, HEAD);
    expect(plan).toEqual({ repo, base: "main", head: "feature", needsPatch: false });
  });

  it("freezes a commit range, recording its endpoints as the refs", () => {
    const plan = exportSourceFor({ kind: "commitRange", first: HEAD, last: LAST }, repo, HEAD);
    expect(plan).toEqual({ repo, base: HEAD, head: LAST, needsPatch: true });
  });

  it("sources a working-tree diff at HEAD and freezes it", () => {
    const plan = exportSourceFor({ kind: "uncommitted" }, repo, HEAD);
    expect(plan).toEqual({ repo, base: HEAD, head: HEAD, needsPatch: true });
  });

  it("falls back to the empty-tree hash for an unborn repo's working tree", () => {
    const plan = exportSourceFor({ kind: "uncommitted" }, repo, null);
    expect(plan).toEqual({ repo, base: EMPTY_TREE, head: EMPTY_TREE, needsPatch: true });
  });
});

// ── The prompt exports ──────────────────────────────────────────────────────────

/** A fenced block inside a *file*, so the snippet lifted from it carries a run of three
 * backticks and the block wrapping it has to outgrow them. */
const FENCED_FILE_PATCH = `diff --git a/doc.md b/doc.md
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/doc.md
@@ -0,0 +1,3 @@
+\`\`\`ts
+const x = 1;
+\`\`\`
`;

/** One id, since these tests never compare two comments by identity. */
const ID = "00000000-0000-4000-8000-000000000001";

function promptComment(overrides: Partial<PromptComment> = {}): PromptComment {
  return {
    file: "src/a.ts",
    side: "additions",
    startLine: 1,
    endLine: 1,
    body: "why",
    outdated: false,
    snippet: null,
    ...overrides,
  };
}

function promptLayer(id: string, label: string, ranges: ReviewLayer["ranges"]): ReviewLayer {
  return { id, label, ranges };
}

const PROMPT_REPO: RepoInfo = { path: "/repos/app", name: "app" };

function promptReview(overrides: Partial<PromptReview> = {}): PromptReview {
  return {
    repo: PROMPT_REPO,
    refs: { base: "main", head: "feature" },
    overview: null,
    layers: [],
    comments: [],
    ...overrides,
  };
}

describe("promptCommentsFrom", () => {
  it("lifts the anchored code out of the diff", () => {
    const comment: Comment = {
      file: "greet.ts",
      side: "additions",
      startLine: 2,
      endLine: 3,
      body: "why",
      id: ID,
    };
    const [projected] = promptCommentsFrom(
      [comment],
      parsePatch(MULTI_STATUS_PATCH, "prompt"),
      false,
    );
    expect(projected?.snippet?.lines.map((line) => line.text)).toEqual([
      "  return `hi ${name}`;",
      "}",
    ]);
    expect(projected?.snippet?.hidden).toBe(0);
  });

  it("lifts the code from the file the rename resolved to, not from the authored path", () => {
    // The trap: the drift resolution reads a pre-rename anchor through `filesByAnchorPath`
    // and the snippet has to read through the *same* lookup, or a renamed file's comment
    // gets its anchor from one file and its code from another.
    const beforeRename: Comment = {
      file: "src/old-edit.txt",
      side: "deletions",
      startLine: 2,
      endLine: 2,
      body: "why",
      id: ID,
    };
    const [projected] = promptCommentsFrom(
      [beforeRename],
      parsePatch(RENAMES_PATCH, "prompt"),
      false,
    );
    expect(projected?.outdated).toBe(false);
    expect(projected?.file).toBe("src/old-edit.txt");
    expect(projected?.snippet?.lines.map((line) => line.text)).toEqual(["edit line2"]);
  });

  it("gives an outdated comment no snippet to be wrong about", () => {
    const gone: Comment = {
      file: "gone.ts",
      side: "additions",
      startLine: 1,
      endLine: 1,
      body: "why",
      id: ID,
    };
    const [projected] = promptCommentsFrom([gone], [], false);
    expect(projected?.outdated).toBe(true);
    expect(projected?.snippet).toBeNull();
  });

  it("caps the lifted code and reports what it withheld", () => {
    const wide: Comment = {
      file: "huge.ts",
      side: "additions",
      startLine: 1,
      endLine: 30,
      body: "why",
      id: ID,
    };
    const [projected] = promptCommentsFrom(
      [wide],
      parsePatch(buildHugeAdditionPatch(30), "prompt"),
      false,
    );
    expect(projected?.snippet?.lines).toHaveLength(PROMPT_SNIPPET_MAX_LINES);
    expect(projected?.snippet?.hidden).toBe(30 - PROMPT_SNIPPET_MAX_LINES);
  });
});

describe("commentToPrompt", () => {
  it("leads with the instruction the body deliberately does not carry", () => {
    // A comment body says why, never what; without a verb the payload is a diagnosis and
    // an agent is as likely to explain it as fix it.
    expect(commentToPrompt(promptComment())).toMatch(/^Fix this code review comment\.\n\n/u);
  });

  it("names the anchor as a place a tool can open", () => {
    expect(commentToPrompt(promptComment({ startLine: 42, endLine: 47 }))).toContain(
      "### `src/a.ts:42-47`",
    );
  });

  it("names a one-line anchor without a range", () => {
    expect(commentToPrompt(promptComment({ startLine: 42, endLine: 42 }))).toContain(
      "### `src/a.ts:42`",
    );
  });

  it("spells out what a deletions-side line number means", () => {
    const prompt = commentToPrompt(promptComment({ side: "deletions" }));
    expect(prompt).toContain("deletions side —");
    expect(prompt).toContain("as it stood before this change");
  });

  it("tells a drifted anchor to be found by content, and carries no code to find it by", () => {
    const prompt = commentToPrompt(promptComment({ outdated: true }));
    expect(prompt).toContain("outdated —");
    expect(prompt).toContain("find the code by content rather than by number");
    expect(prompt).not.toContain("```");
  });

  it("says both when a deletion has also drifted", () => {
    const prompt = commentToPrompt(promptComment({ side: "deletions", outdated: true }));
    expect(prompt).toContain("(deletions side —");
    expect(prompt).toContain("; outdated —");
  });

  it("carries the body verbatim, fences and all", () => {
    // The body is markdown in a markdown document — nothing wraps it, so a fenced fix in a
    // comment needs no escaping and must not get any.
    const body = "Do this instead:\n\n```ts\nconst x = 1;\n```";
    expect(commentToPrompt(promptComment({ body }))).toContain(body);
  });

  it("fences the code longer than the longest backtick run inside it", () => {
    const comment: Comment = {
      file: "doc.md",
      side: "additions",
      startLine: 1,
      endLine: 3,
      body: "why",
      id: ID,
    };
    const [projected] = promptCommentsFrom(
      [comment],
      parsePatch(FENCED_FILE_PATCH, "prompt"),
      false,
    );
    expect(projected).toBeDefined();
    expect(commentToPrompt(projected as PromptComment)).toContain(
      "````\n```ts\nconst x = 1;\n```\n````",
    );
  });

  it("says how much of the range it withheld rather than trimming in silence", () => {
    const prompt = commentToPrompt(
      promptComment({
        endLine: 30,
        snippet: { lines: [{ kind: "addition", line: 1, text: "x" }], hidden: 6 },
      }),
    );
    expect(prompt).toContain("… 6 more lines, through line 30.");
  });

  it("ends in exactly one newline", () => {
    const prompt = commentToPrompt(promptComment());
    expect(prompt.endsWith("\n")).toBe(true);
    expect(prompt.endsWith("\n\n")).toBe(false);
  });
});

describe("commentsToPrompt", () => {
  const first = promptComment({ file: "src/a.ts", startLine: 10, endLine: 12, body: "first" });
  const second = promptComment({ file: "src/b.ts", startLine: 3, endLine: 3, body: "second" });
  const loose = promptComment({ file: "src/c.ts", startLine: 1, endLine: 1, body: "loose" });
  const layers = [
    promptLayer("l1", "Validation", [
      { file: "src/a.ts", side: "additions", startLine: 10, endLine: 12 },
    ]),
    promptLayer("l2", "Feature", [
      { file: "src/b.ts", side: "additions", startLine: 3, endLine: 3 },
    ]),
    promptLayer("l3", "Empty", [{ file: "src/z.ts", side: "additions", startLine: 1, endLine: 1 }]),
  ];

  it("sections the comments by the layers the review authored, in that order", () => {
    const prompt = commentsToPrompt(promptReview({ layers, comments: [second, first] }));
    expect(prompt.indexOf("## Validation")).toBeLessThan(prompt.indexOf("## Feature"));
    expect(prompt.indexOf("first")).toBeLessThan(prompt.indexOf("second"));
  });

  it("gives a layer with no comments no section — there is nothing to do under it", () => {
    expect(commentsToPrompt(promptReview({ layers, comments: [first, second] }))).not.toContain(
      "## Empty",
    );
  });

  it("trails the comments no layer covers behind a heading that says so", () => {
    const prompt = commentsToPrompt(promptReview({ layers, comments: [first, loose] }));
    expect(prompt).toContain("## Other comments");
    expect(prompt.indexOf("## Validation")).toBeLessThan(prompt.indexOf("## Other comments"));
  });

  it("names no sections at all on a review with no layers", () => {
    const prompt = commentsToPrompt(promptReview({ comments: [first, loose] }));
    expect(prompt).not.toMatch(/^## /mu);
    expect(prompt).not.toContain("grouped");
  });

  it("heads the payload with the change's name and the diff it reviews", () => {
    const prompt = commentsToPrompt(
      promptReview({
        overview: { title: "Replace the polling loop", body: "…" },
        comments: [first],
      }),
    );
    expect(prompt).toContain("# Code review comments — Replace the polling loop");
    expect(prompt).toContain("1 comment from a code review of `app` (`main` … `feature`).");
  });

  it("names no refs for a session with no authored origin", () => {
    const prompt = commentsToPrompt(promptReview({ refs: null, comments: [first, second] }));
    expect(prompt).toContain("2 comments from a code review of `app`. Address each one.");
  });

  it("numbers nothing — a comment is named by its anchor, which is what an agent can act on", () => {
    // The payload runs in layer order and the sidebar list runs in diff order, so any
    // number here would name a different comment than the same number there.
    const prompt = commentsToPrompt(promptReview({ layers, comments: [first, second] }));
    expect(prompt).not.toMatch(/^### \d/mu);
  });

  it("renders a comment's block byte-identically to the single-comment payload", () => {
    const target = promptComment({
      file: "src/a.ts",
      side: "deletions",
      startLine: 10,
      endLine: 12,
      body: "why\n\nand also why",
      snippet: { lines: [{ kind: "deletion", line: 10, text: "const x = `1`;" }], hidden: 2 },
    });
    // Everything the single form adds is its first two lines; what is left is the block,
    // and it has to appear in the grouped payload character for character.
    const block = commentToPrompt(target).split("\n").slice(2).join("\n").trimEnd();
    expect(commentsToPrompt(promptReview({ comments: [target] }))).toContain(block);
  });

  it("ends in exactly one newline", () => {
    const prompt = commentsToPrompt(promptReview({ layers, comments: [first, loose] }));
    expect(prompt.endsWith("\n")).toBe(true);
    expect(prompt.endsWith("\n\n")).toBe(false);
  });
});
