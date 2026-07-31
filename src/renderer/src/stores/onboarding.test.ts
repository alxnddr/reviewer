import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliInstallResult, CliStatus } from "../../../shared/cli";
import type { ReviewerBridge } from "../../../shared/ipc";
import { stubBridge } from "./__fixtures__/bridge";
import { cliNoticeShowing, ONBOARDING_STEPS, useOnboardingStore } from "./onboarding";

const MISSING: CliStatus = {
  supported: true,
  installed: false,
  path: "/usr/local/bin/rvw",
  shadowedBy: null,
};
const PRESENT: CliStatus = { ...MISSING, installed: true };

const INITIAL = useOnboardingStore.getState();

/** The shared bridge fixture, aimed at a machine that has never run the app: the two answers
 * this store is about are the ones the fixture cannot default for it, since its own defaults
 * are the settled case (onboarded, launcher installed). Everything else — `installCli`
 * succeeding, `completeOnboarding` accepting — is the fixture's. */
function firstRunBridge(overrides: Partial<ReviewerBridge> = {}): ReviewerBridge {
  return stubBridge({
    getOnboarded: vi.fn().mockResolvedValue(false),
    getCliStatus: vi.fn().mockResolvedValue(MISSING),
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  useOnboardingStore.setState(INITIAL, true);
});

describe("the first-run guide's state", () => {
  it("opens on an install that has never seen it, carrying the launcher's state with it", async () => {
    firstRunBridge();

    await useOnboardingStore.getState().hydrate();

    expect(useOnboardingStore.getState().open).toBe(true);
    expect(useOnboardingStore.getState().cli).toEqual(MISSING);
  });

  it("stays closed once it has run, but still learns where the launcher stands", async () => {
    // The banner outlives the guide and reads the same field, so the status has to arrive
    // even on the launch where nothing is going to open.
    firstRunBridge({
      getOnboarded: vi.fn().mockResolvedValue(true),
      getCliStatus: vi.fn().mockResolvedValue(PRESENT),
    });

    await useOnboardingStore.getState().hydrate();

    expect(useOnboardingStore.getState().open).toBe(false);
    expect(useOnboardingStore.getState().cli).toEqual(PRESENT);
  });

  it("does not close a guide the reader asked for while main was still answering", async () => {
    firstRunBridge({ getOnboarded: vi.fn().mockResolvedValue(true) });
    useOnboardingStore.getState().show();

    await useOnboardingStore.getState().hydrate();

    expect(useOnboardingStore.getState().open).toBe(true);
  });

  it("records completion when it closes, however it was closed", () => {
    const bridge = firstRunBridge();
    useOnboardingStore.setState({ open: true });

    useOnboardingStore.getState().finish();

    expect(useOnboardingStore.getState().open).toBe(false);
    expect(bridge.completeOnboarding).toHaveBeenCalledOnce();
  });

  it("keeps the step inside the guide", () => {
    const { goTo, next, back } = useOnboardingStore.getState();

    back();
    expect(useOnboardingStore.getState().step).toBe(0);

    goTo(ONBOARDING_STEPS + 4);
    expect(useOnboardingStore.getState().step).toBe(ONBOARDING_STEPS - 1);

    next();
    expect(useOnboardingStore.getState().step).toBe(ONBOARDING_STEPS - 1);
  });

  it("takes the launcher's state from the install rather than assuming it worked", async () => {
    firstRunBridge({
      installCli: vi
        .fn()
        .mockResolvedValue({ status: MISSING, problem: "writeFailed" } satisfies CliInstallResult),
    });

    await useOnboardingStore.getState().installCli();

    expect(useOnboardingStore.getState().cli).toEqual(MISSING);
    expect(useOnboardingStore.getState().problem).toBe("writeFailed");
    expect(useOnboardingStore.getState().installing).toBe(false);
  });

  it("drops a stale complaint once the launcher turns up from somewhere else", async () => {
    firstRunBridge({ getCliStatus: vi.fn().mockResolvedValue(PRESENT) });
    useOnboardingStore.setState({ cli: MISSING, problem: "writeFailed" });

    await useOnboardingStore.getState().refreshCli();

    expect(useOnboardingStore.getState().cli).toEqual(PRESENT);
    expect(useOnboardingStore.getState().problem).toBeNull();
  });

  it("survives a bridgeless window — the preview harness runs without one", async () => {
    vi.stubGlobal("window", {});

    await expect(useOnboardingStore.getState().hydrate()).resolves.toBeUndefined();
    await expect(useOnboardingStore.getState().refreshCli()).resolves.toBeUndefined();
    expect(useOnboardingStore.getState().open).toBe(false);
  });
});

describe("cliNoticeShowing", () => {
  // The standing notice's own condition, asserted here because two surfaces depend on it: the
  // pill that renders it, and the start screen that has to hold room for it (it floats over
  // that screen's first line).
  const base = { cli: MISSING, open: false };

  it("is up while nothing is installed", () => {
    expect(cliNoticeShowing(base)).toBe(true);
  });

  it("is up while another launcher answers first, installed or not", () => {
    expect(cliNoticeShowing({ ...base, cli: { ...PRESENT, shadowedBy: "~/.local/bin/rvw" } })).toBe(
      true,
    );
  });

  it("is down once the launcher is reachable", () => {
    expect(cliNoticeShowing({ ...base, cli: PRESENT })).toBe(false);
  });

  it("is down before main has answered, and off macOS, where there is nothing to install", () => {
    expect(cliNoticeShowing({ ...base, cli: null })).toBe(false);
    expect(cliNoticeShowing({ ...base, cli: { ...MISSING, supported: false } })).toBe(false);
  });

  it("is down while the guide is up, which says it better", () => {
    expect(cliNoticeShowing({ ...base, open: true })).toBe(false);
  });

  it("has no way to be waved off — it stands until the launcher is reachable", () => {
    // The store carries no dismissal to pass in: an app that cannot receive a review is not a
    // preference the reader gets to switch off (see CliBanner).
    expect(cliNoticeShowing(base)).toBe(true);
    expect(cliNoticeShowing({ ...base, cli: { ...PRESENT, shadowedBy: null } })).toBe(false);
  });
});
