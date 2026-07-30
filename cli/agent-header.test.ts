import { describe, expect, it } from "vitest";
import { AGENT_HEADER, wantsAgentHeader, writeAgentHeader } from "./agent-header";
import type { LocalContext } from "./context";

function capturing(): { context: LocalContext; written: () => string } {
  let out = "";
  return {
    context: {
      process: {
        stdout: { write: (chunk: string) => void (out += chunk) },
        stderr: { write: () => {} },
        exitCode: null,
      } as unknown as LocalContext["process"],
    },
    written: () => out,
  };
}

describe("the agent header", () => {
  it("greets the invocations that are asking what this command is", () => {
    expect(wantsAgentHeader([])).toBe(true);
    expect(wantsAgentHeader(["--help"])).toBe(true);
    expect(wantsAgentHeader(["-h"])).toBe(true);
    expect(wantsAgentHeader(["help"])).toBe(true);
  });

  it("stays out of every invocation that is doing work", () => {
    // The load-bearing case: a header above `--json` output lands in something's parser.
    expect(wantsAgentHeader(["diff", "--json"])).toBe(false);
    expect(wantsAgentHeader(["emit"])).toBe(false);
    expect(wantsAgentHeader(["skills", "present-review"])).toBe(false);
    // Per-command help belongs to that command: an agent asking for it already has the verb.
    expect(wantsAgentHeader(["emit", "--help"])).toBe(false);
  });

  it("names the skill to read, before anything else it says", () => {
    const { context, written } = capturing();
    writeAgentHeader(context, []);
    expect(written()).toBe(AGENT_HEADER);
    expect(written()).toContain("rvw skills present-review");
  });

  it("writes nothing when a verb was given", () => {
    const { context, written } = capturing();
    writeAgentHeader(context, ["schema", "--json"]);
    expect(written()).toBe("");
  });
});
