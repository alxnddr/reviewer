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
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewArtifact } from "../src/shared/review";
import { emitReviewArtifact } from "../src/tools/review-emit";
import { capturePatch } from "./git";
import { FIXTURE_ENV, fixtureGit, minimalRepo, runCli, type ForeignRepo } from "./fixtures";

// `rvw emit` driven against a real git fixture — the only honest proof of the contract: bytes
// reach disk only on a clean gate pass, exit 0/1/2 hold, the written artifact is byte-identical
// to what the pure `emitReviewArtifact` core assembles for the same inputs, and the range
// nobody typed is the range the agent meant.
//
// The fixture is deliberately shaped so the defaults have something to get *wrong*: two
// branches, so a defaulted `--head` must pick the checked-out one and a defaulted `--base` must
// find the fork point rather than the tip. Fixture construction is isolated from the
// developer's git config.
//
// Every run here passes `--no-open`. Opening is the default and is proven separately, on the
// one path that reaches the launcher without a window: a platform Reviewer does not ship for.

let root: string;
let repo: string;
let baseSha: string;
let headSha: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-emit-")));
  repo = join(root, "work");
  mkdirSync(repo);
  fixtureGit(repo, "init", "-b", "main");

  writeFileSync(join(repo, "alpha.ts"), "a1\na2\na3\n");
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "base");
  baseSha = fixtureGit(repo, "rev-parse", "HEAD").trim();

  // The head lands on its own branch, so `main` stays behind: a defaulted `--base` has a real
  // fork point to find, and a defaulted `--head` has a wrong answer available to it.
  fixtureGit(repo, "checkout", "-b", "feature");
  // alpha.ts line 2 rewritten (addition 2), line 4 appended; beta.ts added whole.
  writeFileSync(join(repo, "alpha.ts"), "a1\na2 changed\na3\na4\n");
  writeFileSync(join(repo, "beta.ts"), "b1\nb2\n");
  fixtureGit(repo, "add", ".");
  fixtureGit(repo, "commit", "-m", "head");
  headSha = fixtureGit(repo, "rev-parse", "HEAD").trim();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

type Draft = { comments?: unknown; layers?: unknown; overview?: unknown };

