import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Switch } from "@/components/ui/switch";
import { clamp } from "../../../../shared/clamp";
import type { NumberRange } from "../../../../shared/settings";
import type { SelectOption } from "@/lib/settings-catalog";

// The four controls a settings row can carry, one per `SettingEntry` kind. Each takes the
// current value and reports a new one; none of them knows which setting it edits, so a row
// can switch on `kind` and hand the key back to the store itself.
//
// The number field commits on blur and on ⏎ rather than on every keystroke: a font size being
// typed passes through "1" on its way to "14", and re-laying the diff out on each of those is
// a flicker the reader did not ask for. Esc puts the field back to the committed value.

/** An enum setting: the current option's label on a button, the options as a radio list. A
 * dropdown menu rather than a native <select>, because the theme menu already was one and a
 * settings row should look like the control it replaced. The list scrolls past a screen's
 * worth of rows, which the font picker on a well-stocked machine reaches. */
export function SelectControl<Value extends string>({
  value,
  options,
  label,
  onChange,
  optionStyle,
}: {
  value: Value;
  options: readonly SelectOption<Value>[];
  /** Names the control for assistive tech; the visible text is the chosen option. */
  label: string;
  onChange: (value: Value) => void;
  /** Per-option inline style, for a list whose options are best shown as themselves. */
  optionStyle?: (value: Value) => CSSProperties;
}): ReactElement {
  const current = options.find((option) => option.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" className="w-52 justify-between" aria-label={label} />}
      >
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={4}
        // Sized to the widest option rather than to the trigger: a font name is as long as
        // its foundry made it, and a wrapped one reads as two fonts.
        className="max-h-[min(24rem,60vh)] w-auto min-w-52 overflow-y-auto"
      >
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            // The menu only lists our own options, so the string it hands back is one of them.
            const chosen = options.find((option) => option.value === next);
            if (chosen !== undefined) {
              onChange(chosen.value);
            }
          }}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              className="min-h-7 whitespace-nowrap"
              style={optionStyle?.(option.value)}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A draft that follows the committed value until the reader starts typing, and returns to
 * it on Esc or when the commit is refused. */
function useDraft(committed: string): [string, (draft: string) => void] {
  const [draft, setDraft] = useState(committed);
  useEffect(() => {
    setDraft(committed);
  }, [committed]);
  return [draft, setDraft];
}

/** A bounded number. What the reader types is clamped into the range on commit rather than
 * refused: "40" for a font size means "as big as it goes", and the field showing 32 says so.
 * Anything that is not a number at all is dropped and the field goes back to the value. */
export function NumberControl({
  value,
  range,
  unit,
  label,
  onChange,
}: {
  value: number;
  range: NumberRange;
  unit: string;
  label: string;
  onChange: (value: number) => void;
}): ReactElement {
  const [draft, setDraft] = useDraft(String(value));

  const commit = (): void => {
    const parsed = Number(draft.trim());
    if (draft.trim() === "" || Number.isNaN(parsed)) {
      setDraft(String(value));
      return;
    }
    const bounded = clamp(parsed, range.min, range.max);
    // Whole-number settings stay whole; the others are held to the stepper's own precision so
    // 1.4999999 never lands on disk.
    const decimals = range.step >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(range.step)));
    const rounded = Number(bounded.toFixed(decimals));
    setDraft(String(rounded));
    if (rounded !== value) {
      onChange(rounded);
    }
  };

  return (
    <InputGroup className="w-32">
      <InputGroupInput
        type="number"
        inputMode="decimal"
        min={range.min}
        max={range.max}
        step={range.step}
        value={draft}
        aria-label={label}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            // Only the draft is discarded: the dialog's own Esc stays closed off so a stray
            // press while editing does not take the whole sheet down.
            event.stopPropagation();
            setDraft(String(value));
          }
        }}
      />
      <InputGroupAddon align="inline-end">{unit}</InputGroupAddon>
    </InputGroup>
  );
}

/** The code font, from the monospace families the machine has (`lib/local-fonts`). A value
 * that is not on the list — a font since uninstalled, a hand edit of settings.json — still
 * shows as the current choice rather than as nothing, and stays pickable so a reader can put
 * it back after trying another. Each option is drawn in its own face, which is the whole
 * question a font picker answers. */
export function FontControl({
  value,
  fonts,
  label,
  onChange,
}: {
  value: string;
  fonts: readonly string[];
  label: string;
  onChange: (value: string) => void;
}): ReactElement {
  const options: readonly SelectOption<string>[] = (
    fonts.includes(value) ? fonts : [...fonts, value]
  ).map((family) => ({ value: family, label: family }));
  return (
    <SelectControl
      value={value}
      options={options}
      label={label}
      onChange={onChange}
      optionStyle={(family) => ({ fontFamily: `"${family}", monospace` })}
    />
  );
}

export function BooleanControl({
  value,
  label,
  onChange,
}: {
  value: boolean;
  label: string;
  onChange: (value: boolean) => void;
}): ReactElement {
  return <Switch checked={value} aria-label={label} onCheckedChange={onChange} />;
}
