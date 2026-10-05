import { describe, expect, it } from "vitest";
import { EXPOSING_SWITCHES, exposingSwitches } from "./exposure";

// Which launches expose the running app: a packaged app started with a debugging, network-logging
// or traffic-redirecting switch (or `SSLKEYLOGFILE`) — never an unpackaged one, where a developer
// means to have them.

const NONE = {
  hasSwitch: () => false,
  argv: ["/Applications/Reviewer.app/Contents/MacOS/Reviewer"],
  env: {},
};

describe("exposingSwitches", () => {
  it("names nothing for a normal launch", () => {
    expect(exposingSwitches({ ...NONE, packaged: true })).toEqual([]);
  });

  it("names a debugging port, by name and never by value", () => {
    expect(
      exposingSwitches({
        ...NONE,
        packaged: true,
        hasSwitch: (name) => name === "remote-debugging-port",
      }),
    ).toEqual(["remote-debugging-port"]);
  });

  it("names the net log and its sensitive capture mode, and a key log in the environment", () => {
    expect(
      exposingSwitches({
        packaged: true,
        hasSwitch: () => false,
        argv: ["Reviewer", "--log-net-log=/tmp/n.json", "--net-log-capture-mode=IncludeSensitive"],
        env: { SSLKEYLOGFILE: "/tmp/keys" },
      }),
    ).toEqual(["log-net-log", "net-log-capture-mode", "SSLKEYLOGFILE"]);
  });

  it("does not mistake a longer switch for one it begins", () => {
    expect(
      exposingSwitches({
        ...NONE,
        packaged: true,
        argv: ["Reviewer", "--v8-flags=x", "--inspector"],
      }),
    ).toEqual([]);
  });

  it("covers the switches the review named", () => {
    for (const name of [
      "remote-debugging-port",
      "remote-debugging-pipe",
      "remote-debugging-address",
      "log-net-log",
      "net-log-capture-mode",
    ]) {
      expect(EXPOSING_SWITCHES, name).toContain(name);
    }
  });

  it("reads Chromium's single-dash spelling too, and Electron's logging and tracing", () => {
    expect(
      exposingSwitches({
        packaged: true,
        hasSwitch: () => false,
        argv: ["Reviewer", "-remote-debugging-port=9222", "--trace-startup", "-enable-tracing"],
        env: { ELECTRON_ENABLE_LOGGING: "1", ELECTRON_LOG_FILE: "/tmp/e.log" },
      }),
    ).toEqual([
      "remote-debugging-port",
      "trace-startup",
      "enable-tracing",
      "ELECTRON_ENABLE_LOGGING",
      "ELECTRON_LOG_FILE",
    ]);
    expect(
      exposingSwitches({
        ...NONE,
        packaged: true,
        hasSwitch: (name) => name === "trace-startup-file",
      }),
    ).toEqual(["trace-startup-file"]);
  });

  it("is always empty unpackaged", () => {
    expect(
      exposingSwitches({
        packaged: false,
        hasSwitch: () => true,
        argv: [],
        env: { SSLKEYLOGFILE: "x" },
      }),
    ).toEqual([]);
  });
});
