import * as z from "zod";

// The git IPC contract: every payload crossing the bridge is defined here as a zod
// schema so refs are proven safe before any spawn.

/** Absolute path to a repository work tree. v1 is macOS-only, so absolute = leading `/`. */
export const RepoPath = z.string().refine((path) => path.startsWith("/"), {
  error: "Repo path must be absolute",
});
export type RepoPath = z.infer<typeof RepoPath>;

/** Full commit hash (40-hex SHA-1 or 64-hex SHA-256), never an abbreviation or a rev
 * expression — anything else could smuggle flags or rev syntax into a spawn. */
export const CommitSha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
  error: "Commit sha must be a full lowercase hex hash",
});
export type CommitSha = z.infer<typeof CommitSha>;

// Deny-list from `git check-ref-format`: control chars / space, `~ ^ : ? * [ \`,
// `..`, `@{`, `//`, leading `-` `.` `/`, trailing `.` `/`, trailing `.lock`.
// Leading `-` and whitespace are the injection-critical rejections.
// oxlint-disable-next-line no-control-regex -- matching control chars is the point of this deny-list
const BRANCH_NAME_FORBIDDEN = /[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^[-./]|[./]$|\.lock$/;

export const BranchName = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !BRANCH_NAME_FORBIDDEN.test(name), {
    error: "Not a valid git branch name",
  });
export type BranchName = z.infer<typeof BranchName>;

/** A diff endpoint that names either a branch or a full sha. Lives here (not in
 * review.ts) so the review artifact and the diff request that reproduces it share
 * one ref schema — and either form still fails the same spawn boundary a branch
 * pick does. */
export const ReviewRef = z.union([CommitSha, BranchName]);
export type ReviewRef = z.infer<typeof ReviewRef>;

// Control bytes are the injection-critical rejection; a NUL would truncate the
// argument mid-spawn.
// oxlint-disable-next-line no-control-regex -- rejecting control bytes is the point of this deny-list
const FILE_PATH_FORBIDDEN = /[\x00-\x1f]/;

/** A repo-relative file path as it appears in a diff, addressed as `<ref>:<path>`
 * for a full-file read. Flag injection is impossible because the validated
 * ref always leads that argument. Escape is refused at the schema, not deferred to
 * git's runtime "outside repository" check (validate before spawn): the
 * deny-list rejects control bytes (a NUL would truncate the argument) and absolute
 * paths, and no segment may be `..` — a git diff path is always normalized under the
 * repo toplevel, so a parent-directory segment is never a real path, only an escape
 * attempt (mirroring the sibling `BranchName` deny-list, which bars `..` too). */
export const FilePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !FILE_PATH_FORBIDDEN.test(path) && !path.startsWith("/") && !path.split("/").includes(".."),
    { error: "Not a valid repo-relative file path" },
  );
export type FilePath = z.infer<typeof FilePath>;

/** The commit-brush arms alone: `commitRange` (single commit =
 * first === last), `commitRangeWithUncommitted` when the brush includes the
 * working-tree entry, or `uncommitted` alone. `first` is the oldest commit of
 * the brush, `last` the newest. Named separately because a session persists
 * exactly this — SHA-anchored, so history growth cannot shift it. */
export const CommitSelection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commitRange"), first: CommitSha, last: CommitSha }),
  z.object({ kind: z.literal("commitRangeWithUncommitted"), first: CommitSha }),
  z.object({ kind: z.literal("uncommitted") }),
]);
export type CommitSelection = z.infer<typeof CommitSelection>;

/** Every diff the app can request from git. The `branches` arm and the commit-brush
 * arms are what the user can *select*; `reviewRefs` is not user-selectable —
 * it is the diff a review pins onto its session, reproducing the authored
 * `base..head` so its comments anchor on their exact lines. It rides this union so
 * one `git:diff` channel serves both, and a review sha never has to masquerade as a
 * branch pick. */
export const DiffSelection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("branches"), base: BranchName, head: BranchName }),
  z.object({ kind: z.literal("reviewRefs"), base: ReviewRef, head: ReviewRef }),
  ...CommitSelection.options,
]);
export type DiffSelection = z.infer<typeof DiffSelection>;

/** Why a git operation could not produce a value. stderr never crosses IPC — main
 * logs it and maps the failure to one of these codes. */
export const GitFailure = z.discriminatedUnion("code", [
  z.object({ code: z.literal("gitMissing") }),
  z.object({ code: z.literal("notARepo"), path: z.string() }),
  z.object({ code: z.literal("unknownRevision") }),
  z.object({ code: z.literal("invalidRange") }),
  z.object({ code: z.literal("outputOverflow"), limitBytes: z.number().int().positive() }),
  z.object({ code: z.literal("timeout") }),
  z.object({ code: z.literal("unexpected") }),
]);
export type GitFailure = z.infer<typeof GitFailure>;

export type GitResult<T> = { ok: true; value: T } | { ok: false; failure: GitFailure };

/** Response envelope for every git channel: the renderer always receives a
 * discriminated result, never a rejected promise with a stringified error. */
export function GitResultOf<Value extends z.ZodType>(value: Value) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }),
    z.object({ ok: z.literal(false), failure: GitFailure }),
  ]);
}

