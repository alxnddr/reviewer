import type { ReviewerBridge } from "../shared/ipc";

declare global {
  interface Window {
    // Absent outside Electron (the renderer also runs in a plain browser for
    // visual gates); every consumer must handle the undefined case.
    reviewer?: ReviewerBridge;
  }
}

export {};
