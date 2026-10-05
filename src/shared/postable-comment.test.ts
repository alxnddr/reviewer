import { describe, expect, it } from "vitest";
import type { ReviewComment } from "./review";
import {
  absentAtHead,
  hasPostable,
  postableComment,
  postableReferencesFor,
  type PostableOptions,
} from "./postable-comment";
import { parsePatch } from "./diff/patch";
import { MULTI_STATUS_PATCH } from "./diff/fixtures";
import type { PullRequest } from "./pull-request";

// What a comment says once it has left the app for the change's author. Every case is a
// whole string compared exactly, because the property being bought is that the rewrite
// touches the references and nothing else — a `toContain` would pass a rewrite that also
// re-spelled the paragraph around them.

const SHA = "0123456789abcdef0123456789abcdef01234567";

const INLINE: PostableOptions = { includeEvidence: false, references: { kind: "inline" } };
const GITHUB: PostableOptions = {
  includeEvidence: false,
  references: {
    kind: "github",
    owner: "acme",
    repo: "widgets",
    sha: SHA,
    absentAtHead: new Set(["src/gone.ts", "src/old-name.ts"]),
  },
};
const BLOB = `https://github.com/acme/widgets/blob/${SHA}`;

function comment(fields: Partial<ReviewComment> = {}): ReviewComment {
  return {
    file: "src/a.ts",
    side: "additions",
    startLine: 10,
    endLine: 12,
    body: "**I ran the suite and the retry loop never backs off**",
    ...fields,
  };
}

