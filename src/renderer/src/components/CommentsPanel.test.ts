import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Comment } from "../../../shared/review";
import { CommentsPanel } from "@/components/CommentsPanel";
import { createSessionSlice, type ReviewState, type SessionSlice } from "@/stores/review";
import { MULTI_STATUS_PATCH } from "../../../shared/diff/fixtures";
import { parsePatch } from "../../../shared/diff/patch";

// The rail preview is markup, not text: a body is flattened (`flattenMarkdown`) and the
// runs it produces are drawn as sans spans and mono `code`. `markdown.test.ts` pins the
// flattening; what is pinned here is what the panel makes of it, because the row's parse
// is held (`PlainBody`) and the row itself is memoised — optimisations whose whole claim
// is that the markup they produce is the markup they produced before.
//
// Rendered as static markup rather than into a DOM: the panel's output is a pure function
// of the session it is looking at (its one effect only scrolls a row into view), so a
// server render is the same tree the app mounts, and the renderer's tests stay in a plain
// node environment.
//
// That session is handed over by stubbing the store hook rather than by seeding the store:
// the panel is a rail section, so it reads its own state (the data rule in ReviewRail.tsx),
// and `renderToStaticMarkup` takes a zustand subscription's *server* snapshot — which is
// the store's initial state, so `useReviewStore.setState` would never reach the render.
// With the subscription out of the picture the hook is just a selector call, which is
// exactly what the stub is; everything else about the module stays real, including the
// selectors the panel runs through it and the actions it hands its rows.
const seeded = vi.hoisted(() => ({
  id: "11111111-1111-4111-8111-111111111111",
  slice: null as SessionSlice | null,
}));

vi.mock("@/stores/review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/review")>();
  const base = actual.useReviewStore.getState();
  return {
    ...actual,
    useReviewStore: <T>(selector: (state: ReviewState) => T): T =>
      selector(
        seeded.slice === null
          ? base
          : { ...base, sessions: { [seeded.id]: seeded.slice }, activeSessionId: seeded.id },
      ),
  };
});

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
  seeded.slice = createSessionSlice(
    { id: seeded.id, repo: { path: "/repo", name: "repo" } },
    { diff: { phase: "loaded", loadId: 1, files: FILES }, comments, activeCommentId },
  );
  return renderToStaticMarkup(
    createElement(CommentsPanel, { expanded: true, onToggleExpanded: () => {}, fill: false }),
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