export const RepoInfo = z.object({
  /** Normalized to the work-tree toplevel, whatever directory was picked. */
  path: RepoPath,
  name: z.string().min(1),
});
export type RepoInfo = z.infer<typeof RepoInfo>;

export const OpenRepoOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("opened"), repo: RepoInfo }),
  z.object({ kind: z.literal("canceled") }),
]);
export type OpenRepoOutcome = z.infer<typeof OpenRepoOutcome>;

export const BranchList = z.object({
  branches: z.array(BranchName),
  /** Null when the repo has no branches at all. */
  defaultBranch: BranchName.nullable(),
  /** Null on a detached HEAD or an unborn branch. */
  currentBranch: BranchName.nullable(),
});
export type BranchList = z.infer<typeof BranchList>;

export const Commit = z.object({
  sha: CommitSha,
  shortSha: z.string().min(4),
  author: z.string(),
  authoredAt: z.iso.datetime({ offset: true }),
  subject: z.string(),
});
export type Commit = z.infer<typeof Commit>;

/** One row of the selectable commit-brush list: newest first, with a
 * working-tree pseudo-entry on top when uncommitted changes exist. */
export const LogEntry = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("uncommitted") }),
  z.object({ kind: z.literal("commit"), commit: Commit }),
]);
export type LogEntry = z.infer<typeof LogEntry>;

export const CommitLog = z.object({ entries: z.array(LogEntry) });
export type CommitLog = z.infer<typeof CommitLog>;

export const Patch = z.object({
  /** Unified diff, `git diff` wire format; empty when the selection has no changes. */
  patch: z.string(),
});
export type Patch = z.infer<typeof Patch>;

/** A file's full text at a ref, or a typed absence when the path has no blob there —
 * the added-file old side or the deleted-file new side. The context-expansion loader
 * maps `absent` to Pierre's `oldFile: null`; it is never an error and never
 * an empty string dressed as content. */
export const FileAtRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("present"), text: z.string() }),
  z.object({ kind: z.literal("absent") }),
]);
export type FileAtRef = z.infer<typeof FileAtRef>;

export const RepoRequest = z.object({ repoPath: RepoPath });
export type RepoRequest = z.infer<typeof RepoRequest>;

/** The committed endpoints a commit list is drawn between. Each is a `ReviewRef` (a
 * branch name or a full sha), so it passes the same spawn boundary a branch pick does —
 * a review's authored `base`/`head` reproduced verbatim. A null `base` is not a missing
 * endpoint but a different question: the whole history reachable from `head`. */
export const LogRange = z.object({ base: ReviewRef.nullable(), head: ReviewRef });
export type LogRange = z.infer<typeof LogRange>;

/** What `git:log` lists. `range` null walks HEAD (the picker's default, and the only
 * log that carries the working-tree pseudo-entry when the tree is dirty); a range with
 * a base lists `base..head` — a review's own commits; a range with a *null* base lists
 * `head`'s whole history, which is how the picker shows a branch other than the one
 * checked out without comparing it to anything. */
export const LogRequest = z.object({ repoPath: RepoPath, range: LogRange.nullable() });
export type LogRequest = z.infer<typeof LogRequest>;

export const DiffRequest = z.object({ repoPath: RepoPath, selection: DiffSelection });
export type DiffRequest = z.infer<typeof DiffRequest>;

/** Where to read a file's full text from, for expanding the unchanged lines around a
 * hunk. `ref` reads a blob at a
 * sha/branch; `parentOf` reads the old side of a single-commit or commit-range diff
 * (`<commit>^`, the very base git diffs a range against, `resolveRangeBase`); `head`
 * reads the old side of an uncommitted diff; `worktree` reads its new side straight
 * off disk (the file `git diff` itself compared against — no ref names it). Every arm
 * resolves to a safe `git show <validated>:<path>` or a traversal-checked disk read:
 * a `CommitSha` is hex-only and a `ReviewRef` deny-lists flags, so no rev-expression
 * crosses the spawn boundary unvalidated, and `^`/`HEAD` are fixed literals. */
export const FileContentsSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ref"), ref: ReviewRef }),
  z.object({ kind: z.literal("parentOf"), commit: CommitSha }),
  z.object({ kind: z.literal("head") }),
  z.object({ kind: z.literal("worktree") }),
]);
export type FileContentsSource = z.infer<typeof FileContentsSource>;

/** Read one file's full text from a source, for expanding unchanged context. */
export const FileContentsRequest = z.object({
  repoPath: RepoPath,
  source: FileContentsSource,
  path: FilePath,
});
export type FileContentsRequest = z.infer<typeof FileContentsRequest>;

export const OpenRepoResponse = GitResultOf(OpenRepoOutcome);
export type OpenRepoResponse = GitResult<OpenRepoOutcome>;

export const BranchesResponse = GitResultOf(BranchList);
export type BranchesResponse = GitResult<BranchList>;

export const LogResponse = GitResultOf(CommitLog);
export type LogResponse = GitResult<CommitLog>;

export const DiffResponse = GitResultOf(Patch);
export type DiffResponse = GitResult<Patch>;

export const FileContentsResponse = GitResultOf(FileAtRef);
export type FileContentsResponse = GitResult<FileAtRef>;
