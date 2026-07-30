import { useEffect, useState, type ReactElement } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Kbd } from "@/components/ui/kbd";
import { isEditable } from "@/lib/shortcut-guard";

// Every shortcut the app answers to, in one place, on the key everyone already tries.
//
// The app had accumulated a real keyboard vocabulary — j/k through the files, n/p through
// the comments, r to mark one read, o for the doc, ⌘F to find — and no way at all to learn
// it. Three of those keys ride a tooltip on the one control that performs the same action,
// which teaches a reader who was already reaching for that control with a mouse; it cannot
// teach the reader who never finds the control, and j/k had no control to ride at all.
//
// So the sheet is not a duplicate of those hints. It is the only surface that answers "what
// can I do without the mouse" as a question in its own right, and the tooltips stay because
// they answer a different one ("what is this button, and is there a faster way").
//
// It is glass and it floats above centre, which is the recents picker's treatment rather than
// the kit dialog's opaque slab — and for the recents picker's reason. This is a lens held up
// over the work to check something, not a thing to fill in and dismiss: the reader opened it
// mid-file to remember one key, and the diff staying visible behind it is what says they never
// left. The kit dialog is still right for everything that asks a question.

/** One row's worth: the keys, then what they do. Keys first, because the sheet is scanned
 * down its left edge by someone who half-remembers a chord, not read as sentences.
 *
 * Two keys mean one of two things and the row has to say which: `↑ ↓` is a choice (either
 * key, opposite directions), `⌘1 … ⌘9` is a range (and every key in between). `range`
 * picks the separator — an ellipsis spans, a bare gap alternates. A chord is never two
 * entries; it is one string inside one chip (`⇧⌘O`). */
type Shortcut = { keys: string[]; action: string; range?: boolean };

/** `note` is for the groups whose keys are not global — the two that only answer while one
 * particular thing holds focus. Without it the sheet's own promise ("single keys work
 * anywhere") reads as a claim about these too, and a reader who tries ↑ from the diff and
 * gets nothing has been told the app is broken rather than told where to press it. */
type Group = { title: string; note?: string; shortcuts: Shortcut[] };

/** Grouped the way the work is: moving through the change, then through its findings, then
 * the app's own windows. Within a group, the order is the order a reader meets them. */
const GROUPS: Group[] = [
  {
    title: "Reading",
    shortcuts: [
      { keys: ["J"], action: "Next file" },
      { keys: ["K"], action: "Previous file" },
      { keys: ["R"], action: "Mark the focused file read" },
      { keys: ["O"], action: "Open or close the overview" },
      { keys: ["F6"], action: "Next pane (⇧F6 back)" },
    ],
  },
  {
    title: "Comments",
    shortcuts: [
      { keys: ["N"], action: "Next comment" },
      { keys: ["P"], action: "Previous comment" },
      { keys: ["Esc"], action: "Stop stepping through comments" },
      // "the one you are on" is doing real work: this key needs a focused comment, and
      // pressing it without one is a no-op the reader would otherwise read as broken.
      { keys: ["⇧⌘C"], action: "Copy the comment you are on as a prompt" },
      { keys: ["⌥⇧⌘C"], action: "Copy every comment in the review as a prompt" },
    ],
  },
  {
    title: "Layers",
    // The tree owns these while it has focus, which F6 is how you give it.
    note: "While the layer list has focus",
    shortcuts: [
      { keys: ["↑", "↓"], action: "Step the list" },
      { keys: ["→", "←"], action: "Open or fold a group" },
      { keys: ["Esc"], action: "Clear the soloed layer" },
    ],
  },
  {
    title: "Find",
    note: "⏎ and ⇧⏎ work in the find field",
    shortcuts: [
      { keys: ["⌘F"], action: "Find in the diff" },
      { keys: ["⏎"], action: "Next match" },
      { keys: ["⇧⏎"], action: "Previous match" },
    ],
  },
  {
    title: "Windows",
    shortcuts: [
      { keys: ["⌘O"], action: "Open a repository" },
      { keys: ["⇧⌘O"], action: "Open a review" },
      { keys: ["⇧⌘R"], action: "Recent reviews" },
      { keys: ["⌘1", "⌘9"], action: "Switch to a tab by position", range: true },
      { keys: ["⌃⇥"], action: "Cycle tabs" },
      { keys: ["⌘W"], action: "Close the tab" },
    ],
  },
];