/** A draft every anchor of which places against the range's diff — the clean-pass input. */
const VALID_DRAFT: Draft = {
  comments: [
    { file: "alpha.ts", side: "additions", startLine: 2, endLine: 2, body: "line 2 rewritten" },
  ],
  layers: [
    {
      label: "Walk",
      summary: "the change",
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

/** The explicit-range invocation, so a test that is about something *else* states the range
 * once. `--no-open` everywhere: see the file header. */
function explicit(draft: Draft, ...extra: readonly string[]): string[] {
  return [
    "emit",
    "--repo",
    repo,
    "--base",
    baseSha,
    "--head",
    headSha,
    "--draft",
    draftFile(draft),
    "--no-open",
    ...extra,
  ];
}

function readArtifact(path: string): ReviewArtifact {
  return JSON.parse(readFileSync(path, "utf8")) as ReviewArtifact;
}

describe("rvw emit", () => {
  it("writes the artifact and exits 0 on a valid draft", async () => {
    const out = outPath("change.reviewer.json");
    const result = await runCli(explicit(VALID_DRAFT, "--out", out));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("written");
    expect(existsSync(out)).toBe(true);
    // Refs-only: the written artifact carries no embedded patch — the app re-derives
    // the diff from the recorded repo/refs on open.
    expect(readArtifact(out)).not.toHaveProperty("patch");
  });

  it("carries the diff into the file under --embed-patch, and says it did", async () => {
    // The CI handoff: the artifact has to be readable on a machine that has neither this
    // checkout path nor these refs, so the diff rides inside it. Proven against the same
    // capture the gate used, through the real `git` the fixture repo answers with.
    const out = outPath("portable.reviewer.json");
    const result = await runCli(explicit(VALID_DRAFT, "--out", out, "--embed-patch"));
    expect(result.code).toBe(0);

    const captured = capturePatch(FIXTURE_ENV, repo, baseSha, headSha);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(readArtifact(out).patch).toBe(captured.patch);

    // Reported, not silent: which of the two forms was written changes what the app can do
    // with it, so a caller must never have to open the file to find out which one they got.
    expect(result.stdout).toContain("opens without the repo");
    const asJson = await runCli(
      explicit(VALID_DRAFT, "--out", outPath("p.reviewer.json"), "--embed-patch", "--json"),
    );
    expect(JSON.parse(asJson.stdout)).toMatchObject({ ok: true, embedded: true });
  });

  it("reports embedded: false when the flag was not given, so the default is legible too", async () => {
    const result = await runCli(
      explicit(VALID_DRAFT, "--out", outPath("plain.reviewer.json"), "--json"),
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, embedded: false });
    expect(result.stdout).not.toContain("opens without the repo");
  });

  it("echoes the resolved repo and range, so a defaulted one is never silent", async () => {
    const out = outPath("echo.reviewer.json");
    const result = await runCli(explicit(VALID_DRAFT, "--out", out));
    expect(result.stdout).toContain(`${repo}: ${baseSha}...${headSha}`);
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
    const result = await runCli(explicit(withTour, "--out", out));
    expect(result.code).toBe(0);
    expect(readArtifact(out).overview).toEqual(withTour.overview);

    // A link to a path outside the diff is refused exactly like one in a layer
    // description — and nothing reaches disk.
    const dead = outPath("dead.reviewer.json");
    const refused = await runCli(
      explicit(
        { ...VALID_DRAFT, overview: { title: "T", body: "See [x](gone.ts)." } },
        "--out",
        dead,
      ),
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("overview body links");
    expect(existsSync(dead)).toBe(false);
  });

  it("carries a comment's postable into the artifact, and gates its links too", async () => {
    const comment = {
      file: "alpha.ts",
      side: "additions",
      startLine: 2,
      endLine: 2,
      body: "line 2 rewritten",
    };
    const out = outPath("postable.reviewer.json");
    const postable = "Could [this line](alpha.ts:2) say why it changed?";
    const result = await runCli(
      explicit({ ...VALID_DRAFT, comments: [{ ...comment, postable }] }, "--out", out),
    );
    expect(result.code).toBe(0);
    expect(readArtifact(out).comments[0]?.postable).toBe(postable);

    // Posted, a dead reference is a broken link in front of the change's author, so the gate
    // refuses it in `postable` as it does in the overview — and nothing reaches disk.
    const dead = outPath("dead-postable.reviewer.json");
    const refused = await runCli(
      explicit(
        { ...VALID_DRAFT, comments: [{ ...comment, postable: "See [x](gone.ts)." }] },
        "--out",
        dead,
      ),
    );
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "postable of the comment at alpha.ts additions 2-2 links [x](gone.ts)",
    );
    expect(existsSync(dead)).toBe(false);
  });

  it("writes an artifact byte-identical to what the pure emit core assembles", async () => {
    const out = outPath("parity.reviewer.json");
    await runCli(explicit(VALID_DRAFT, "--out", out));

    // The file `rvw emit` wrote must equal the pure core's bytes for the same
    // repo/refs/patch/draft (same `JSON.stringify(candidate, null, 2)`).
    const patch = capturePatch(FIXTURE_ENV, repo, baseSha, headSha);
    if (!patch.ok) throw new Error(patch.message);
    const expected = emitReviewArtifact({
      repo,
      base: baseSha,
      head: headSha,
      // The range resolves `--head <sha>` to itself, so the provenance the shell threads in
      // is that same sha — and the bytes only match if the shell actually threads it.
      reviewedHead: headSha,
      patch: patch.patch,
      comments: VALID_DRAFT.comments,
      layers: VALID_DRAFT.layers,
    });
    if (!expected.ok) throw new Error("expected a clean emit");
    expect(readFileSync(out, "utf8")).toBe(expected.bytes);
  });

  it("writes nothing and exits 1 with the locator on a mis-anchored draft, naming the draft", async () => {
    const out = outPath("bad.reviewer.json");
    const draft = draftFile(MIS_ANCHORED_DRAFT);
    const result = await runCli([
      "emit",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      draft,
      "--no-open",
      "--out",
      out,
    ]);
    expect(result.code).toBe(1);
    // Nothing written on failure — the whole reason the gate lives in the return value.
    expect(existsSync(out)).toBe(false);
    expect(result.stderr).toContain("nothing written");
    expect(result.stderr).toContain("alpha.ts");
    // The refusal names the *draft*, the thing the agent can edit. It used to name the derived
    // output path — a timestamped file that was never a candidate and never existed.
    expect(result.stderr).toContain(`draft ${draft} refused`);
    expect(result.stderr).not.toContain(out);
  });

  it("leaves an existing --out untouched when the gate refuses", async () => {
    // "Nothing written" is about the bytes on disk, not just about creating a file: a refused
    // emit aimed at a file that already exists must not truncate or clobber it.
    const out = outPath("existing.reviewer.json");
    const sentinel = '{"kept":"the previous artifact"}';
    writeFileSync(out, sentinel);
    const result = await runCli(explicit(MIS_ANCHORED_DRAFT, "--out", out));
    expect(result.code).toBe(1);
    expect(readFileSync(out, "utf8")).toBe(sentinel);
  });

  it("writes to the managed reviews dir when --out is omitted, never into the repo", async () => {
    // RVW_HOME points the store at a throwaway dir so the test never writes to the real home —
    // handed to the run through its context rather than set on the real environment. The managed
    // dir need not pre-exist — emit creates it — so this also proves the mkdir.
    const store = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-rvw-home-")));
    try {
      const result = await runCli(explicit(VALID_DRAFT), {
        env: { ...FIXTURE_ENV, RVW_HOME: store },
      });
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
      expect(readArtifact(join(reviewsDir, only))).not.toHaveProperty("patch");
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });

  it("exits 2 when --out does not end .reviewer.json, before any capture", async () => {
    const result = await runCli(explicit(VALID_DRAFT, "--out", outPath("change.json")));
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
      "--no-open",
      "--out",
      outPath("change.reviewer.json"),
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("cannot read draft");
    expect(result.stderr).not.toContain("at Object.");
  });
});

describe("rvw emit — the range nobody typed", () => {
  it("defaults --repo to the cwd's toplevel, --head to the checked-out branch, --base to the fork point", async () => {
    // The agent is standing in the repo it just reviewed; every flag it has to type about that
    // repo is a flag it can get wrong. Driven from inside the repo — the context's cwd, not a
    // `process.chdir` every other test in the worker would have shared — with no range at all.
    const out = outPath("defaults.reviewer.json");
    const result = await runCli(
      ["emit", "--draft", draftFile(VALID_DRAFT), "--no-open", "--out", out, "--json"],
      { cwd: repo },
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      repo,
      // `main` is where `feature` forked, and its tip is the base commit.
      base: baseSha,
      // A branch, stored as a branch: the review is meant to follow it.
      head: "feature",
    });
    // ...and the commit that branch pointed at, recorded beside it. This is the case the
    // field exists for: `head` alone cannot say which commit was reviewed, because tomorrow
    // it names a different one.
    expect(readArtifact(out)).toMatchObject({ head: "feature", reviewedHead: headSha });
  });

  it("records the reviewed head for a sha-pinned range too, where it merely agrees", async () => {
    // Stated as its own case because the alternative — writing it only when `head` is a name —
    // is a conditional on both sides of the wire to save one line in the file.
    const out = outPath("pinned.reviewer.json");
    const result = await runCli(explicit(VALID_DRAFT, "--out", out));
    expect(result.code).toBe(0);
    expect(readArtifact(out)).toMatchObject({ head: headSha, reviewedHead: headSha });
  });

  it("resolves a rev expression to a sha rather than refusing it", async () => {
    // `HEAD~1`, `v1^`, a short sha: all things git resolves and an agent will type. The old
    // refusal ("not a valid ref") sent the agent to pre-resolve them by hand.
    const out = outPath("revexpr.reviewer.json");
    const result = await runCli([
      "emit",
      "--repo",
      repo,
      "--base",
      "HEAD~1",
      "--head",
      headSha.slice(0, 8),
      "--draft",
      draftFile(VALID_DRAFT),
      "--no-open",
      "--out",
      out,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, base: baseSha, head: headSha });
    expect(readArtifact(out)).toMatchObject({ base: baseSha, head: headSha });
  });

  it("never lets HEAD or @ reach the artifact — they name a different commit every read", async () => {
    // The one ref that used to get through: `--head HEAD` was accepted as a "branch name" and
    // written verbatim, so the app re-derived it at open time and the review silently repointed
    // to whatever was checked out then.
    for (const moving of ["HEAD", "@"]) {
      const out = outPath(`moving-${moving === "@" ? "at" : "head"}.reviewer.json`);
      const result = await runCli([
        "emit",
        "--repo",
        repo,
        "--base",
        baseSha,
        "--head",
        moving,
        "--draft",
        draftFile(VALID_DRAFT),
        "--no-open",
        "--out",
        out,
      ]);
      expect(result.code).toBe(0);
      const artifact = readArtifact(out);
      expect(artifact.head).toBe(headSha);
      expect(artifact.head).not.toBe(moving);
    }
  });

  it("pins a base that is not a local branch, and follows one that is", async () => {
    // A base is a fixed point, so a tag or a remote-tracking ref becomes the sha it named. A
    // local branch stays a name: that is the ref a reader is meant to follow.
    fixtureGit(repo, "tag", "v1", baseSha);
    const tagged = outPath("tagged.reviewer.json");
    const byTag = await runCli([
      "emit",
      "--repo",
      repo,
      "--base",
      "v1",
      "--head",
      "feature",
      "--draft",
      draftFile(VALID_DRAFT),
      "--no-open",
      "--out",
      tagged,
    ]);
    expect(byTag.code).toBe(0);
    expect(readArtifact(tagged)).toMatchObject({ base: baseSha, head: "feature" });
  });

  it("exits 2 with badRef on a revision the repo cannot resolve, and on one that could be a flag", async () => {
    const unknown = await runCli([
      "emit",
      "--repo",
      repo,
      "--base",
      "no-such-branch",
      "--draft",
      draftFile(VALID_DRAFT),
      "--no-open",
      "--json",
    ]);
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ ok: false, error: { code: "badRef" } });

    // Validated before the spawn, as every ref-bearing path in this codebase is: a leading `-`
    // is the injection-critical shape, and `--base=…` is how it would get past the scanner and
    // reach us as a value. It never reaches `git`.
    const flagShaped = await runCli([
      "emit",
      "--repo",
      repo,
      "--base=--upload-pack=evil",
      "--draft",
      draftFile(VALID_DRAFT),
      "--no-open",
      "--json",
    ]);
    expect(flagShaped.code).toBe(2);
    expect(JSON.parse(flagShaped.stdout)).toMatchObject({ ok: false, error: { code: "badRef" } });
  });
});

