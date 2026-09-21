import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// One rule about how the tour doc is closed and opened, held against the source because
// nothing else can hold it.
//
// A *trip* (`slice.ts`'s `docTrip`) starts when the document closes and ends on the reader's
// next navigation. Both halves are one expression, `leaveDoc(slice)`, spread by every action
// that targets the diff. An action that wrote `overviewOpen: false` by hand instead would
// typecheck, pass every test about where it lands, leave the document exactly as it should —
// and never end a trip, so the rail would keep offering "back to where you were" to a reader
// who has plainly moved on. The mirror failure for `overviewOpen: true` is a return planned
// after the solo it depends on was cleared (`enterDoc`).
//
// The types cannot see either: the literal is a perfectly good `Partial<SessionSlice>`. So the
// spelling is the thing asserted — the literal appears where the helpers and the defaults
// live, and nowhere else. The preview harness seeds an open document and is the one other
// file allowed to say so.

const RENDERER_ROOT = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

function filesWriting(literal: RegExp): string[] {
  return sourceFiles(RENDERER_ROOT)
    .filter((path) => literal.test(readFileSync(path, "utf8")))
    .map((path) => relative(RENDERER_ROOT, path))
    .toSorted();
}

describe("the tour doc's trip", () => {
  it("closing the doc is spelled leaveDoc: the literal lives in slice.ts and the factory only", () => {
    expect(filesWriting(/overviewOpen:\s*false/u)).toEqual([
      "stores/review/slice-factory.ts",
      "stores/review/slice.ts",
    ]);
  });

  it("opening it is spelled enterDoc: the literal lives in slice.ts and the preview seeds only", () => {
    expect(filesWriting(/overviewOpen:\s*true/u)).toEqual([
      "dev/preview.ts",
      "stores/review/slice.ts",
    ]);
  });

  it("every store module that leaves the doc does so through the helper", () => {
    // The floor under the two rules above: they would also pass if the helper were deleted
    // and the field never written at all.
    for (const file of ["stores/review/walkthrough.ts", "stores/review/progress.ts"]) {
      expect(readFileSync(join(RENDERER_ROOT, file), "utf8"), file).toMatch(
        /\.\.\.leaveDoc\(slice\)/u,
      );
    }
  });
});