/** `?` opens the sheet from anywhere, and closes it again. Guarded like every other
 * single-key shortcut in the app: never inside a text field, never with a modifier — except
 * the shift the key itself is typed with, which is why this one takes `isEditable` directly
 * rather than the shared `shortcutBlocked`. It must also fire from *under* an open sheet,
 * since that sheet is the one this key takes down.
 *
 * `event.key` is already the shifted character, so this matches `?` on whatever layout the
 * reader has rather than a US-keyboard scancode. */
function useShortcutsShortcut(toggle: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditable(event.target)) {
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggle]);
}

/** The keyboard reference, on `?`. Mounted at the app level so it opens over whichever
 * surface the reader is on — the diff, the doc, or the empty state before any of them. */
export function ShortcutsDialog(): ReactElement {
  const [open, setOpen] = useState(false);
  useShortcutsShortcut(() => setOpen((value) => !value));

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        {/* The recents picker's backdrop, for its reason: this panel is itself translucent,
            and over an un-dimmed diff the code behind and the rows in front compete at the
            same contrast. */}
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/15 duration-150 supports-backdrop-filter:backdrop-blur-sm data-closed:animate-out data-closed:fade-out-0 data-open:animate-in data-open:fade-in-0" />
        {/* Held above centre rather than in it, so the sheet lands where the recents picker
            lands and the two read as one kind of surface. */}
        <DialogPrimitive.Popup
          data-glass
          className="fixed top-[12vh] left-1/2 z-50 flex max-h-[72vh] w-[min(40rem,calc(100%-4rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl duration-150 outline-none data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95"
        >
          <header className="flex flex-col gap-1 border-b border-foreground/10 px-5 py-4">
            <DialogPrimitive.Title className="text-base leading-none font-medium text-foreground">
              Keyboard shortcuts
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="text-sm text-text-muted">
              Single keys work anywhere except inside a text field.
            </DialogPrimitive.Description>
          </header>

          {/* Two columns on anything but the narrowest window: the list is short enough to
              read whole, and one tall column would push the last group under the fold for no
              reason. `break-inside-avoid` keeps a group from being split across the gap. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:columns-2 sm:gap-8">
            {GROUPS.map((group) => (
              <section key={group.title} className="mb-5 break-inside-avoid last:mb-0">
                <h3 className="text-xs font-medium tracking-wide text-text-muted uppercase">
                  {group.title}
                </h3>
                {group.note !== undefined && (
                  <p className="mt-0.5 text-xs text-text-faint">{group.note}</p>
                )}
                <dl className="mt-2 flex flex-col gap-1.5">
                  {group.shortcuts.map((shortcut) => (
                    <div key={shortcut.action} className="flex items-baseline gap-3">
                      {/* A fixed key column, so the actions line up into a readable edge
                          instead of ragging with every chord's width. */}
                      <dt className="flex w-[4.5rem] shrink-0 items-center gap-1">
                        {shortcut.keys.map((key, index) => (
                          <span key={key} className="flex items-center gap-1">
                            {index > 0 && shortcut.range === true && (
                              <span className="text-text-faint">…</span>
                            )}
                            <Kbd className="h-5.5 min-w-5.5 px-1.5 text-xs">{key}</Kbd>
                          </span>
                        ))}
                      </dt>
                      <dd className="min-w-0 text-sm leading-snug text-foreground">
                        {shortcut.action}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>

          {/* No `?` hint here — the reader pressed it to arrive, and a sheet that opens to
              tell you the key you just used is the one row on it nobody needs. */}
          <footer className="flex items-center justify-end border-t border-foreground/10 px-5 py-2 text-xs text-text-faint">
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd>
              close
            </span>
          </footer>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
