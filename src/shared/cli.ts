import * as z from "zod";

// Where the `rvw` launcher stands with the OS. The renderer never derives any of this — it
// is a filesystem fact about this machine, so main answers it and the guide only displays
// the answer.

/** `supported` is false where there is no install path to write at all (the launcher is a
 * /usr/local/bin shim, so: not macOS); `path` is stated even when nothing is installed,
 * because "where it goes" is half of what the reader is being asked to agree to. */
export const CliStatus = z.object({
  supported: z.boolean(),
  installed: z.boolean(),
  path: z.string(),
  /** Another `rvw` sitting in a directory shells usually search *before* ours, or null.
   *
   * Installing is not the same as winning. A launcher left over from an earlier setup — a
   * hand-rolled shim, a copy from another checkout — keeps answering to `rvw` while the app
   * reports itself installed, and the agent runs whatever that one points at. The reader is
   * then debugging a review that never arrives with every visible signal saying it should
   * have. Shortened with `~` because the sentence it lands in ends in a command to run. */
  shadowedBy: z.string().nullable(),
});
export type CliStatus = z.infer<typeof CliStatus>;

/** Why an install did not land, when it did not. Two causes, and they ask for different
 * things from the reader: `missingBundle` is a broken/undeveloped build (nothing they can
 * fix from here), `writeFailed` is the admin prompt cancelled or /usr/local/bin refusing —
 * which retrying can actually resolve. `null` with `status.installed` is the success case. */
export const CliInstallProblem = z.enum(["missingBundle", "writeFailed"]);
export type CliInstallProblem = z.infer<typeof CliInstallProblem>;

/** The state afterwards, plus why it is that state. The status is re-read from disk rather
 * than inferred from the shell's exit code, so a launcher that is there is reported as
 * installed however it got there. */
export const CliInstallResult = z.object({
  status: CliStatus,
  problem: CliInstallProblem.nullable(),
});
export type CliInstallResult = z.infer<typeof CliInstallResult>;
