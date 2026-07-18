/** The message of a caught `unknown`, without letting a non-Error throw stringify to
 * `[object Object]`. Every shell effect in the CLI (reading an artifact, spawning git,
 * writing an output file) reports its failure through this, so a caller reads one message
 * shape whichever verb produced it. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether a caught `unknown` is the filesystem's "no such file". The one error a reader
 * may treat as an answer rather than a failure: absence. Every other `readFileSync` error
 * (permissions, a directory where a file belongs, a symlink loop) means the path exists
 * and could not be read — a broken install, not a missing one. */
export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
