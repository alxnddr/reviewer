import { shell } from "electron";

// Only web links ever leave the app; anything else (file:, javascript:, custom
// schemes) is dropped so a hostile patch/artifact can't reach the OS through a link.
export function isAllowedExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:";
}

export function openExternalUrl(url: string): void {
  if (isAllowedExternalUrl(url)) {
    void shell.openExternal(url);
  }
}