describe("rvw emit — the draft", () => {
  it("presents a comments-only draft, and a layers-only one", async () => {
    // Layers are the product's differentiator, not the price of entry: an agent arriving with
    // six findings from its own review command must be able to show them.
    const commentsOnly = outPath("comments.reviewer.json");
    const withComments = await runCli(
      explicit({ comments: VALID_DRAFT.comments }, "--out", commentsOnly),
    );
    expect(withComments.code).toBe(0);
    expect(readArtifact(commentsOnly)).not.toHaveProperty("layers");

    const layersOnly = outPath("layers.reviewer.json");
    const withLayers = await runCli(explicit({ layers: VALID_DRAFT.layers }, "--out", layersOnly));
    expect(withLayers.code).toBe(0);
    expect(readArtifact(layersOnly)).not.toHaveProperty("comments");
  });

  it("refuses a draft that presents nothing, before it spawns git", async () => {
    const result = await runCli(explicit({}, "--json"));
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "draftEmpty" },
    });
  });

  it("refuses a draft that is not a JSON object", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-emit-bad-"));
    const bad = join(dir, "draft.json");
    writeFileSync(bad, '"just a string"');
    const result = await runCli([
      "emit",
      "--repo",
      repo,
      "--base",
      baseSha,
      "--head",
      headSha,
      "--draft",
      bad,
      "--no-open",
      "--json",
    ]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "draftUnreadable" },
    });
  });
});

