import type { ReviewerBridge } from "../shared/ipc";

declare global {
  interface Window {
    // Absent outside Electron (the renderer also runs in a plain browser for
    // visual gates); every consumer must handle the undefined case.
    reviewer?: ReviewerBridge;
  }
}

// oxlint-disable-next-line unicorn/require-module-specifiers -- the empty export is what makes this ambient file a module, without which `declare global` is not legal
export {};
