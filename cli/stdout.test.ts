import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BULK_COVERABLE_LINES,
  bulkyRepo,
  installBundle,
  rvw,
  type ForeignRepo,
  type InstalledCli,
} from "./fixtures";
import { capturePatch } from "./git";

// Everything a verb writes has to survive the pipe. This is the one property the rest of the
// CLI suite cannot check: on macOS — the only platform Reviewer ships for — stdout to a *pipe*
// is asynchronous, and the entrypoint used to end the run with `process.exit()`, which tears
// the process down without flushing it. Anything past the 64 KB pipe buffer was discarded,
// exit 0, no warning. A redirect to a *file* is synchronous and was never affected, so a test
// that captures stdout into a file would pass with the bug fully present — these must spawn the
// bundle and read its pipe, which is exactly what `fixtures.rvw` does.
//
// Every other fixture patch in this repo fits inside 64 KB, which is why nothing caught it; the
// fixture here is deliberately megabytes wide (see `bulkyRepo`). The two verbs that can outgrow
// the buffer are `rvw diff` (the patch itself, the documented "pipe it into your context" path)
// and `rvw check --coverage --json` (one span per skipped hunk), so both are driven here.

/** macOS's pipe capacity, and therefore the size a truncation would have clamped output to.
 * Asserting the output exceeds it is what makes the equality assertions load-bearing rather
 * than a tautology satisfied by any small fixture. */
const PIPE_BUFFER_BYTES = 64 * 1024;

let cli: InstalledCli;
let bulky: ForeignRepo;
const roots: string[] = [];

beforeAll(() => {
  cli = installBundle();
  bulky = bulkyRepo();
  roots.push(cli.root, bulky.path);
}, 60_000);

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("rvw writes all of stdout, even past the pipe buffer", () => {
  it("prints a multi-megabyte patch byte for byte down a pipe", () => {
    // The oracle is the same `capturePatch` the verb itself calls — a synchronous `spawnSync`
    // capture in this process, so it cannot be truncated by the defect under test — which makes
    // this a stricter comparison than `git diff | wc -c`: identical bytes, not identical counts.
    // `process.env` because that is what the spawned bundle inherits: the oracle has to
    // capture through the same environment the child hardens its own git with.
    const expected = capturePatch(process.env, bulky.path, bulky.base, bulky.head);
    if (!expected.ok) throw new Error(`fixture capture failed: ${expected.message}`);
    expect(Buffer.byteLength(expected.patch)).toBeGreaterThan(1024 * 1024);

    const result = rvw(cli, bulky, ["diff", "--base", bulky.base, "--head", bulky.head]);
    expect(result.status, result.stderr).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(PIPE_BUFFER_BYTES);
    expect(result.stdout).toBe(expected.patch);
  });

  it("emits a complete --coverage --json report on a diff far past the buffer", () => {
    const out = join(bulky.path, "bulk.reviewer.json");
    // One layer over the first few changed lines: enough for the gate to accept the draft, and
    // little enough that nearly every changed line stays uncovered — which is what makes the
    // report megabytes wide rather than a four-line summary.
    const draft = JSON.stringify({
      comments: [{ file: "bulk.txt", side: "additions", startLine: 1, endLine: 1, body: "why" }],
      layers: [
        {
          label: "Head",
          summary: "the first lines only",
          ranges: [{ file: "bulk.txt", side: "additions", startLine: 1, endLine: 10 }],
        },
      ],
    });
    const emitted = rvw(
      cli,
      bulky,
      ["emit", "--base", bulky.base, "--head", bulky.head, "--no-open", "--out", out],
      draft,
    );
    expect(emitted.status, emitted.stderr).toBe(0);

    // No `--require-complete`, so the coverage gap warns and still exits 0.
    const checked = rvw(cli, bulky, ["check", out, "--coverage", "--json"]);
    expect(checked.status, checked.stderr).toBe(0);
    expect(Buffer.byteLength(checked.stdout)).toBeGreaterThan(PIPE_BUFFER_BYTES);

    // `JSON.parse` is the completeness assertion: a truncated document does not parse. The
    // headline is the second half of it — a report cut off mid-array could never reach here,
    // but a total that matches the fixture's whole universe says the tail arrived too.
    const report = JSON.parse(checked.stdout) as {
      stage: string;
      complete: boolean;
      coverage: { headline: { coverableChangedLines: number }; uncoveredSpans: unknown[] };
    };
    expect(report.stage).toBe("coverage");
    expect(report.complete).toBe(false);
    expect(report.coverage.headline.coverableChangedLines).toBe(BULK_COVERABLE_LINES);
    expect(report.coverage.uncoveredSpans.length).toBeGreaterThan(1000);
  });
});