describe("rvw emit — presenting it", () => {
  it("does not launch under --no-open, and says so under --json", async () => {
    const out = outPath("quiet.reviewer.json");
    const result = await runCli(explicit(VALID_DRAFT, "--out", out, "--json"));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, opened: false });
    expect(result.stderr).toBe("");
  });

  it("opens by default, and a launch that fails still exits 0 with the artifact on disk", async () => {
    // Opening is the default — presenting a review is meant to be one call. Driving that
    // without a window means driving it on a platform Reviewer does not ship for, which is the
    // same code path a missing install takes: the launcher declines, the file is still real,
    // and the exit code says so.
    const out = outPath("presented.reviewer.json");
    const result = await runCli(explicitOpen(VALID_DRAFT, "--out", out), { platform: "linux" });
    expect(result.code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(result.stdout).toContain("written");
    expect(result.stderr).toContain("linux");
    expect(result.stderr).toContain(`rvw open ${out}`);

    const asJson = await runCli(
      explicitOpen(VALID_DRAFT, "--out", outPath("j.reviewer.json"), "--json"),
      { platform: "linux" },
    );
    expect(asJson.code).toBe(0);
    expect(JSON.parse(asJson.stdout)).toMatchObject({ ok: true, opened: false });
  });
});

/** `explicit`, minus the `--no-open`: the default-on launch is the thing under test. */
function explicitOpen(draft: Draft, ...extra: readonly string[]): string[] {
  return explicit(draft, ...extra).filter((arg) => arg !== "--no-open");
}

