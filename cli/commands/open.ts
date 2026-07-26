import { statSync } from "node:fs";
import { resolve } from "node:path";
import { buildCommand } from "@stricli/core";
import { REVIEW_EXTENSION } from "../../src/shared/review-file";
import { launchReviewer } from "../launch";
import { EXIT_READY, type LocalContext } from "../context";
import { errorMessage, writeCannotRun } from "../errors";

// `rvw open <artifact>` — hand a finished `.reviewer.json` to the installed Reviewer. `rvw
// emit` already opens what it writes, so this is the verb for everything else: re-opening an
// artifact from `~/.rvw/reviews`, one that arrived from elsewhere, or one whose launch failed
// the first time. The app owns every arrival path already (cold-start argv, `second-instance`,
// `open-file`); this verb is only the launch.
//
// It deliberately does *not* re-validate the artifact's contents — that is `rvw check`'s job
// and the app's own import guard's, and duplicating the parse here would be a drifting third
// authority. So `open` only proves the path *is a review file that exists* (extension, then
// existence and kind, the same order the app's guard checks in) before launching. Its exit
// codes are therefore only 0 and 2: it either launches (0) or could not (2 — wrong path, app
// not installed, unsupported platform), never "runs and finds review problems".

type OpenFlags = {
  readonly json?: boolean;
};

/** What `--json` reports on a successful launch: the absolute path handed to the app. Named
 * like the other verbs' wire shapes so an agent parses one declared contract. There is no
 * failure arm here — a failed open is a shell-cannot-run (exit 2), reported under `--json` as
 * the shared `{ok:false,error:{code,message}}` envelope, never as a "ran, found problems"
 * document. */
type OpenReport = {
  readonly ok: true;
  readonly path: string;
};

export const openCommand = buildCommand<OpenFlags, [string], LocalContext>({
  docs: {
    brief: "Open a finished .reviewer.json in the installed Reviewer app",
    fullDescription: [
      "Hands the artifact to the installed Reviewer, which imports it and reveals it — the",
      "authoring loop's final step, so an emitted review opens without a manual File → Open. The",
      "path must end .reviewer.json and name a readable file; the app is the authority on the",
      "contents, so `open` validates the path but not the review (run `rvw check` for that). The",
      "app is launched by bundle id, so it is found wherever installed and the same running app is",
      "reused if one is open. Exit 0 once the app has been asked to open it; exit 2 when the path",
      "is not a readable .reviewer.json, the app is not installed, or this platform has no Reviewer",
      "build. macOS today.",
    ].join("\n"),
    customUsage: ["change.reviewer.json", "change.reviewer.json --json"],
  },
  parameters: {
    flags: {
      json: {
        kind: "boolean",
        brief: "On success, emit the launched artifact path as JSON on stdout",
        optional: true,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [{ brief: "Path to the .reviewer.json artifact to open", parse: String }],
    },
  },
  func(this: LocalContext, flags: OpenFlags, artifact: string): void {
    // Extension first, before touching disk — the same order the app's import guard checks:
    // a path that is not a review is refused without a stat, and the message names the rule.
    if (!artifact.endsWith(REVIEW_EXTENSION)) {
      writeCannotRun(this, flags.json, {
        code: "badArtifactPath",
        message: `${artifact} is not a review — the path must end ${REVIEW_EXTENSION}`,
      });
      return;
    }

    const path = resolve(artifact);
    let stats;
    try {
      stats = statSync(path);
    } catch (error) {
      writeCannotRun(this, flags.json, {
        code: "badArtifactPath",
        message: `cannot open ${path}: ${errorMessage(error)}`,
      });
      return;
    }
    if (!stats.isFile()) {
      writeCannotRun(this, flags.json, {
        code: "badArtifactPath",
        message: `cannot open ${path}: not a file`,
      });
      return;
    }

    const launched = launchReviewer(process.platform, path);
    if (!launched.ok) {
      writeCannotRun(this, flags.json, { code: "notInstalled", message: launched.message });
      return;
    }

    if (flags.json === true) {
      const report: OpenReport = { ok: true, path };
      this.process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      this.process.stdout.write(`opening ${path} in Reviewer\n`);
    }
    this.process.exitCode = EXIT_READY;
  },
});
