import * as z from "zod";
import { SessionId } from "./session";

// The wire contract for Open in Editor: what the renderer asks, and the ways main says no. Kept
// beside `review-ipc.ts` rather than inside it for the reason that file gives — this is what the
// two sides say to each other about an action, not what a review is.
//
// The request names a session rather than a repository. The renderer never holds a path it may
// hand to the OS: main looks the session up, takes *its* validated checkout as the root, and
// resolves the file inside that. A renderer that could name any directory would make the
// `validateRepo` gate on the open path (`main/review/handlers.ts`) meaningless for this channel.

/** What is being opened. A closed union rather than an optional `path` whose absence means
 * "the whole repository": those are two different asks with two different containment
 * questions behind them, and the optional spelling makes a *dropped* path — a projection that
 * forgot a field, a spread that came out empty — silently open the reader's entire worktree
 * instead of failing. The union cannot be reached by accident; naming the `repo` arm is the
 * only way to ask for it. */
export const EditorOpenRequest = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    sessionId: SessionId,
    /** Repo-relative, as the diff names it (`PatchFile.path`). Untrusted until main has resolved
     * it and proven it lands inside the session's checkout. */
    path: z.string().min(1),
    /** A new-file line to land on; absent opens the file alone. New-file, because that is the
     * file on disk — a deletions-side anchor is translated before it gets here
     * (`lib/editor-target.ts`). */
    line: z.int().positive().optional(),
  }),
  /** The session's checkout itself, handed over as a project — "open the worktree and browse
   * it". Carries no path at all: the root is main's own copy of where the session is, so there
   * is nothing here for the renderer to get wrong and nothing to contain. No line either; a
   * directory has none. */
  z.object({
    kind: z.literal("repo"),
    sessionId: SessionId,
  }),
]);
export type EditorOpenRequest = z.infer<typeof EditorOpenRequest>;

/** Why a file was not opened. Ordered as main checks them: the session → whether it reads a
 * checkout at all → whether an editor is chosen → where the path lands → whether a file is there.
 * Each is a distinct sentence the reader can act on (`lib/editor-open-failure-message.ts`);
 * none is a crash. The `repo` arm can reach every one of these but `outsideRepo`, which is a
 * question only a renderer-supplied path can raise. */
export const EditorOpenFailure = z.discriminatedUnion("code", [
  /** The id names no open session — a tab closed under a press. */
  z.object({ code: z.literal("noSession") }),
  /** A frozen review: its diff is the artifact's own copy and no checkout backs it, so there is
   * no file on disk to open. Locate Repository… is what changes that. */
  z.object({ code: z.literal("notLive") }),
  /** No editor picked in Settings. */
  z.object({ code: z.literal("noEditor") }),
  /** The path resolved — `..`, a symlink — to somewhere outside the session's checkout. */
  z.object({ code: z.literal("outsideRepo") }),
  /** Nothing on disk at that path in this checkout (a file the diff deleted, a checkout that
   * moved on), or something that is not a file. For the `repo` arm: the checkout itself is
   * gone, or is no longer a directory. */
  z.object({ code: z.literal("missing") }),
]);
export type EditorOpenFailure = z.infer<typeof EditorOpenFailure>;

export const EditorOpenResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), failure: EditorOpenFailure }),
]);
export type EditorOpenResponse = z.infer<typeof EditorOpenResponse>;