describe("postableComment", () => {
  it("is null without `postable` — never a fallback to the body, which is written to the reader", () => {
    expect(postableComment(comment(), INLINE)).toBeNull();
    expect(
      postableComment(comment({ evidence: "$ bun test" }), { ...INLINE, includeEvidence: true }),
    ).toBeNull();
  });

  it("passes text with no references through byte for byte", () => {
    const postable =
      "This retries forever.\n\n- Back off per host.\n* Cap the attempts.\n\n```ts\nawait sleep(2 ** n);\n```";
    expect(postableComment(comment({ postable }), INLINE)).toBe(postable);
    expect(postableComment(comment({ postable }), GITHUB)).toBe(postable);
  });

  it("rewrites a reference inline to its label and its location as code", () => {
    expect(
      postableComment(
        comment({ postable: "See [the caller](src/b.ts:40-44), which never awaits." }),
        INLINE,
      ),
    ).toBe("See the caller (`src/b.ts:40-44`), which never awaits.");
  });

  it("keeps the label's own markup when it rewrites around it", () => {
    expect(postableComment(comment({ postable: "[`retry()`](src/b.ts:40) loops." }), INLINE)).toBe(
      "`retry()` (`src/b.ts:40`) loops.",
    );
  });

  it("writes the code span alone when the label already says the path", () => {
    expect(postableComment(comment({ postable: "In [src/b.ts](src/b.ts:40)." }), INLINE)).toBe(
      "In `src/b.ts:40`.",
    );
    expect(postableComment(comment({ postable: "In [src/b.ts:40](src/b.ts:40)." }), INLINE)).toBe(
      "In `src/b.ts:40`.",
    );
    expect(postableComment(comment({ postable: "In [`src/b.ts`](src/b.ts)." }), INLINE)).toBe(
      "In `src/b.ts`.",
    );
    expect(postableComment(comment({ postable: "In [](src/b.ts)." }), INLINE)).toBe(
      "In `src/b.ts`.",
    );
  });

  it("names a single line, a range and a whole file in one spelling each", () => {
    expect(
      postableComment(
        comment({
          postable:
            "[one](src/b.ts:7), [same](src/b.ts:7-7), [run](src/b.ts:7-9), [file](src/b.ts)",
        }),
        INLINE,
      ),
    ).toBe("one (`src/b.ts:7`), same (`src/b.ts:7`), run (`src/b.ts:7-9`), file (`src/b.ts`)");
  });

  it("rewrites every reference and leaves the prose between them alone", () => {
    expect(
      postableComment(
        comment({
          postable: "**Produced** in [here](src/a.ts:3), _misused_ in [there](src/b.ts:9).",
        }),
        INLINE,
      ),
    ).toBe("**Produced** in here (`src/a.ts:3`), _misused_ in there (`src/b.ts:9`).");
  });

  it("does not touch link-shaped text inside a code span or a fence", () => {
    const postable =
      "Write `[x](src/a.ts:1)` like [this](src/a.ts:2).\n\n```md\n[y](src/a.ts:3)\n```";
    expect(postableComment(comment({ postable }), INLINE)).toBe(
      "Write `[x](src/a.ts:1)` like this (`src/a.ts:2`).\n\n```md\n[y](src/a.ts:3)\n```",
    );
  });

  it("leaves an external link untouched under either kind", () => {
    const postable =
      "See [the RFC](https://www.rfc-editor.org/rfc/rfc9110) and https://example.com.";
    expect(postableComment(comment({ postable }), INLINE)).toBe(postable);
    expect(postableComment(comment({ postable }), GITHUB)).toBe(postable);
  });

  it("leaves a malformed reference as written — there is no location to rewrite it to", () => {
    const postable = "See [the caller](src/b.ts:forty).";
    expect(postableComment(comment({ postable }), INLINE)).toBe(postable);
  });

  it("rewrites a reference to a blob link at the reviewed commit on GitHub", () => {
    expect(
      postableComment(
        comment({
          postable: "See [the caller](src/b.ts:40-44), [one](src/b.ts:7) and [the file](src/b.ts).",
        }),
        GITHUB,
      ),
    ).toBe(
      `See [the caller](${BLOB}/src/b.ts#L40-L44), [one](${BLOB}/src/b.ts#L7) and [the file](${BLOB}/src/b.ts).`,
    );
  });

  it("keeps the label's markup and the link's title in a GitHub link, and lends a bare link its location", () => {
    expect(
      postableComment(
        comment({ postable: '[`retry()`](src/b.ts:40 "the loop") and [](src/c.ts:2)' }),
        GITHUB,
      ),
    ).toBe(
      `[\`retry()\`](${BLOB}/src/b.ts#L40 "the loop") and [\`src/c.ts:2\`](${BLOB}/src/c.ts#L2)`,
    );
  });

  it("encodes a path segment that would break the URL or end the link early", () => {
    expect(postableComment(comment({ postable: "[x](<docs/a b (draft).md>)" }), GITHUB)).toBe(
      `[x](${BLOB}/docs/a%20b%20%28draft%29.md)`,
    );
  });

  it("falls back to inline for a @deletions span, which a blob at head cannot show", () => {
    expect(
      postableComment(
        comment({
          postable: "It used to [check](src/b.ts:3-5@deletions) here; see [now](src/b.ts:4).",
        }),
        GITHUB,
      ),
    ).toBe(
      `It used to check (\`src/b.ts:3-5\`, before this change) here; see [now](${BLOB}/src/b.ts#L4).`,
    );
    expect(postableComment(comment({ postable: "[src/b.ts](src/b.ts:3@deletions)" }), INLINE)).toBe(
      "`src/b.ts:3` (before this change)",
    );
  });

  it("falls back to inline for a path absent at head, which a blob link would 404", () => {
    expect(
      postableComment(
        comment({
          postable:
            "It moved out of [the old file](src/gone.ts) and [here](src/old-name.ts:4) into [this](src/b.ts:4).",
        }),
        GITHUB,
      ),
    ).toBe(
      `It moved out of the old file (\`src/gone.ts\`) and here (\`src/old-name.ts:4\`) into [this](${BLOB}/src/b.ts#L4).`,
    );
  });

  it("leaves a reference-style definition as written — the gate refuses the form, so only a hand edit reaches here", () => {
    const postable = "See [the caller][r].\n\n[r]: src/b.ts:40";
    expect(postableComment(comment({ postable }), INLINE)).toBe(postable);
    expect(postableComment(comment({ postable }), GITHUB)).toBe(postable);
  });

  it("fences a location that carries a backtick so the span still closes", () => {
    expect(postableComment(comment({ postable: "[x](odd`name.ts)" }), INLINE)).toBe(
      "x (``odd`name.ts``)",
    );
  });

  it("appends the evidence under a <details> fold when asked, references rewritten", () => {
    const evidence = "```\n$ bun test\n1 failed\n```\n\nIn [the test](src/a.test.ts:4).";
    expect(
      postableComment(comment({ postable: "This retries forever.", evidence }), {
        ...INLINE,
        includeEvidence: true,
      }),
    ).toBe(
      "This retries forever.\n\n<details>\n<summary>Evidence</summary>\n\n```\n$ bun test\n1 failed\n```\n\nIn the test (`src/a.test.ts:4`).\n\n</details>\n",
    );
  });

  it("closes a fence the evidence leaves open, so </details> is not swallowed into it", () => {
    const on = { ...INLINE, includeEvidence: true };
    expect(
      postableComment(comment({ postable: "Retries forever.", evidence: "```\nunclosed" }), on),
    ).toBe(
      "Retries forever.\n\n<details>\n<summary>Evidence</summary>\n\n```\nunclosed\n```\n\n</details>\n",
    );
    // The closer matches the opener's character and length, and a trailing newline is not doubled.
    expect(
      postableComment(
        comment({ postable: "Retries forever.", evidence: "~~~~sh\n$ run\n```\n" }),
        on,
      ),
    ).toBe(
      "Retries forever.\n\n<details>\n<summary>Evidence</summary>\n\n~~~~sh\n$ run\n```\n~~~~\n\n</details>\n",
    );
  });

  it("closes a fence the postable leaves open ahead of the fold, and only then", () => {
    const postable = "Try:\n\n```ts\nawait sleep(n);";
    expect(
      postableComment(comment({ postable, evidence: "$ bun test" }), {
        ...INLINE,
        includeEvidence: true,
      }),
    ).toBe(
      "Try:\n\n```ts\nawait sleep(n);\n```\n\n<details>\n<summary>Evidence</summary>\n\n$ bun test\n\n</details>\n",
    );
    // With no fold to protect, the author's text leaves exactly as written.
    expect(postableComment(comment({ postable }), INLINE)).toBe(postable);
  });

  it("leaves a closed fence, a fence that is not last and an indented block alone", () => {
    const on = { ...INLINE, includeEvidence: true };
    const fold = (evidence: string) =>
      `x\n\n<details>\n<summary>Evidence</summary>\n\n${evidence}\n\n</details>\n`;
    for (const evidence of [
      "```\nok\n```",
      "````\nok\n`````  ",
      "```\nok\n```\n\nthen prose",
      "    indented",
    ]) {
      expect(postableComment(comment({ postable: "x", evidence }), on)).toBe(fold(evidence));
    }
  });

  it("leaves the evidence out when the option is off", () => {
    expect(
      postableComment(
        comment({ postable: "This retries forever.", evidence: "$ bun test" }),
        INLINE,
      ),
    ).toBe("This retries forever.");
  });

  it("adds no fold when the option is on and there is no evidence to put in it", () => {
    const on = { ...INLINE, includeEvidence: true };
    expect(postableComment(comment({ postable: "This retries forever." }), on)).toBe(
      "This retries forever.",
    );
    expect(
      postableComment(comment({ postable: "This retries forever.", evidence: "  \n" }), on),
    ).toBe("This retries forever.");
  });

  it("never carries tag or severity into the text", () => {
    expect(
      postableComment(
        comment({ postable: "This retries forever.", tag: "question", severity: "blocking" }),
        INLINE,
      ),
    ).toBe("This retries forever.");
  });
});

