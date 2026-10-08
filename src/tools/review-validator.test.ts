import { describe, expect, it } from "vitest";
import type { ReviewArtifact, ReviewLayerDraft } from "../shared/review";
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
    expect(report.problems.map(describeProblem)).toEqual([
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
        site: { at: "overview" },
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
        site: { at: "overview" },
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
        site: { at: "overview" },
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
    expect(report.problems.map(describeProblem)).toEqual([
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
    expect(report.problems.map(describeProblem)).toEqual([
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
    expect(report.problems.map(describeProblem)).toEqual([
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
      expect.objectContaining({ kind: "schema", path: "comments[0].side" }),
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
      expect.objectContaining({ kind: "schema", path: "comments[0].endLine" }),
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
