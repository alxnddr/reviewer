import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Comment } from "../../../shared/review";
import { CommentsPanel } from "@/components/CommentsPanel";
import { MULTI_STATUS_PATCH } from "@/lib/diff/fixtures";
import { parsePatch } from "@/lib/diff/patch";

// The rail preview is markup, not text: a body is flattened (`flattenMarkdown`) and the
// runs it produces are drawn as sans spans and mono `code`. `markdown.test.ts` pins the
// flattening; what is pinned here is what the panel makes of it, because the row's parse
// is held (`PlainBody`) and the row itself is memoised — optimisations whose whole claim
// is that the markup they produce is the markup they produced before.
//
// Rendered as static markup rather than into a DOM: the panel's output is a pure function
// of its props (its one effect only scrolls a row into view), so a server render is the
// same tree the app mounts, and the renderer's tests stay in a plain node environment.

const FILES = parsePatch(MULTI_STATUS_PATCH, "comments-panel-test");

let seq = 0;
function comment(overrides: Partial<Comment> = {}): Comment {
  seq += 1;
  return {
    file: "greet.ts",
    side: "additions",
    startLine: 4,
    endLine: 4,
    body: "look here",
    id: `aaaaaaaa-aaaa-4aaa-8aaa-${seq.toString(16).padStart(12, "0")}`,
    ...overrides,
  };
}

function render(comments: Comment[], activeCommentId: string | null = null): string {
  return renderToStaticMarkup(
    createElement(CommentsPanel, {
      files: FILES,
      comments,
      frozen: false,
      activeCommentId,
      onFocusComment: () => {},
      expanded: true,
      onToggleExpanded: () => {},
      fill: false,
    }),
  );
}

describe("CommentsPanel", () => {
  it("previews a body as its words, with code runs kept mono", () => {
    const html = render([comment({ body: "**[BUG]** call `resolveAnchor` here" })]);
    expect(html).toContain(
      '<span>[BUG] call </span><code class="font-mono">resolveAnchor</code><span> here</span>',
    );
  });

  it("previews every row the same whichever comment is active", () => {
    const first = comment({ body: "**first** thing" });
    const second = comment({ body: "`second` thing", startLine: 5, endLine: 5 });
    // Each row's preview span, in order. Which row is lit changes that row's fill and
    // its `aria-current`; it must not change a single character of what any row says,
    // which is the whole of what a step of the `n`/`p` walk is allowed to do.
    const previews = (html: string): string[] =>
      [
        ...html.matchAll(
          /<span class="min-w-0 flex-1 truncate text-sm"[^>]*>(?<run>.*?)<\/span><span class="shrink-0/gu,
        ),
      ].map((match) => match.groups?.run ?? "");

    expect(previews(render([first, second], first.id))).toEqual([
      "<span>first thing</span>",
      '<code class="font-mono">second</code><span> thing</span>',
    ]);
    expect(previews(render([first, second], second.id))).toEqual(
      previews(render([first, second], first.id)),
    );
    expect(render([first, second], second.id)).toContain(
      `id="comment-row-${second.id}" aria-current="true"`,
    );
  });
});
