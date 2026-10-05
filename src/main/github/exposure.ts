// Whether this run of the app can be read from outside: started with a switch that hands another
// program its window, its memory or its network traffic. While it can, main refuses to take a
// token and refuses to post (`debuggingEnabled`, `handlers.ts`), and Settings ▸ GitHub says which
// switch (`github:status`'s `exposedBy`). The app keeps running — nothing else in it holds a
// secret — and the reader is told to quit and open it normally.
//
// **Why the fuses are not enough.** C0's fuses turn off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and
// Node's `--inspect` arguments, which close the ways to run code *as* Reviewer. Chromium's own
// switches are a different door: `open -a Reviewer --args --remote-debugging-port=9222` lets any
// process on the machine drive the window over the DevTools protocol — read the token field as it
// is typed, and press Post on the reader's behalf — and `--log-net-log` with
// `--net-log-capture-mode=IncludeSensitive` writes every request, `Authorization` header included,
// to a file. An agent running as the reader can relaunch the app with either. So the switches are
// read at start, and their presence switches the token off for the run.
//
// **What is checked, and why each.** By name only, never by value:
//
//   - the DevTools protocol: `remote-debugging-port`, `remote-debugging-pipe`,
//     `remote-debugging-address`, `remote-allow-origins`, `auto-open-devtools-for-tabs`;
//   - Node's inspector, in case a fuse is ever turned back on: `inspect`, `inspect-brk`,
//     `inspect-port`, `inspect-publish-uid`;
//   - network logs: `log-net-log`, `net-log-capture-mode`, and Chromium's verbose logging
//     (`enable-logging`, `v`, `vmodule`, and Electron's `ELECTRON_ENABLE_LOGGING` /
//     `ELECTRON_LOG_FILE` variables), whose network modules can print request details;
//   - traces: `trace-startup`, `trace-startup-file`, `enable-tracing`, which record the
//     process's internals to a file;
//   - the ways to read or redirect the TLS that carries the token: `ssl-key-log-file` and the
//     `SSLKEYLOGFILE` environment variable (session keys to a file), `ignore-certificate-errors`
//     and its `-spki-list` (a man in the middle is accepted), and `proxy-server`, `proxy-pac-url`,
//     `host-rules`, `host-resolver-rules` (api.github.com sent somewhere else). The system's own
//     proxy settings are not a switch and are honoured as before — that is a corporate network's
//     business, and it still has to present a certificate this Mac trusts.
//
// **Packaged builds only.** `bun run dev` starts Electron with its own debugging switches, and a
// developer is the one person who means to have them.
//
// **What it does not cover.** A debugger attached to the running process (`lldb -p`) reads its
// memory regardless of switches. Blocking that is the hardened runtime, which arrives with code
// signing; until then the threat model's rule 4 holds — the token is kept for one launch only.

export const EXPOSING_SWITCHES = [
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-address",
  "remote-allow-origins",
  "auto-open-devtools-for-tabs",
  "inspect",
  "inspect-brk",
  "inspect-port",
  "inspect-publish-uid",
  "log-net-log",
  "net-log-capture-mode",
  "enable-logging",
  "v",
  "vmodule",
  "ssl-key-log-file",
  "ignore-certificate-errors",
  "ignore-certificate-errors-spki-list",
  "proxy-server",
  "proxy-pac-url",
  "host-rules",
  "host-resolver-rules",
  "trace-startup",
  "trace-startup-file",
  "enable-tracing",
] as const;

export const EXPOSING_ENVIRONMENT = [
  "SSLKEYLOGFILE",
  "ELECTRON_ENABLE_LOGGING",
  "ELECTRON_LOG_FILE",
] as const;

export type ExposureInput = {
  packaged: boolean;
  /** Chromium's view of the command line (`app.commandLine.hasSwitch`). */
  hasSwitch: (name: string) => boolean;
  /** The raw arguments, for a switch Chromium does not report (Node's own) — read in both of
   * Chromium's spellings, `--name` and `-name`, with or without `=value`. */
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
};

/** The switches and variables that expose this run, by name — empty when none, and always
 * empty unpackaged. */
export function exposingSwitches(input: ExposureInput): string[] {
  if (!input.packaged) {
    return [];
  }
  const inArgv = (name: string): boolean =>
    input.argv.some((arg) =>
      ["--", "-"].some((dash) => arg === `${dash}${name}` || arg.startsWith(`${dash}${name}=`)),
    );
  return [
    ...EXPOSING_SWITCHES.filter((name) => input.hasSwitch(name) || inArgv(name)),
    ...EXPOSING_ENVIRONMENT.filter((name) => (input.env[name] ?? "") !== ""),
  ];
}
