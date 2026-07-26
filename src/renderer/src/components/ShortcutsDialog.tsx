import { useEffect, useState, type ReactElement } from "react";
import { Kbd } from "@/components/ui/kbd";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

/** One row's worth: the keys, then what they do. Keys first, because the sheet is scanned
 * down its left edge by someone who half-remembers a chord, not read as sentences.
 *
 * Two keys mean one of two things and the row has to say which: `↑ ↓` is a choice (either
 * key, opposite directions), `⌘1 … ⌘9` is a range (and every key in between). `range`
 * picks the separator — an ellipsis spans, a bare gap alternates. A chord is never two
 * entries; it is one string inside one chip (`⇧⌘O`). */
type Shortcut = { keys: string[]; action: string; range?: boolean };

type Group = { title: string; shortcuts: Shortcut[] };

/** Grouped the way the work is: moving through the change, then through its findings, then
 * the app's own windows. Within a group, the order is the order a reader meets them. */
const GROUPS: Group[] = [
  {
    title: "Reading",
    shortcuts: [
      { keys: ["J"], action: "Next file" },
      { keys: ["K"], action: "Previous file" },
      { keys: ["R"], action: "Mark the focused file read or unread" },
      { keys: ["O"], action: "Open or close the overview" },
      { keys: ["F6"], action: "Move between the sidebar and the diff" },
    ],
  },
  {
    title: "Comments",
    shortcuts: [
      { keys: ["N"], action: "Next comment" },
      { keys: ["P"], action: "Previous comment" },
      { keys: ["Esc"], action: "Stop stepping through comments" },
    ],
  },
  {
    title: "Layers",
    shortcuts: [
      // The tree owns these while it has focus, which F6 is how you give it.
      { keys: ["↑", "↓"], action: "Step the layer list (while it has focus)" },
      { keys: ["→", "←"], action: "Open or fold a layer group" },
      { keys: ["Esc"], action: "Clear the soloed layer" },
    ],
  },
  {
    title: "Find",
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
      { keys: ["⌘1", "⌘9"], action: "Switch to a tab by position", range: true },
      { keys: ["⌃⇥"], action: "Cycle tabs" },
      { keys: ["⌘W"], action: "Close the tab" },
    ],
  },
];

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

/** `?` opens the sheet from anywhere, and closes it again. Guarded like every other
 * single-key shortcut in the app: never inside a text field, never with a modifier — except
 * the shift the key itself is typed with, which is why this one cannot use the shared guard.
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
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Wider than the kit's default `sm:max-w-sm`: these rows are a key column and a
          sentence, and at the narrow width every second action wrapped to two lines, which
          turned a scannable table into a paragraph with keys in it. */}
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Single keys work anywhere except inside a text field.
          </DialogDescription>
        </DialogHeader>
        {/* Two columns on anything but the narrowest window: the list is short enough to
            read whole, and one tall column would push the last group under the fold for no
            reason. `break-inside-avoid` keeps a group from being split across the gap. */}
        <div className="max-h-[60vh] overflow-y-auto sm:columns-2 sm:gap-6">
          {GROUPS.map((group) => (
            <section key={group.title} className="mb-4 break-inside-avoid last:mb-0">
              <h3 className="mb-1.5 text-xs font-medium text-text-muted">{group.title}</h3>
              <dl className="flex flex-col gap-1">
                {group.shortcuts.map((shortcut) => (
                  <div key={shortcut.action} className="flex items-baseline gap-2">
                    {/* A fixed key column, so the actions line up into a readable edge
                        instead of ragging with every chord's width. */}
                    <dt className="flex w-16 shrink-0 items-center gap-1">
                      {shortcut.keys.map((key, index) => (
                        <span key={key} className="flex items-center gap-1">
                          {index > 0 && shortcut.range === true && (
                            <span className="text-text-faint">…</span>
                          )}
                          <Kbd>{key}</Kbd>
                        </span>
                      ))}
                    </dt>
                    <dd className="min-w-0 text-xs text-foreground">{shortcut.action}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
