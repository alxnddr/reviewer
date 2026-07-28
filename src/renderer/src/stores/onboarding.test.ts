import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliInstallResult, CliStatus } from "../../../shared/cli";
import type { ReviewerBridge } from "../../../shared/ipc";
import { ONBOARDING_STEPS, useOnboardingStore } from "./onboarding";

const MISSING: CliStatus = {
  supported: true,
  installed: false,
  path: "/usr/local/bin/rvw",
  shadowedBy: null,
};
const PRESENT: CliStatus = { ...MISSING, installed: true };

const INITIAL = useOnboardingStore.getState();

type BridgeStub = Pick<
  ReviewerBridge,
  "getOnboarded" | "getCliStatus" | "installCli" | "completeOnboarding"
>;

function stubBridge(overrides: Partial<BridgeStub> = {}): BridgeStub {
  const bridge: BridgeStub = {
    getOnboarded: vi.fn().mockResolvedValue(false),
    getCliStatus: vi.fn().mockResolvedValue(MISSING),
    installCli: vi
      .fn()
      .mockResolvedValue({ status: PRESENT, problem: null } satisfies CliInstallResult),
    completeOnboarding: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  vi.stubGlobal("window", { reviewer: bridge });
  return bridge;
}

afterEach(() => {
  vi.unstubAllGlobals();
  useOnboardingStore.setState(INITIAL, true);
});

describe("the first-run guide's state", () => {
  it("opens on an install that has never seen it, carrying the launcher's state with it", async () => {
    stubBridge();

    await useOnboardingStore.getState().hydrate();

    expect(useOnboardingStore.getState().open).toBe(true);
    expect(useOnboardingStore.getState().cli).toEqual(MISSING);
  });

  it("stays closed once it has run, but still learns where the launcher stands", async () => {
    // The banner outlives the guide and reads the same field, so the status has to arrive
    // even on the launch where nothing is going to open.
    stubBridge({
      getOnboarded: vi.fn().mockResolvedValue(true),
      getCliStatus: vi.fn().mockResolvedValue(PRESENT),
    });

    await useOnboardingStore.getState().hydrate();

    expect(useOnboardingStore.getState().open).toBe(false);
    expect(useOnboardingStore.getState().cli).toEqual(PRESENT);
  });

  it("does not close a guide the reader asked for while main was still answering", async () => {
    stubBridge({ getOnboarded: vi.fn().mockResolvedValue(true) });
    useOnboardingStore.getState().show();

    await useOnboardingStore.getState().hydrate();

    expect(useOnboardingStore.getState().open).toBe(true);
  });

  it("records completion when it closes, however it was closed", () => {
    const bridge = stubBridge();
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
    stubBridge({
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
    stubBridge({ getCliStatus: vi.fn().mockResolvedValue(PRESENT) });
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
