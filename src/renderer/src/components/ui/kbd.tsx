import type { ReactElement } from "react";

import { cn } from "@/lib/utils";

/** A keystroke, set as a key rather than spelled out in the sentence beside it. The shell's
 * tooltip already reserves a slot for these (`data-slot="kbd"` in `ui/tooltip.tsx` trims the
 * popup's trailing padding and rounds the chip), so a hint can name its shortcut without
 * turning into prose about one.
 *
 * The chip tints from `currentColor` rather than a fixed surface token, which is what lets
 * one component sit correctly on both sides of the app's only inversion: on a normal
 * surface it is a soft grey wash under dark ink, and inside the inverted tooltip it becomes
 * a light wash under light ink, with no variant to pick and nothing to keep in sync. */
export function Kbd({ children, className }: { children: string; className?: string }) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-sm bg-current/15 px-1 font-sans text-[11px] leading-none font-medium select-none",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** A hint that names an action and the key that performs it — the one shape every
 * shortcut-carrying tooltip in the app takes, so the key always lands in the same place. */
export function ShortcutHint({ action, keys }: { action: string; keys: string }): ReactElement {
  return (
    <>
      {action}
      <Kbd>{keys}</Kbd>
    </>
  );
}
