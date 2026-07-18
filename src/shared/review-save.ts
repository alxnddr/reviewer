import * as z from "zod";

// The export-a-review IPC contract: the renderer serializes the curated review to a
// string (pure generators) and hands it here; main owns the native save sheet and the
// disk write, so no fs API and no file path is reachable from the sandboxed renderer.
// Every fs error is mapped to a typed failure — a raw error never crosses IPC,
// mirroring the git and review-open envelopes.

/** A save request: the already-serialized artifact/markdown plus a suggested
 * filename. `defaultName` is only the sheet's pre-fill — the user picks the real
 * path — but it is renderer-supplied and untrusted, so it is constrained to a
 * bare filename (no path separators or NULs) rather than allowing a directory
 * traversal to preselect a location outside the picker's intent. */
export const ReviewSaveRequest = z.object({
  content: z.string(),
  defaultName: z
    .string()
    .min(1)
    .refine((name) => !name.includes("/") && !name.includes("\\") && !name.includes("\0"), {
      error: "Default filename must not contain a path separator",
    }),
});
export type ReviewSaveRequest = z.infer<typeof ReviewSaveRequest>;

/** The success shape: a written file names the chosen path; a dismissed sheet is
 * `canceled`, which writes nothing (not a failure). */
export const ReviewSaveOutcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("saved"), path: z.string() }),
  z.object({ kind: z.literal("canceled") }),
]);
export type ReviewSaveOutcome = z.infer<typeof ReviewSaveOutcome>;

/** Why a save could not complete. A single code today (any fs error maps here);
 * the union keeps the shape extensible without reshaping the wire, like GitFailure. */
export const ReviewSaveFailure = z.discriminatedUnion("code", [
  z.object({ code: z.literal("writeFailed") }),
]);
export type ReviewSaveFailure = z.infer<typeof ReviewSaveFailure>;

/** Response envelope: the renderer always receives a discriminated result, never a
 * rejected promise carrying a stringified fs error. */
export const ReviewSaveResponse = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: ReviewSaveOutcome }),
  z.object({ ok: z.literal(false), failure: ReviewSaveFailure }),
]);
export type ReviewSaveResponse = z.infer<typeof ReviewSaveResponse>;
