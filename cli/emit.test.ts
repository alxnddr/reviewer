import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import type { StricliProcess } from "@stricli/core";
import { run } from "@stricli/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emitReviewArtifact } from "../src/tools/review-emit";
import { capturePatch } from "./git";
import { app } from "./app";
import { normalizeExitCode } from "./context";

// `rvw emit` driven against a real git fixture — the only honest proof of the contract: bytes
// reach disk only on a clean gate pass, exit 0/1/2 hold, and the written artifact is
// byte-identical to what the pure `emitReviewArtifact` core assembles for the same inputs.
// Fixture construction is isolated from the developer's git config.

const FIXTURE_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@test.local",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@test.local",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: FIXTURE_ENV });
}

function capture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

type CliResult = { code: number; stdout: string; stderr: string };

async function runCli(args: readonly string[]): Promise<CliResult> {
  const stdout = capture();
  const stderr = capture();
  const process: StricliProcess = { stdout: stdout.stream, stderr: stderr.stream, exitCode: null };
  await run(app, args, { process });
  return {
    code: normalizeExitCode(process.exitCode),
    stdout: stdout.text(),
    stderr: stderr.text(),
  };
}

let root: string;
let repo: string;
let baseSha: string;
let headSha: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-emit-")));
  repo = join(root, "work");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");

  writeFileSync(join(repo, "alpha.ts"), "a1\na2\na3\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  baseSha = git(repo, "rev-parse", "HEAD").trim();

  // alpha.ts line 2 rewritten (addition 2), line 4 appended; beta.ts added whole.
  writeFileSync(join(repo, "alpha.ts"), "a1\na2 changed\na3\na4\n");
  writeFileSync(join(repo, "beta.ts"), "b1\nb2\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "head");
  headSha = git(repo, "rev-parse", "HEAD").trim();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

type Draft = { comments: unknown; layers: unknown; overview?: unknown };

/** A draft every anchor of which places against the range's diff — the clean-pass input. */
const VALID_DRAFT: Draft = {
  comments: [
    { file: "alpha.ts", side: "additions", startLine: 2, endLine: 2, body: "line 2 rewritten" },
  ],
  layers: [
    {
      id: "l1",
      label: "Walk",
      summary: "the change",
      kind: "feature",
      ranges: [
        { file: "alpha.ts", side: "additions", startLine: 2, endLine: 2 },
        { file: "beta.ts", side: "additions", startLine: 1, endLine: 2 },
      ],
    },
  ],
};

/** A draft whose comment anchors a line no hunk of the diff contains — the gate must
 * refuse it and write nothing. */
const MIS_ANCHORED_DRAFT: Draft = {
  comments: [
    { file: "alpha.ts", side: "additions", startLine: 999, endLine: 999, body: "nowhere" },
  ],
  layers: [],
};

function draftFile(draft: Draft): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewer-emit-draft-"));
  const file = join(dir, "draft.json");
  writeFileSync(file, JSON.stringify(draft));
  return file;
}

function outPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "reviewer-emit-out-")), name);
}

