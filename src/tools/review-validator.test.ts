import { describe, expect, it } from "vitest";
import type { FlowNode, ReviewArtifact, ReviewLayerDraft } from "../shared/review";
import {
  MULTI_STATUS_PATCH,
  RENAMES_PATCH,
  TWO_FILE_PATCH,
  TWO_HUNKS_PATCH,
  buildManyHunksPatch,
} from "../shared/diff/fixtures";
import {
  describeProblem,
  parseReviewArtifact,
  validatePlacement,
  type ValidationProblem,
  type ValidationReport,
} from "./review-validator";

/** The artifact as authored — the shape these fixtures write, before the parse fills in
 * `ranges`/`children`. */
type Draft = {
  repo: string;
  base: string;
  head: string;
  patch?: string | undefined;
  overview?: ReviewArtifact["overview"];
  comments?: ReviewArtifact["comments"];
  layers?: ReviewLayerDraft[];
};

function validArtifact(overrides: Partial<Draft> = {}): Draft {
  return {
    repo: "/repo",
    base: "main",
    head: "feature",
    patch: TWO_FILE_PATCH,
    comments: [{ file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13, body: "note" }],
    layers: [
      {
        label: "Rollup",
        summary: "parent",
        children: [
          {
            label: "Leaf",
            summary: "child",
            // A resolving link plus an inert code span: only the broken-link case is a
            // problem, so the code span must not be flagged.
            description: "Touches [bar](src/bar.ts) via `helper`.",
            ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
          },
        ],
      },
    ],
    ...overrides,
  };
}

function kinds(problems: ValidationProblem[]): string[] {
  return problems.map((problem) => problem.kind);
}

/** Parse the untrusted bytes, then place every anchor against the artifact's own embedded
 * patch — the frozen path the CLI takes for an imported artifact that still carries one, and
 * the exact composition (`parseReviewArtifact` + `validatePlacement`) the refs-only path runs
 * against a re-derived diff. Collapses the two steps into one `{ ok }` report so each case
 * asserts the same shape the app anchors against. */