describe("rvw emit --pr", () => {
  // Each case gets a repo of its own, because what is under test is the `origin` remote a bare
  // number is completed from, and a remote added to the shared fixture would leak into every
  // other case in the file.
  const repos: string[] = [];
  afterAll(() => {
    for (const path of repos) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  function repoWithOrigin(origin: string | null): ForeignRepo {
    const made = minimalRepo();
    repos.push(made.path);
    if (origin !== null) {
      fixtureGit(made.path, "remote", "add", "origin", origin);
    }
    return made;
  }

  const anchor = { file: "a.txt", side: "additions", startLine: 2, endLine: 2 } as const;
  const POSTED: Draft = {
    comments: [
      { ...anchor, body: "first", postable: "Could this line say why it changed?" },
      { ...anchor, body: "second" },
      { ...anchor, body: "third" },
    ],
  };

  function emitPr(target: ForeignRepo, pr: string, draft: Draft, ...extra: string[]): string[] {
    return [
      "emit",
      "--repo",
      target.path,
      "--base",
      target.base,
      "--head",
      target.head,
      "--draft",
      draftFile(draft),
      "--no-open",
      "--pr",
      pr,
      ...extra,
    ];
  }

  it("completes a bare number from an ssh origin, records it, and echoes it", async () => {
    const target = repoWithOrigin("git@github.com:acme/widgets.git");
    const out = outPath("pr.reviewer.json");
    const result = await runCli(emitPr(target, "42", POSTED, "--out", out));
    expect(result.code).toBe(0);
    expect(readArtifact(out).pr).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "widgets",
      number: 42,
    });
    // Echoed like the range: the owner and repo were worked out, not typed.
    expect(result.stdout).toContain("pull request: https://github.com/acme/widgets/pull/42\n");
  });

  it("takes a URL or owner/repo#n as written, with no origin to consult", async () => {
    const target = repoWithOrigin(null);
    for (const pr of ["https://github.com/other/thing/pull/7/files", "other/thing#7"]) {
      const out = outPath("named.reviewer.json");
      const result = await runCli(emitPr(target, pr, POSTED, "--out", out));
      expect(result.code, pr).toBe(0);
      expect(readArtifact(out).pr).toEqual({
        host: "github.com",
        owner: "other",
        repo: "thing",
        number: 7,
      });
    }
  });

  it("says how many comments have no postable text — on stdout, and without moving the exit code", async () => {
    const target = repoWithOrigin("https://github.com/acme/widgets");
    const result = await runCli(
      emitPr(target, "42", POSTED, "--out", outPath("gap.reviewer.json")),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2 of 3 comments have no postable text\n");
    expect(result.stderr).toBe("");

    // Under --json it is a field of the success document, never a line beside it.
    const asJson = await runCli(
      emitPr(target, "42", POSTED, "--out", outPath("gap-json.reviewer.json"), "--json"),
    );
    expect(asJson.code).toBe(0);
    expect(JSON.parse(asJson.stdout)).toMatchObject({
      ok: true,
      pr: { host: "github.com", owner: "acme", repo: "widgets", number: 42 },
      withoutPostable: 2,
    });
  });

  it("is silent about postable text when every comment has some, and without --pr at all", async () => {
    const target = repoWithOrigin("https://github.com/acme/widgets");
    const allPosted: Draft = {
      comments: [{ ...anchor, body: "first", postable: "Could this say why?" }],
    };
    const posted = await runCli(
      emitPr(target, "42", allPosted, "--out", outPath("all.reviewer.json")),
    );
    expect(posted.code).toBe(0);
    expect(posted.stdout).not.toContain("postable");

    // A review of one's own branch posts nothing, so its missing postables are not news.
    const own = await runCli(
      explicit(VALID_DRAFT, "--out", outPath("own.reviewer.json"), "--json"),
    );
    expect(JSON.parse(own.stdout)).toMatchObject({ ok: true, pr: null, withoutPostable: null });
    expect(readArtifact(JSON.parse(own.stdout).out)).not.toHaveProperty("pr");
  });

  it("exits 2 with badPullRequest when a bare number has no origin to complete it from", async () => {
    const target = repoWithOrigin(null);
    const out = outPath("none.reviewer.json");
    const result = await runCli(emitPr(target, "42", POSTED, "--out", out, "--json"));
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ ok: false, error: { code: "badPullRequest" } });
    expect(envelope.error.message).toContain("origin");
    expect(envelope.error.message).toContain("owner/repo#42");
    expect(existsSync(out)).toBe(false);
  });

  it("exits 2 when origin is not on github.com, without echoing a credential in its URL", async () => {
    const target = repoWithOrigin("https://oauth2:s3cret@gitlab.com/acme/widgets.git");
    const out = outPath("gitlab.reviewer.json");
    const result = await runCli(emitPr(target, "42", POSTED, "--out", out));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("https://gitlab.com/acme/widgets.git");
    expect(result.stderr).toContain("only github.com is supported");
    expect(result.stderr).not.toContain("s3cret");
    expect(existsSync(out)).toBe(false);
  });

  it("exits 2 when origin is on github.com but names no owner/repo", async () => {
    const target = repoWithOrigin("https://github.com/acme");
    const result = await runCli(emitPr(target, "42", POSTED, "--json"));
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stdout);
    expect(envelope).toMatchObject({ ok: false, error: { code: "badPullRequest" } });
    expect(envelope.error.message).toContain("names no github.com owner/repo");
    expect(envelope.error.message).toContain("owner/repo#42");
  });

  it("redacts a password holding an @ in its entirety, not up to the first one", async () => {
    const target = repoWithOrigin("https://user:p@ss@gitlab.com/acme/widgets.git");
    const result = await runCli(emitPr(target, "42", POSTED));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("origin is https://gitlab.com/acme/widgets.git,");
    expect(result.stderr).not.toContain("ss@");
  });

  it("never echoes a credential carried in the --pr value it refuses", async () => {
    const target = repoWithOrigin(null);
    const result = await runCli(
      emitPr(target, "https://glpat-SECRET@gitlab.com/o/r/-/merge_requests/1", POSTED),
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--pr https://gitlab.com/o/r/-/merge_requests/1 is not");
    expect(result.stderr).not.toContain("SECRET");
  });

  it("exits 2 on a value that names no pull request, before reading the draft", async () => {
    const target = repoWithOrigin("git@github.com:acme/widgets.git");
    for (const pr of ["acme/widgets", "0", "https://gitlab.com/acme/widgets/-/merge_requests/1"]) {
      const result = await runCli([
        "emit",
        "--repo",
        target.path,
        "--draft",
        join(root, "no-such-draft.json"),
        "--no-open",
        "--pr",
        pr,
        "--json",
      ]);
      expect(result.code, pr).toBe(2);
      // The flag is refused, not the draft that was never read.
      expect(JSON.parse(result.stdout), pr).toMatchObject({
        ok: false,
        error: { code: "badPullRequest" },
      });
    }
  });
});
