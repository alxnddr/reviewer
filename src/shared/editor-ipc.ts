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

export const EditorOpenRequest = z.object({
  sessionId: SessionId,
  /** Repo-relative, as the diff names it (`PatchFile.path`). Untrusted until main has resolved
   * it and proven it lands inside the session's checkout. */
  path: z.string().min(1),
  /** A new-file line to land on; absent opens the file alone. New-file, because that is the
   * file on disk — a deletions-side anchor is translated before it gets here
   * (`lib/editor-target.ts`). */
  line: z.int().positive().optional(),
});
export type EditorOpenRequest = z.infer<typeof EditorOpenRequest>;

/** Why a file was not opened. Ordered as main checks them: the session → whether it reads a
 * checkout at all → whether an editor is chosen → where the path lands → whether a file is there.
 * Each is a distinct sentence the reader can act on (`lib/editor-open-failure-message.ts`);
 * none is a crash. */
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
   * moved on), or something that is not a file. */
  z.object({ code: z.literal("missing") }),
]);
export type EditorOpenFailure = z.infer<typeof EditorOpenFailure>;

export const EditorOpenResponse = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), failure: EditorOpenFailure }),
]);
export type EditorOpenResponse = z.infer<typeof EditorOpenResponse>;