describe("hasPostable", () => {
  it("counts a whitespace-only postable as none — the answer the app's own editor gives on save", () => {
    expect(hasPostable({})).toBe(false);
    expect(hasPostable({ postable: " \n\t " })).toBe(false);
    expect(hasPostable({ postable: "Could this say why?" })).toBe(true);
    expect(postableComment(comment({ postable: "  \n" }), INLINE)).toBeNull();
  });
});

describe("absentAtHead", () => {
  // added.txt, doomed.txt (deleted), greet.ts, img.png, oldname.txt → newname.txt, notes.txt…
  const files = parsePatch(MULTI_STATUS_PATCH, "absent-at-head");

  it("names the deleted files and the old names of renamed ones, and nothing else", () => {
    expect([...absentAtHead(files)].toSorted()).toEqual(["doomed.txt", "oldname.txt"]);
  });

  it("keeps a renamed-away path a new file took again — the safe degrade to an inline reference", () => {
    const retaken = parsePatch(
      [
        "diff --git a/a.ts b/b.ts",
        "similarity index 100%",
        "rename from a.ts",
        "rename to b.ts",
        "diff --git a/a.ts b/a.ts",
        "new file mode 100644",
        "index 0000000..c15acb9",
        "--- /dev/null",
        "+++ b/a.ts",
        "@@ -0,0 +1 @@",
        "+fresh",
        "",
      ].join("\n"),
      "retaken",
    );
    expect(absentAtHead(retaken).has("a.ts")).toBe(true);
    // ...so a reference to it leaves as a location, never as a link that could name the wrong file.
    const text = postableComment(comment({ postable: "See [a](a.ts:1)." }), {
      includeEvidence: false,
      references: {
        kind: "github",
        owner: "acme",
        repo: "widgets",
        sha: SHA,
        absentAtHead: absentAtHead(retaken),
      },
    });
    expect(text).toBe("See a (`a.ts:1`).");
  });
});

describe("postableReferencesFor", () => {
  const PR: PullRequest = { host: "github.com", owner: "acme", repo: "widgets", number: 42 };
  const files = parsePatch(MULTI_STATUS_PATCH, "references-for");

  it("links at the reviewed commit when the review names its pull request and its reviewed diff", () => {
    expect(postableReferencesFor(PR, SHA, files)).toEqual({
      kind: "github",
      owner: "acme",
      repo: "widgets",
      sha: SHA,
      absentAtHead: new Set(["doomed.txt", "oldname.txt"]),
    });
  });

  it("writes references inline with no pull request, no commit to pin to, or no reviewed diff", () => {
    expect(postableReferencesFor(null, SHA, files)).toEqual({ kind: "inline" });
    expect(postableReferencesFor(PR, null, files)).toEqual({ kind: "inline" });
    expect(postableReferencesFor(PR, SHA, null)).toEqual({ kind: "inline" });
  });
});
