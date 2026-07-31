import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReviewLayer } from "../../../shared/review";
import { LayerList } from "@/components/LayerList";
import { createSessionSlice, type ReviewState, type SessionSlice } from "@/stores/review";
import { parsePatch, type PatchFile } from "../../../shared/diff/patch";

// One rule about who owns a click in the layer rail.
//
// The tree container delegates every click: `rowAtEvent` walks up from the event target
// with `closest("[data-row-id]")`, and the handler then either solos that row or — when it
// is the row already soloed — clears back to the full diff. That second half is the whole
// gesture "click the selected chapter again to leave it".
//
// A row that also carried its own `onClick` would fire `select(id)` and *then* let the
// container run, so a click on the label soloed and re-soloed in one gesture; the clear
// survived only because the container's closure held the `activeLayerId` from the render
// before. That is not a rule anyone could see, and the first refactor that made the
// container read fresh state would have deleted the gesture silently. So: exactly one
// handler selects, and the three facts that rests on are pinned below — the delegation
// target really is on the row (rendered, not asserted from the source), nothing inside a
// row selects on its own, and the one handler carries both halves of the gesture with the
// clear returning rather than falling through into the solo.
//
// The last two are asserted against the source, because there is no DOM test environment
// here to dispatch a click into (vitest.config.ts runs `node`) — the same bind, and the
// same answer, as `dom-ids.test.ts` and `TabBar.test.ts`. What that buys is a failure the
// moment a second click owner reappears; what it cannot do is prove the gesture in a
// browser.
//
// The tree is a rail section, so it reads its own state (the data rule in ReviewRail.tsx)
// and a case sets up a session rather than a props object. The store hook is stubbed
// rather than seeded because `renderToStaticMarkup` takes a zustand subscription's
// *server* snapshot — the store's initial state, which `useReviewStore.setState` does not
// touch. With the subscription out of the picture the hook is just a selector call, which
// is what the stub is; the module is otherwise real, selectors and actions included.
// (`CommentsPanel.test.ts` renders its own section the same way.)
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

const PATCH = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,3 +10,5 @@",
  " ctx10",
  "-old11",
  "+new11",
  "+new12",
  "+new13",
  " ctx14",
  "",
].join("\n");

const FILES: PatchFile[] = parsePatch(PATCH, "layer-list-test");

/** A parent with one child, so the rendered rows cover both a group and a leaf. */
const LAYERS: ReviewLayer[] = [
  { id: "parent", label: "Parsing", ranges: [] },
  {
    id: "child",
    label: "Hunk splitting",
    summary: "where the ranges come from",
    ranges: [{ file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 }],
    parent: "parent",
  },
];

function render(activeLayerId: string | null): string {
  seeded.slice = createSessionSlice(
    { id: seeded.id, repo: { path: "/repo", name: "repo" } },
    { diff: { phase: "loaded", loadId: 1, files: FILES }, layers: LAYERS, activeLayerId },
  );
  return renderToStaticMarkup(
    createElement(LayerList, { expanded: true, onToggleExpanded: () => {} }),
  );
}

/** The row element a click anywhere inside resolves to, with everything it wraps. */
function rowMarkup(html: string, id: string): string {
  const start = html.indexOf(`data-row-id="${id}"`);
  expect(start).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<", start);
  const next = html.indexOf('data-row-id="', start + 1);
  return html.slice(open, next === -1 ? undefined : html.lastIndexOf("<", next));
}

describe("LayerList row clicks", () => {
  it("puts every row's label inside that row's delegation target", () => {
    const html = render(null);
    // `closest("[data-row-id]")` from the label has to land on the row it labels, or the
    // container's one handler cannot tell which layer was clicked.
    expect(rowMarkup(html, "parent")).toContain("Parsing");
    expect(rowMarkup(html, "child")).toContain("Hunk splitting");
  });

  it("keeps the delegation target on the soloed row too", () => {
    // The clear is reached by clicking the row that is already selected, so that row must
    // still resolve — a selected row is not a different row type here.
    const html = render("child");
    const row = rowMarkup(html, "child");
    expect(row).toContain('aria-selected="true"');
    expect(row).toContain("Hunk splitting");
  });
});

const SOURCE = readFileSync(join(__dirname, "LayerList.tsx"), "utf8");

/** `TreeRow`'s body: from its declaration to the props type of the panel below it. */
const TREE_ROW = SOURCE.slice(
  SOURCE.indexOf("function TreeRow("),
  SOURCE.indexOf("type LayerListProps"),
);

/** The `<TreeRow …/>` element the panel renders, so what it is *handed* is pinned too. */
const TREE_ROW_USE = SOURCE.slice(
  SOURCE.indexOf("<TreeRow"),
  SOURCE.indexOf("/>", SOURCE.indexOf("<TreeRow")),
);

/** The tree container's own props — the delegating `onClick` among them — ending where
 * the rows it contains begin, so "the handler" below means *that* handler and not any
 * line elsewhere in the file that happens to read the same. */
const TREE_CONTAINER = SOURCE.slice(SOURCE.indexOf('role="tree"'), SOURCE.indexOf("<TreeRow"));

describe("LayerList's single click owner", () => {
  it("gives a row no selection handler of its own", () => {
    expect(TREE_ROW).not.toContain("onSelect");
    expect(TREE_ROW_USE).not.toContain("onSelect");
  });

  it("leaves the twisty as the only handler inside a row, and it stops propagating", () => {
    expect([...TREE_ROW.matchAll(/onClick=/gu)]).toHaveLength(1);
    expect(TREE_ROW).toContain("event.stopPropagation()");
  });

  it("gives the delegated handler both halves of the gesture, exclusively", () => {
    // Solo *or* clear, never both: the clear returns rather than falling through, which
    // is what the row's own handler used to defeat by soloing first and leaving the
    // container's stale `activeLayerId` to undo it.
    expect(TREE_CONTAINER).toContain("rowAtEvent(event.target)");
    expect(TREE_CONTAINER).toMatch(
      /if \(row\.id === activeLayerId\) \{\s*setActiveLayer\(null\);\s*return;\s*\}\s*select\(row\.id\);/u,
    );
  });
});