describe("rvw emit", () => {
  it("writes the artifact and exits 0 on a valid draft", async () => {
    const out = outPath("change.reviewer.json");
    const result = await runCli([
      "emit",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      draftFile(VALID_DRAFT),
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("written");
    expect(existsSync(out)).toBe(true);
    // Refs-only: the written artifact carries no embedded patch — the app re-derives
    // the diff from `source` on open.
    expect(JSON.parse(readFileSync(out, "utf8"))).not.toHaveProperty("patch");
  });

  it("carries an authored overview into the artifact, and gates its links too", async () => {
    const out = outPath("tour.reviewer.json");
    const withTour: Draft = {
      ...VALID_DRAFT,
      overview: {
        title: "Rewrite line 2",
        body: "Starts in `alpha.ts`, lands in [beta](beta.ts).",
      },
    };
    const result = await runCli([
      "emit",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      draftFile(withTour),
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).overview).toEqual(withTour.overview);

    // A link to a path outside the diff is refused exactly like one in a layer
    // description — and nothing reaches disk.
    const dead = outPath("dead.reviewer.json");
    const refused = await runCli([
      "emit",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      draftFile({ ...VALID_DRAFT, overview: { title: "T", body: "See [x](gone.ts)." } }),
      "--out",
      dead,
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("overview body links");
    expect(existsSync(dead)).toBe(false);
  });

  it("writes an artifact byte-identical to what the pure emit core assembles", async () => {
    const out = outPath("parity.reviewer.json");
    await runCli([
      "emit",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      draftFile(VALID_DRAFT),
      "--out",
      out,
    ]);

    // The file `rvw emit` wrote must equal the pure core's bytes for the same
    // repo/refs/patch/draft (same `JSON.stringify(candidate, null, 2)`).
    const patch = capturePatch(repo, baseSha, headSha);
    if (!patch.ok) throw new Error(patch.message);
    const expected = emitReviewArtifact({
      repo: { path: patch.repoPath, name: basename(patch.repoPath) },
      base: baseSha,
      head: headSha,
      patch: patch.patch,
      comments: VALID_DRAFT.comments,
      layers: VALID_DRAFT.layers,
    });
    if (!expected.ok) throw new Error("expected a clean emit");
    expect(readFileSync(out, "utf8")).toBe(expected.bytes);
  });

  it("writes nothing and exits 1 with the locator on a mis-anchored draft", async () => {
    const out = outPath("bad.reviewer.json");
    const result = await runCli([
      "emit",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      draftFile(MIS_ANCHORED_DRAFT),
      "--out",
      out,
    ]);
    expect(result.code).toBe(1);
    // Nothing written on failure — the whole reason the gate lives in the return value.
    expect(existsSync(out)).toBe(false);
    expect(result.stderr).toContain("nothing written");
    expect(result.stderr).toContain("alpha.ts");
  });

  it("leaves an existing --out untouched when the gate refuses", async () => {
    // "Nothing written" is about the bytes on disk, not just about creating a file: a refused
    // emit aimed at a file that already exists must not truncate or clobber it.
    const out = outPath("existing.reviewer.json");
    const sentinel = '{"kept":"the previous artifact"}';
    writeFileSync(out, sentinel);
    const result = await runCli([
      "emit",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      draftFile(MIS_ANCHORED_DRAFT),
      "--out",
      out,
    ]);
    expect(result.code).toBe(1);
    expect(readFileSync(out, "utf8")).toBe(sentinel);
  });

  it("writes to the managed reviews dir when --out is omitted, never into the repo", async () => {
    // RVW_HOME points the store at a throwaway dir so the test never writes to the real home.
    // The managed dir need not pre-exist — emit creates it — so this also proves the mkdir.
    const store = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-rvw-home-")));
    const previous = process.env.RVW_HOME;
    process.env.RVW_HOME = store;
    try {
      const result = await runCli([
        "emit",
        "--repo",
        repo,
        "--base",
        baseSha,
        "--head",
        headSha,
        "--draft",
        draftFile(VALID_DRAFT),
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("written");

      const reviewsDir = join(store, "reviews");
      const written = readdirSync(reviewsDir);
      expect(written).toHaveLength(1);
      const only = written[0] ?? "";
      expect(only.endsWith(".reviewer.json")).toBe(true);
      // The printed path is the managed dir's, so an agent can hand it straight to `rvw open`.
      expect(result.stdout).toContain(join(reviewsDir, only));
      // Nothing was written into the reviewed repo — the whole point of the managed dir.
      expect(existsSync(join(repo, only))).toBe(false);
      // Refs-only whichever path chose the destination.
      expect(JSON.parse(readFileSync(join(reviewsDir, only), "utf8"))).not.toHaveProperty("patch");
    } finally {
      if (previous === undefined) delete process.env.RVW_HOME;
      else process.env.RVW_HOME = previous;
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("exits 2 when --out does not end .reviewer.json, before any capture", async () => {
    const result = await runCli([
      "emit",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      draftFile(VALID_DRAFT),
      "--out",
      outPath("change.json"),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(".reviewer.json");
  });

  it("exits 2 on an unreadable draft rather than a stack trace", async () => {
    const result = await runCli([
      "emit",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      join(root, "no-such-draft.json"),
      "--out",
      outPath("change.reviewer.json"),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot read draft");
    expect(result.stderr).not.toContain("at Object.");
  });
});