function validate(bytes: string): ValidationReport {
  const parsed = parseReviewArtifact(bytes);
  if (!parsed.ok) {
    return { ok: false, problems: parsed.problems };
  }
  const problems = validatePlacement(parsed.artifact, parsed.artifact.patch ?? "");
  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

describe("parseReviewArtifact + validatePlacement", () => {
  it("returns ok for an artifact whose every anchor places and every link resolves", () => {
    expect(validate(JSON.stringify(validArtifact()))).toEqual({ ok: true });
  });

  it("flags a comment range outside any hunk and a comment on an absent file with exact locators", () => {
    const artifact = validArtifact({
      comments: [
        { file: "src/foo.ts", side: "additions", startLine: 50, endLine: 50, body: "drifted" },
        { file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1, body: "absent" },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toContainEqual({
      kind: "commentAnchorOutdated",
      anchor: { file: "src/foo.ts", side: "additions", startLine: 50, endLine: 50 },
      nearestHunks: [{ startLine: 10, endLine: 14 }],
    });
    expect(report.problems).toContainEqual({
      kind: "commentFileAbsent",
      anchor: { file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 },
    });
  });

  it("agrees with the app that a range across a hunk boundary does not place, but each half does", () => {
    // Both sides of one rule: the gate runs the app's own `resolveAnchor`, so a range
    // spanning the collapsed context between two hunks — the range the surface's `+`
    // clamps away rather than author — is refused here too, while the two halves it
    // clamps to place. An agent hears about it before handing the review over, instead
    // of the reader finding the comment pinned to the file header.
    const artifact = validArtifact({
      patch: TWO_HUNKS_PATCH,
      comments: [
        { file: "src/two-hunks.txt", side: "additions", startLine: 5, endLine: 28, body: "note" },
      ],
      layers: [
        {
          label: "Both hunks",
          summary: "one range per hunk",
          ranges: [
            { file: "src/two-hunks.txt", side: "additions", startLine: 5, endLine: 6 },
            { file: "src/two-hunks.txt", side: "additions", startLine: 27, endLine: 28 },
          ],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toEqual([
      {
        kind: "commentAnchorOutdated",
        anchor: { file: "src/two-hunks.txt", side: "additions", startLine: 5, endLine: 28 },
        // Both halves it would place in, which is the whole fix: split it or pick one.
        nearestHunks: [
          { startLine: 1, endLine: 6 },
          { startLine: 27, endLine: 33 },
        ],
      },
    ]);
  });

  it("places a comment authored before a rename, and still fails a layer range on the old path", () => {
    // The app hosts the comment on the renamed file (deletions are old-file
    // coordinates, so the anchor is untouched by the rename) — the gate must agree.
    // A layer range on the same old path is a different story: the app's layer scroll
    // only finds a file by its current path, so passing it would green-light a
    // walkthrough stop the reader cannot reach.
    const artifact = validArtifact({
      patch: RENAMES_PATCH,
      comments: [
        { file: "src/old-edit.txt", side: "deletions", startLine: 2, endLine: 2, body: "note" },
      ],
      layers: [
        {
          label: "Rename",
          summary: "moved it",
          ranges: [{ file: "src/old-edit.txt", side: "deletions", startLine: 2, endLine: 2 }],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(kinds(report.problems)).toEqual(["layerRangeOutdated"]);
  });

  it("flags an unresolved description link by ordinal, leaving a parent rollup's empty ranges valid", () => {
    const artifact = validArtifact({
      layers: [
        {
          label: "Rollup",
          summary: "parent",
          children: [
            {
              label: "Leaf",
              summary: "child",
              description: "See [ghost](does/not/exist.ts).",
              ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
            },
          ],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toEqual([
      {
        kind: "unresolvedLink",
        site: { at: "layer", layer: "1.1" },
        label: "ghost",
        url: "does/not/exist.ts",
        path: "does/not/exist.ts",
      },
    ]);
  });

  it("holds a layer summary's references to the description's rule, naming the summary", () => {
    const artifact = validArtifact({
      layers: [
        {
          label: "Leaf",
          summary: "Reads `ghost` from [ghost](does/not/exist.ts)",
          ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toEqual([
      {
        kind: "unresolvedLink",
        site: { at: "layerSummary", layer: "1" },
        label: "ghost",
        url: "does/not/exist.ts",
        path: "does/not/exist.ts",
      },
    ]);
    expect(describeProblem(report.problems[0]!)).toContain("layer 1 summary");
  });

  it("quotes a dead reference as written, line suffix and side included", () => {
    const artifact = validArtifact({
      overview: {
        title: "Tour",
        body: "See [x](readme.md:250) and [y](src/gone.ts:3-4@deletions).",
      },
    });
    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems.map((problem) => describeProblem(problem))).toEqual([
      "overview body links [x](readme.md:250) — readme.md is not in the diff",
      "overview body links [y](src/gone.ts:3-4@deletions) — src/gone.ts is not in the diff",
    ]);
  });

  it("holds the overview's prose to the same dead-link rule as a layer description", () => {
    const artifact = validArtifact({
      overview: {
        title: "Tour",
        body: "Starts in [foo](src/foo.ts), then [nowhere](src/gone.ts).",
      },
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    // Only the unresolved one is a problem: the link that names a file in the diff
    // renders as a live chip and passes.
    expect(report.problems).toEqual([
      {
        kind: "unresolvedLink",
        site: { at: "overviewBody" },
        label: "nowhere",
        url: "src/gone.ts",
        path: "src/gone.ts",
      },
    ]);
  });

  it("passes an overview whose every reference resolves", () => {
    const artifact = validArtifact({
      overview: { title: "Tour", body: "Read [foo](src/foo.ts) first; `src/bar.ts` follows." },
    });

    expect(validate(JSON.stringify(artifact)).ok).toBe(true);
  });

  // The whole point of gating a line reference: it is the one "related location" that is
  // proven to exist in the change, on both sides, by the same resolver a comment uses.
  it("passes a line reference that places, on either side", () => {
    const artifact = validArtifact({
      overview: {
        title: "Tour",
        body: "Produced in [one](src/foo.ts:11-13), was [there](src/foo.ts:11@deletions).",
      },
    });

    expect(validate(JSON.stringify(artifact)).ok).toBe(true);
  });

  it("flags a line reference whose range no hunk covers, with a comment's own locator", () => {
    const artifact = validArtifact({
      overview: { title: "Tour", body: "The caller in [foo](src/foo.ts:50-51) never awaits it." },
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toEqual([
      {
        kind: "referenceOutdated",
        site: { at: "overviewBody" },
        anchor: { file: "src/foo.ts", side: "additions", startLine: 50, endLine: 51 },
        nearestHunks: [{ startLine: 10, endLine: 14 }],
      },
    ]);
  });

  // The file is in the diff, so the old reading — the suffix as part of the filename —
  // would have reported a missing file the author never named.
  it("flags a suffix that is not a line range as malformed, naming it as written", () => {
    const artifact = validArtifact({
      layers: [
        {
          label: "Leaf",
          summary: "child",
          description: "See [the caller](src/bar.ts:forty).",
          ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toEqual([
      {
        kind: "malformedReference",
        site: { at: "layer", layer: "1" },
        label: "the caller",
        url: "src/bar.ts:forty",
        why: "suffix",
      },
    ]);
  });

  // Only an inline `[label](path)` is a reference the gate checks and the postable rewrite
  // replaces, so a path behind a definition would pass both and post as a broken link. The form
  // is refused at every prose site, whichever way the definition is used.
  it("refuses a reference-style definition to a path, in every prose site", () => {
    const anchor = { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 } as const;
    const artifact = validArtifact({
      overview: {
        title: "Tour",
        body: "See [x][r] and [docs][].\n\n[r]: src/foo.ts:11\n[docs]: https://example.com",
      },
      comments: [
        { ...anchor, body: "note", postable: "See [src/foo.ts][].\n\n[src/foo.ts]: src/foo.ts" },
      ],
      layers: [
        {
          label: "Leaf",
          description: "See [lbl].\n\n[lbl]: src/gone.ts:x",
          ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    // The web definition is no reference and passes; each path one is refused as a form.
    expect(report.problems).toEqual([
      {
        kind: "malformedReference",
        site: { at: "overviewBody" },
        label: "r",
        url: "src/foo.ts:11",
        why: "definition",
      },
      {
        kind: "malformedReference",
        site: { at: "comment", anchor },
        label: "src/foo.ts",
        url: "src/foo.ts",
        why: "definition",
      },
      {
        kind: "malformedReference",
        site: { at: "layer", layer: "1" },
        label: "lbl",
        url: "src/gone.ts:x",
        why: "definition",
      },
    ]);
    expect(describeProblem(report.problems[0]!)).toBe(
      "overview body defines [r]: src/foo.ts:11 — write the reference inline: [label](path:lines)",
    );
  });

  // `postable` is the one comment prose the gate reads: once posted, a dead reference there is
  // a broken link on the code host rather than a muted chip in the app.
  it("holds a comment's postable to the reference rules, located by the comment's anchor", () => {
    const anchor = { file: "src/foo.ts", side: "additions", startLine: 11, endLine: 13 } as const;
    const artifact = validArtifact({
      comments: [
        {
          ...anchor,
          body: "A [dead chip](src/gone.ts) in the body is the reader's to see past.",
          postable:
            "See [foo](src/foo.ts:11), [nowhere](src/gone.ts), [far](src/foo.ts:50) and [typo](src/foo.ts:x).",
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    const site = { at: "comment", anchor };
    expect(report.problems).toEqual([
      { kind: "malformedReference", site, label: "typo", url: "src/foo.ts:x", why: "suffix" },
      { kind: "unresolvedLink", site, label: "nowhere", url: "src/gone.ts", path: "src/gone.ts" },
      {
        kind: "referenceOutdated",
        site,
        anchor: { file: "src/foo.ts", side: "additions", startLine: 50, endLine: 50 },
        nearestHunks: [{ startLine: 10, endLine: 14 }],
      },
    ]);
    expect(report.problems.map((problem) => describeProblem(problem))).toEqual([
      "postable of the comment at src/foo.ts additions 11-13 links [typo](src/foo.ts:x) — a line reference reads path:12, path:12-20 or path:12-20@deletions",
      "postable of the comment at src/foo.ts additions 11-13 links [nowhere](src/gone.ts) — src/gone.ts is not in the diff",
      "postable of the comment at src/foo.ts additions 11-13 references a line range that does not place in the diff: src/foo.ts additions 50-50 — it must sit inside one hunk; nearest on that side: 10-14",
    ]);
  });

  it("passes a postable whose every reference resolves, and a comment with none", () => {
    const artifact = validArtifact({
      comments: [
        {
          file: "src/foo.ts",
          side: "additions",
          startLine: 11,
          endLine: 13,
          body: "note",
          postable: "Could [this](src/foo.ts:11-13) await [the helper](src/bar.ts)?",
        },
        { file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2, body: "no postable" },
      ],
    });

    expect(validate(JSON.stringify(artifact)).ok).toBe(true);
  });

  it("flags a layer range outside any hunk and a layer range on an absent file as layerRangeOutdated", () => {
    const artifact = validArtifact({
      layers: [
        {
          label: "Drifted",
          summary: "range past the hunk",
          ranges: [{ file: "src/foo.ts", side: "additions", startLine: 90, endLine: 90 }],
        },
        {
          label: "Absent",
          summary: "range on a file not in the diff",
          ranges: [{ file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 }],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    // A file absent from the patch funnels through the same `null` fileDiff path as an
    // out-of-hunk range, so both surface as layerRangeOutdated at the layer's ordinal.
    expect(report.problems).toContainEqual({
      kind: "layerRangeOutdated",
      layer: "1",
      range: 1,
      anchor: { file: "src/foo.ts", side: "additions", startLine: 90, endLine: 90 },
      nearestHunks: [{ startLine: 10, endLine: 14 }],
    });
    expect(report.problems).toContainEqual({
      kind: "layerRangeOutdated",
      layer: "2",
      range: 1,
      anchor: { file: "src/gone.ts", side: "additions", startLine: 1, endLine: 1 },
      nearestHunks: null,
    });
  });

  it("places a whole-file range iff its file is in the diff, and names the nearest changed paths when not", () => {
    const artifact = validArtifact({
      layers: [
        {
          label: "Own foo outright",
          ranges: [{ file: "src/foo.ts", note: "all of it" }],
          // A focus anywhere in the file overlaps a whole-file range — no line range needed.
          focus: { file: "src/foo.ts", side: "deletions", startLine: 11, endLine: 11 },
        },
        { label: "A typo", ranges: [{ file: "src/bar.tsx" }, { file: "lib/bar.ts" }] },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toEqual([
      {
        kind: "layerFileAbsent",
        layer: "2",
        range: 1,
        file: "src/bar.tsx",
        nearestFiles: ["src/foo.ts", "src/bar.ts"],
      },
      {
        kind: "layerFileAbsent",
        layer: "2",
        range: 2,
        file: "lib/bar.ts",
        // Same file name ranks first: the commonest wrong path is the right file in the wrong place.
        nearestFiles: ["src/bar.ts", "src/foo.ts"],
      },
    ]);
    expect(describeProblem(report.problems[1] as ValidationProblem)).toBe(
      "layer 2, range 2 names lib/bar.ts, which is not in the diff; changed files nearest that path: src/bar.ts, src/foo.ts",
    );
  });

  it("refuses a line range missing a key rather than reading it as a whole-file range", () => {
    const artifact = validArtifact({
      layers: [
        {
          label: "Half a range",
          ranges: [{ file: "src/foo.ts", side: "additions", startLine: 11 } as never],
        },
      ],
    });
    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(kinds(report.problems)).toEqual(["schema"]);
    expect(describeProblem(report.problems[0] as ValidationProblem)).toContain("endLine");
  });

  it("names a nested layer by its ordinal path, the section number the reader will see", () => {
    const artifact = validArtifact({
      layers: [
        {
          label: "First",
          ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
        },
        {
          label: "Second",
          children: [
            {
              label: "A",
              ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
            },
            {
              label: "B",
              ranges: [{ file: "src/foo.ts", side: "additions", startLine: 90, endLine: 90 }],
            },
          ],
        },
      ],
    });

    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toEqual([
      {
        kind: "layerRangeOutdated",
        layer: "2.2",
        range: 1,
        anchor: { file: "src/foo.ts", side: "additions", startLine: 90, endLine: 90 },
        nearestHunks: [{ startLine: 10, endLine: 14 }],
      },
    ]);
  });

  // The hint is the part of a refusal that saves a round trip: without it the author's next
  // call is `rvw diff`, to read off numbers the gate was already holding.
  it("says where a misplaced anchor would place, so the fix needs no second look at the diff", () => {
    const artifact = validArtifact({
      patch: TWO_HUNKS_PATCH,
      comments: [
        { file: "src/two-hunks.txt", side: "additions", startLine: 5, endLine: 28, body: "note" },
      ],
      layers: [],
    });
    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems.map((problem) => describeProblem(problem))).toEqual([
      "comment anchor does not place in the diff: src/two-hunks.txt additions 5-28 — it must sit inside one hunk; nearest on that side: 1-6, 27-33",
    ]);
  });

  it("names only the hunks nearest the authored lines, in file order, however many the file has", () => {
    const artifact = validArtifact({
      patch: buildManyHunksPatch(40),
      comments: [
        { file: "src/many-hunks.ts", side: "additions", startLine: 401, endLine: 402, body: "n" },
      ],
      layers: [],
    });
    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    // Hunks sit at 10, 30, 50…; the four nearest 401-402 are 370, 390, 410 and 430.
    expect(report.problems).toEqual([
      {
        kind: "commentAnchorOutdated",
        anchor: { file: "src/many-hunks.ts", side: "additions", startLine: 401, endLine: 402 },
        nearestHunks: [370, 390, 410, 430].map((line) => ({ startLine: line, endLine: line })),
      },
    ]);
  });

  it("tells a file with nothing on that side, and a file that is not there, from a wrong line", () => {
    const artifact = validArtifact({
      patch: MULTI_STATUS_PATCH,
      comments: [],
      layers: [
        {
          label: "Removed",
          ranges: [
            { file: "doomed.txt", side: "additions", startLine: 1, endLine: 1 },
            { file: "never.txt", side: "additions", startLine: 1, endLine: 1 },
          ],
        },
      ],
    });
    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems.map((problem) => describeProblem(problem))).toEqual([
      "layer 1, range 1 does not place in the diff: doomed.txt additions 1-1 — that file has no hunk on that side",
      "layer 1, range 2 does not place in the diff: never.txt additions 1-1 — that file is not in the diff",
    ]);
  });

  it("reports non-JSON bytes as a typed problem without throwing", () => {
    const report = validate("}{ not json");
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(kinds(report.problems)).toEqual(["invalidJson"]);
  });

  it("reports a bad side enum as a schema problem on the offending path without throwing", () => {
    const artifact = {
      ...validArtifact(),
      comments: [{ file: "src/foo.ts", side: "old", startLine: 11, endLine: 13, body: "bad" }],
    };
    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toContainEqual(
      expect.objectContaining({ kind: "schema", path: "comments#1.side" }),
    );
  });

  it("reports a descending range as a schema problem, at the endLine that has to change", () => {
    // A valid side isolates the range refine: `side: "old"` would fail the enum first
    // and short-circuit before `rangeIsAscending` ever runs (review.ts), so this is the
    // only fixture that proves a descending range is rejected on its own.
    const artifact = {
      ...validArtifact(),
      comments: [
        { file: "src/foo.ts", side: "additions", startLine: 13, endLine: 11, body: "bad" },
      ],
    };
    const report = validate(JSON.stringify(artifact));
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(report.problems).toContainEqual(
      expect.objectContaining({ kind: "schema", path: "comments#1.endLine" }),
    );
  });

  it("reports a diff with no changes as the missing-patch problem", () => {
    // A patch that parses to no file has no diff to place anchors against; an absent one
    // (JSON.stringify drops the `undefined`) takes the same route.
    expect(validate(JSON.stringify({ ...validArtifact(), patch: undefined }))).toEqual({
      ok: false,
      problems: [{ kind: "missingPatch" }],
    });
  });
});

// What is left of the outline contract once `children` carries the shape: a depth the
// reader can follow, and every layer reaching some code. Dangling parents, cycles, and a
// mis-ordered array are gone — nesting cannot express them.
describe("the outline contract", () => {
  const group = (label: string, children: ReviewLayerDraft[] = []): ReviewLayerDraft => ({
    label,
    summary: "a theme",
    children,
  });
  const stop = (label = "Child", children: ReviewLayerDraft[] = []): ReviewLayerDraft => ({
    label,
    summary: "the code",
    ranges: [{ file: "src/bar.ts", side: "additions" as const, startLine: 2, endLine: 2 }],
    children,
  });

  const problemsFor = (layers: ReviewLayerDraft[]): ValidationProblem[] => {
    const report = validate(JSON.stringify(validArtifact({ layers })));
    return report.ok ? [] : report.problems;
  };

  it("accepts a nested tree", () => {
    expect(problemsFor([group("Group", [group("Inner", [stop()])]), stop("After")])).toEqual([]);
  });

  it("accepts a parent that carries ranges of its own — extent is own plus descendants'", () => {
    expect(problemsFor([stop("Parent", [stop()])])).toEqual([]);
  });

  it("refuses nesting past the depth cap, naming the shallowest offender once per chain", () => {
    // Eight levels: five legal, then three that are not. One authoring mistake reads as one
    // problem — the first layer past the cap — rather than one per layer below it, which
    // would hand an agent the same fix three times over.
    const chain = group("l1", [
      group("l2", [
        group("l3", [group("l4", [group("l5", [group("l6", [group("l7", [stop("l8")])])])])]),
      ]),
    ]);
    expect(problemsFor([chain])).toEqual([
      { kind: "nestingTooDeep", layer: "1.1.1.1.1.1", depth: 6 },
    ]);

    // Once per *chain*, not once per outline: a layer that branches below the cap is two
    // separate things to unnest, and an agent told about only the first would have to re-run
    // the gate to discover the second.
    const branching = group("l1", [
      group("l2", [group("l3", [group("l4", [group("l5", [stop("l6a"), stop("l6b")])])])]),
    ]);
    expect(problemsFor([branching])).toEqual([
      { kind: "nestingTooDeep", layer: "1.1.1.1.1.1", depth: 6 },
      { kind: "nestingTooDeep", layer: "1.1.1.1.1.2", depth: 6 },
    ]);
  });

  it("refuses a layer that reaches no code at all, at any depth", () => {
    // A range-less layer is fine when something under it has ranges; alone it is an
    // outline entry with no review behind it.
    expect(problemsFor([group("Group", [stop()])])).toEqual([]);
    expect(problemsFor([group("Group"), stop("Elsewhere")])).toContainEqual({
      kind: "layerWalksNothing",
      layer: "1",
    });
    expect(problemsFor([group("Group", [group("Inner")]), stop("Elsewhere")])).toContainEqual({
      kind: "layerWalksNothing",
      layer: "1.1",
    });
  });
});

// The guide's visuals and a layer's focus: every claim a picture makes about the diff is held
// to the same placement rule as a layer range, and the shape rules zod cannot state are
// checked with the outline, before any diff.
describe("visuals and focus", () => {
  const foo = (startLine: number, endLine = startLine) => ({
    file: "src/foo.ts",
    side: "additions" as const,
    startLine,
    endLine,
  });
  const bar = { file: "src/bar.ts", side: "additions" as const, startLine: 2, endLine: 2 };

  const flow = (nodes: FlowNode[], edges: { from: string; to: string }[]) => ({
    kind: "flow" as const,
    caption: "How a call reaches bar",
    nodes,
    edges,
  });

  const placedFlow = flow(
    [
      { id: "caller", label: "caller()", status: "same" },
      { id: "foo", label: "foo()", status: "changed", at: foo(11, 13) },
      { id: "bar", label: "bar()", status: "added", note: "new", at: bar },
    ],
    [
      { from: "caller", to: "foo" },
      { from: "foo", to: "bar" },
    ],
  );

  const placedSkeleton = {
    kind: "skeleton" as const,
    caption: "What foo now does",
    lines: [
      { depth: 0, code: "foo()", status: "same" as const },
      {
        depth: 1,
        code: "old11()",
        status: "removed" as const,
        at: { file: "src/foo.ts", side: "deletions" as const, startLine: 11, endLine: 11 },
      },
      { depth: 1, code: "new11()", status: "added" as const, at: foo(11) },
    ],
  };

  const reportFor = (overrides: Partial<Draft>): ValidationProblem[] => {
    const report = validate(JSON.stringify(validArtifact(overrides)));
    return report.ok ? [] : report.problems;
  };

  const withLayerExtras = (extras: object): Partial<Draft> => ({
    layers: [
      {
        label: "Leaf",
        ranges: [bar],
        ...extras,
      },
    ],
  });

  it("passes a guide whose every element and focus places", () => {
    expect(
      reportFor({
        overview: {
          title: "Bar joins the call",
          lede: "Calls to [foo](src/foo.ts:11) now reach `bar()`.",
          steps: ["`foo()` calls `bar()`", "[bar](src/bar.ts:2) is new"],
          visual: placedFlow,
        },
        ...withLayerExtras({ visual: placedSkeleton, focus: bar }),
      }),
    ).toEqual([]);
  });

  it("places every `at` by the current path, with the nearest hunks, naming node and line", () => {
    const problems = reportFor({
      overview: {
        title: "t",
        visual: flow(
          [
            { id: "a", label: "a()", status: "same", at: foo(40) },
            { id: "b", label: "b()", status: "added", at: { ...bar, file: "src/gone.ts" } },
          ],
          [{ from: "a", to: "b" }],
        ),
      },
      ...withLayerExtras({
        visual: {
          ...placedSkeleton,
          lines: [placedSkeleton.lines[0], { ...placedSkeleton.lines[2], at: foo(30) }],
        },
      }),
    });
    expect(problems).toEqual([
      {
        kind: "visualAnchorOutdated",
        visual: { at: "overview" },
        element: { kind: "node", id: "a" },
        anchor: foo(40),
        nearestHunks: [{ startLine: 10, endLine: 14 }],
      },
      {
        kind: "visualAnchorOutdated",
        visual: { at: "overview" },
        element: { kind: "node", id: "b" },
        anchor: { ...bar, file: "src/gone.ts" },
        nearestHunks: null,
      },
      {
        kind: "visualAnchorOutdated",
        visual: { at: "layer", layer: "1" },
        element: { kind: "line", line: 2 },
        anchor: foo(30),
        nearestHunks: [{ startLine: 10, endLine: 14 }],
      },
    ]);
    expect(problems.map((problem) => describeProblem(problem))).toEqual([
      'overview visual, node "a" has an `at` that does not place in the diff: src/foo.ts additions 40-40 — it must sit inside one hunk; nearest on that side: 10-14',
      'overview visual, node "b" has an `at` that does not place in the diff: src/gone.ts additions 2-2 — that file is not in the diff',
      "layer 1 visual, line 2 has an `at` that does not place in the diff: src/foo.ts additions 30-30 — it must sit inside one hunk; nearest on that side: 10-14",
    ]);
  });

  it("refuses a focus that does not place, by its layer's ordinal", () => {
    // Inside the layer's extent — it overlaps the range — but running out of the hunk.
    const problems = reportFor({
      layers: [{ label: "Leaf", ranges: [foo(11, 13)], focus: foo(8, 12) }],
    });
    expect(problems).toEqual([
      {
        kind: "layerFocusOutdated",
        layer: "1",
        anchor: foo(8, 12),
        nearestHunks: [{ startLine: 10, endLine: 14 }],
      },
    ]);
    expect(describeProblem(problems[0] as ValidationProblem)).toBe(
      "layer 1 focus does not place in the diff: src/foo.ts additions 8-12 — it must sit inside one hunk; nearest on that side: 10-14",
    );
  });

  it("refuses a focus outside its layer's extent, and accepts one a child's range carries", () => {
    const deletions = { ...foo(11), side: "deletions" as const };
    const problems = reportFor({
      layers: [
        // A sibling's file, and the right lines on the wrong side: neither is this layer's.
        { label: "Leaf", ranges: [bar], focus: foo(11, 13) },
        { label: "Other", ranges: [foo(11, 13)], focus: deletions },
        // A parent's extent is its own ranges plus its children's.
        { label: "Group", focus: bar, children: [{ label: "Child", ranges: [bar] }] },
      ],
    });
    expect(problems).toEqual([
      { kind: "layerFocusOutsideLayer", layer: "1", anchor: foo(11, 13), owner: "2" },
      { kind: "layerFocusOutsideLayer", layer: "2", anchor: deletions, owner: null },
    ]);
    expect(describeProblem(problems[0] as ValidationProblem)).toBe(
      "layer 1 focus src/foo.ts additions 11-13 belongs to layer 2, whose ranges claim those lines more specifically (deeper, or a line range over a whole-file one) — the guide would badge it 2; point it at lines this layer owns, or move those lines into its ranges",
    );
    expect(describeProblem(problems[1] as ValidationProblem)).toBe(
      "layer 2 focus src/foo.ts deletions 11-11 is outside the layer — no layer's ranges cover it; a focus must be lines this layer or one under it owns, so point it at this chapter's code, or add those lines to its ranges",
    );
  });

  it("holds a focus to the layer that owns its lines, the rule the guide badges by", () => {
    // Siblings sharing foo.ts: `Whole` writes it `{ file }`, `Lines` claims 11-13. Overlap alone
    // passed `Whole`'s focus on 12 — its whole-file range overlaps everything — while the guide
    // badged that excerpt `02`. Ownership refuses it and names the owner.
    const problems = reportFor({
      layers: [
        { label: "Whole", ranges: [{ file: "src/foo.ts" }], focus: foo(12) },
        { label: "Lines", ranges: [foo(11, 13)], focus: foo(12) },
        { label: "Rest", ranges: [{ file: "src/bar.ts" }], focus: bar },
      ],
    });
    expect(problems).toEqual([
      { kind: "layerFocusOutsideLayer", layer: "1", anchor: foo(12), owner: "2" },
    ]);
    // The line range wins at equal depth whichever comes first, and the whole-file sibling keeps
    // every line no line range claims — a focus on 10, a context line, is its own.
    expect(
      reportFor({
        layers: [
          { label: "Lines", ranges: [foo(11, 13)] },
          { label: "Whole", ranges: [{ file: "src/foo.ts" }], focus: foo(10) },
        ],
      }),
    ).toEqual([]);
  });

  it("accepts a focus a descendant owns, and refuses one a deeper layer elsewhere owns", () => {
    const problems = reportFor({
      layers: [
        // The group's focus is owned by its own child: the group's extent, so its excerpt.
        {
          label: "Group",
          ranges: [{ file: "src/foo.ts" }],
          focus: foo(12),
          children: [{ label: "Part", ranges: [foo(11, 13)] }],
        },
        // A whole-file range on foo.ts too, but those lines are 1.1's — deeper wins.
        { label: "Other", ranges: [{ file: "src/foo.ts" }, bar], focus: foo(11, 12) },
      ],
    });
    expect(problems).toEqual([
      { kind: "layerFocusOutsideLayer", layer: "2", anchor: foo(11, 12), owner: "1.1" },
    ]);
  });

  it("holds a focus and an `at` on a pre-rename path to the range rule, not the comment one", () => {
    // The comment beside them places on the old name; these do not, because the excerpt and
    // the chapter badge both find a file by its current path, as the layer scroll does.
    const oldName = {
      file: "src/old-edit.txt",
      side: "deletions" as const,
      startLine: 2,
      endLine: 2,
    };
    const problems = reportFor({
      patch: RENAMES_PATCH,
      comments: [{ ...oldName, body: "note" }],
      layers: [
        {
          label: "Rename",
          // The range sits on the old name too, so the focus is inside the layer's extent and
          // the only thing left to say about it is where it places.
          ranges: [oldName],
          focus: oldName,
          visual: {
            kind: "skeleton",
            caption: "c",
            lines: [
              { depth: 0, code: "x()", status: "same" },
              { depth: 0, code: "y()", status: "removed", at: oldName },
            ],
          },
        },
      ],
    });
    expect(kinds(problems)).toEqual([
      "layerRangeOutdated",
      "layerFocusOutdated",
      "visualAnchorOutdated",
    ]);
  });

  it("requires `at` on every element that claims a change, before any diff is read", () => {
    const problems = reportFor({
      overview: {
        title: "t",
        visual: flow(
          [
            { id: "a", label: "a()", status: "same" },
            { id: "b", label: "b()", status: "changed" },
            { id: "c", label: "c()", status: "removed" },
          ],
          [{ from: "a", to: "b" }],
        ),
      },
      ...withLayerExtras({
        visual: {
          kind: "skeleton",
          caption: "c",
          lines: [
            { depth: 0, code: "x()", status: "same" },
            { depth: 1, code: "y()", status: "added" },
          ],
        },
      }),
    });
    expect(problems).toEqual([
      {
        kind: "visualElementUnanchored",
        visual: { at: "overview" },
        element: { kind: "node", id: "b" },
      },
      {
        kind: "visualElementUnanchored",
        visual: { at: "overview" },
        element: { kind: "node", id: "c" },
      },
      {
        kind: "visualElementUnanchored",
        visual: { at: "layer", layer: "1" },
        element: { kind: "line", line: 2 },
      },
    ]);
    expect(describeProblem(problems[2] as ValidationProblem)).toBe(
      "layer 1 visual, line 2 is marked as a change but has no `at` — a changed element must point at its code",
    );
  });

  it("refuses duplicate node ids, edges to missing nodes, and self-loops, once each", () => {
    const problems = reportFor({
      overview: {
        title: "t",
        visual: flow(
          [
            { id: "a", label: "a()", status: "same" },
            { id: "a", label: "a again", status: "same" },
            { id: "b", label: "b()", status: "same" },
          ],
          [
            { from: "a", to: "b" },
            { from: "ghost", to: "phantom" },
            { from: "b", to: "b" },
          ],
        ),
      },
    });
    const dangling = { from: "ghost", to: "phantom" };
    expect(problems).toEqual([
      { kind: "flowNodeIdDuplicate", visual: { at: "overview" }, id: "a" },
      { kind: "flowEdgeDangling", visual: { at: "overview" }, ...dangling, id: "ghost" },
      { kind: "flowEdgeDangling", visual: { at: "overview" }, ...dangling, id: "phantom" },
      { kind: "flowEdgeSelfLoop", visual: { at: "overview" }, id: "b" },
    ]);
    // An edge is named by the two ids it joins, as the author reads it — not by a position.
    expect(problems.map((problem) => describeProblem(problem))).toEqual([
      'overview visual has two nodes with id "a" — node ids must be unique',
      'overview visual, edge ghost→phantom names node "ghost", which is not in its nodes',
      'overview visual, edge ghost→phantom names node "phantom", which is not in its nodes',
      'overview visual, edge b→b joins node "b" to itself',
    ]);
  });

  it("holds the lede and each step to the reference rules, located by step number", () => {
    const problems = reportFor({
      overview: {
        title: "t",
        lede: "See [gone](src/gone.ts).",
        steps: ["fine", "[far](src/foo.ts:90)"],
      },
    });
    expect(problems.map((problem) => describeProblem(problem))).toEqual([
      "overview lede links [gone](src/gone.ts) — src/gone.ts is not in the diff",
      "overview step 2 references a line range that does not place in the diff: src/foo.ts additions 90-90 — it must sit inside one hunk; nearest on that side: 10-14",
    ]);
  });

  it("holds a placed `at` to its status: side first, then at least one claimed line", () => {
    const deletions = (startLine: number, endLine = startLine) => ({
      ...foo(startLine, endLine),
      side: "deletions" as const,
    });
    const problems = reportFor({
      overview: {
        title: "t",
        visual: flow(
          [
            // Wrong side: an added box pointing at the old file, a removed one at the new.
            { id: "a", label: "a()", status: "added", at: deletions(11) },
            { id: "r", label: "r()", status: "removed", at: foo(11) },
            // Right side, context only: placeable, and not what the status claims.
            { id: "c", label: "c()", status: "added", at: foo(10) },
            { id: "d", label: "d()", status: "changed", at: deletions(12, 12) },
            // Agreeing: a changed node may be mostly context, on either side.
            { id: "ok", label: "ok()", status: "changed", at: deletions(10, 11) },
            // `same` claims nothing, wherever it places.
            { id: "s", label: "s()", status: "same", at: foo(12) },
          ],
          [{ from: "a", to: "r" }],
        ),
      },
    });
    expect(problems).toEqual([
      {
        kind: "visualStatusWrongSide",
        visual: { at: "overview" },
        element: { kind: "node", id: "a" },
        status: "added",
        anchor: deletions(11),
      },
      {
        kind: "visualStatusWrongSide",
        visual: { at: "overview" },
        element: { kind: "node", id: "r" },
        status: "removed",
        anchor: foo(11),
      },
      {
        kind: "visualStatusOnContext",
        visual: { at: "overview" },
        element: { kind: "node", id: "c" },
        status: "added",
        anchor: foo(10),
        changedRuns: [{ startLine: 11, endLine: 13 }],
      },
      {
        kind: "visualStatusOnContext",
        visual: { at: "overview" },
        element: { kind: "node", id: "d" },
        status: "changed",
        anchor: deletions(12),
        changedRuns: [{ startLine: 11, endLine: 11 }],
      },
    ]);
    expect(problems.map((problem) => describeProblem(problem))).toEqual([
      'overview visual, node "a" is added but its `at` is on the deletions side — an added node must point at added lines, on additions',
      'overview visual, node "r" is removed but its `at` is on the additions side — a removed node must point at removed lines, on deletions',
      'overview visual, node "c" is added but src/foo.ts additions 10-10 is all context — an added node must point at added lines, on additions; nearest changed lines on that side: 11-13',
      'overview visual, node "d" is changed but src/foo.ts deletions 12-12 is all context — a changed node must point at a range holding at least one changed line; nearest changed lines on that side: 11-11',
    ]);
  });

  it("holds a skeleton line to the same status rule, named by its position", () => {
    const problems = reportFor(
      withLayerExtras({
        visual: {
          ...placedSkeleton,
          lines: [placedSkeleton.lines[0], { ...placedSkeleton.lines[2], at: foo(14) }],
        },
      }),
    );
    expect(problems.map((problem) => describeProblem(problem))).toEqual([
      "layer 1 visual, line 2 is added but src/foo.ts additions 14-14 is all context — an added skeleton line must point at added lines, on additions; nearest changed lines on that side: 11-13",
    ]);
  });

  it("lets an edge carry an `at`, placed and held to its status, but never requires one", () => {
    const edges = [
      // Unanchored, even though added: the boxes either side already carry the proof.
      { from: "caller", to: "foo", status: "added" as const },
      // Anchored at the call site: placed, and an added edge on added lines.
      { from: "foo", to: "bar", status: "added" as const, at: foo(12) },
    ];
    expect(reportFor({ overview: { title: "t", visual: { ...placedFlow, edges } } })).toEqual([]);

    const problems = reportFor({
      overview: {
        title: "t",
        visual: {
          ...placedFlow,
          edges: [
            { from: "caller", to: "foo", at: foo(40) },
            { from: "foo", to: "bar", status: "added", at: foo(10) },
          ],
        },
      },
    });
    expect(problems.map((problem) => describeProblem(problem))).toEqual([
      "overview visual, edge caller→foo has an `at` that does not place in the diff: src/foo.ts additions 40-40 — it must sit inside one hunk; nearest on that side: 10-14",
      "overview visual, edge foo→bar is added but src/foo.ts additions 10-10 is all context — an added edge must point at added lines, on additions; nearest changed lines on that side: 11-13",
    ]);
  });

  it("refuses markdown in a visual's plain text, but not code that only looks like it", () => {
    const problems = reportFor({
      overview: {
        title: "t",
        visual: {
          kind: "flow",
          caption: "How **bar** joins",
          nodes: [
            { id: "a", label: "`a()`", status: "same", note: "f(**kwargs) is fine" },
            { id: "b", label: "a ** b * c", status: "same", note: "a `tick` here" },
          ],
          edges: [{ from: "a", to: "b", label: "`x`" }],
        },
      },
      ...withLayerExtras({
        visual: {
          kind: "skeleton",
          caption: "c",
          lines: [
            { depth: 0, code: "def f(*args, **kwargs)", status: "same" },
            { depth: 1, code: "**g()**", status: "same" },
            // Source: a template literal inside the call is syntax, not a code span...
            { depth: 1, code: "log(`hi ${name}`)", status: "same" },
            // ...but the whole line wrapped is the habit.
            { depth: 1, code: "`h()`", status: "same" },
          ],
        },
      }),
    });
    expect(problems).toEqual([
      {
        kind: "visualTextMarkup",
        visual: { at: "overview" },
        text: { field: "caption" },
        markup: "strong",
      },
      {
        kind: "visualTextMarkup",
        visual: { at: "overview" },
        text: { field: "label", element: { kind: "node", id: "a" } },
        markup: "code",
      },
      {
        kind: "visualTextMarkup",
        visual: { at: "overview" },
        text: { field: "note", element: { kind: "node", id: "b" } },
        markup: "code",
      },
      {
        kind: "visualTextMarkup",
        visual: { at: "overview" },
        text: { field: "label", element: { kind: "edge", from: "a", to: "b" } },
        markup: "code",
      },
      {
        kind: "visualTextMarkup",
        visual: { at: "layer", layer: "1" },
        text: { field: "code", element: { kind: "line", line: 2 } },
        markup: "strong",
      },
      {
        kind: "visualTextMarkup",
        visual: { at: "layer", layer: "1" },
        text: { field: "code", element: { kind: "line", line: 4 } },
        markup: "code",
      },
    ]);
    expect(describeProblem(problems[1] as ValidationProblem)).toBe(
      'overview visual, node "a" label has a `code` span — visual text is plain and drawn as-is, so the backticks would show; write the symbol bare',
    );
    expect(describeProblem(problems[0] as ValidationProblem)).toBe(
      "overview visual caption has **bold** — visual text is plain and drawn as-is, so the asterisks would show; the status already marks what changed",
    );
  });

  it('teaches the fix when a skeleton line or an edge is marked "changed"', () => {
    const report = validate(
      JSON.stringify({
        ...validArtifact(),
        overview: {
          title: "t",
          visual: {
            ...placedFlow,
            edges: [{ from: "caller", to: "foo", status: "changed" }],
          },
        },
        layers: [
          {
            label: "Leaf",
            ranges: [bar],
            visual: {
              ...placedSkeleton,
              lines: [
                { depth: 0, code: "foo()", status: "changed", at: foo(11) },
                placedSkeleton.lines[0],
              ],
            },
          },
        ],
      }),
    );
    expect(report.ok ? [] : report.problems.map((problem) => describeProblem(problem))).toEqual([
      'schema: overview.visual.edges#1.status — an edge is "added", "removed" or "same"; show a rewired call as a removed edge beside an added one',
      'schema: layers#1.visual.lines#1.status — a skeleton line is "added", "removed" or "same"; show a change as a removed line beside an added one',
    ]);
  });

  it("puts the limits in the schema: counts, lengths, one line, slug ids", () => {
    const schemaPaths = (overview: unknown): string[] => {
      const report = validate(JSON.stringify({ ...validArtifact(), overview }));
      return report.ok
        ? []
        : report.problems.flatMap((problem) => (problem.kind === "schema" ? [problem.path] : []));
    };
    expect(schemaPaths({ title: "t", steps: ["only one"] })).toEqual(["overview.steps"]);
    expect(schemaPaths({ title: "t", lede: "two\nlines" })).toEqual(["overview.lede"]);
    expect(schemaPaths({ title: "t", lede: "x".repeat(221) })).toEqual(["overview.lede"]);
    expect(schemaPaths({ title: "t", lede: "x".repeat(220) })).toEqual([]);
    expect(schemaPaths({ title: "t", steps: ["x".repeat(111), "y"] })).toEqual([
      "overview.steps#1",
    ]);
    expect(schemaPaths({ title: "t", steps: ["x".repeat(110), "y"] })).toEqual([]);
    expect(
      schemaPaths({
        title: "t",
        visual: flow(
          [
            { id: "has space", label: "a", status: "same" },
            { id: "b", label: "x".repeat(41), status: "same" },
          ],
          [{ from: "a", to: "b" }],
        ),
      }),
    ).toEqual(["overview.visual.nodes#1.id", "overview.visual.nodes#2.label"]);
    expect(
      schemaPaths({
        title: "t",
        visual: {
          kind: "skeleton",
          caption: "c",
          lines: [{ depth: 7, code: "x", status: "same" }],
        },
      }),
    ).toEqual(["overview.visual.lines#1.depth", "overview.visual.lines"]);
    expect(schemaPaths({ title: "t", visual: { kind: "chart", caption: "c" } })).toEqual([
      "overview.visual.kind",
    ]);
  });
});

describe("inline prose", () => {
  it("refuses block markdown in the lede, a step or a layer summary, and teaches the marker", () => {
    const report = validate(
      JSON.stringify(
        validArtifact({
          overview: {
            title: "t",
            lede: "# Retries back off per host",
            steps: [
              "1. Parse the config",
              "Reads go through `withRetry` in [bar](src/bar.ts)",
              "> the queue drains first",
              "---",
              "    indented()",
            ],
          },
          layers: [
            {
              label: "Leaf",
              summary: "- retries per host",
              ranges: [{ file: "src/bar.ts", side: "additions", startLine: 2, endLine: 2 }],
              children: [
                {
                  label: "Part",
                  // Not blocks: `#` needs a space, and a `C#` or a `>=` mid-line is a word.
                  summary: "#hashtag, C# and a >= b are all plain",
                  ranges: [{ file: "src/bar.ts" }],
                },
              ],
            },
          ],
        }),
      ),
    );
    const problems = report.ok ? [] : report.problems;
    expect(problems).toEqual([
      { kind: "proseBlockMarkup", site: { at: "overviewLede" }, markup: "heading" },
      { kind: "proseBlockMarkup", site: { at: "overviewStep", step: 1 }, markup: "list" },
      { kind: "proseBlockMarkup", site: { at: "overviewStep", step: 3 }, markup: "blockquote" },
      { kind: "proseBlockMarkup", site: { at: "overviewStep", step: 4 }, markup: "thematicBreak" },
      { kind: "proseBlockMarkup", site: { at: "overviewStep", step: 5 }, markup: "code" },
      { kind: "proseBlockMarkup", site: { at: "layerSummary", layer: "1" }, markup: "list" },
    ]);
    expect(describeProblem(problems[1] as ValidationProblem)).toBe(
      "overview step 1 starts with a list marker (`-`, `*`, `+`, `1.` or `1)`), which makes it a list — the app numbers steps itself — it is drawn inline, on one line, where a block breaks the layout; keep it to text, code spans and references, or escape the marker with a backslash",
    );
    expect(describeProblem(problems[0] as ValidationProblem)).toBe(
      "overview lede starts with `#`, which makes it a heading — it is drawn inline, on one line, where a block breaks the layout; keep it to text, code spans and references, or escape the marker with a backslash",
    );
  });

  it("accepts the escaped marker the hint suggests", () => {
    const report = validate(
      JSON.stringify(
        validArtifact({
          overview: { title: "t", lede: "\\# not a heading", steps: ["1\\. one", "two"] },
        }),
      ),
    );
    expect(report).toEqual({ ok: true });
  });
});
