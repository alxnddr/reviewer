import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { assertNever } from "../../../../shared/assert";
import type { ResolvedSettings, Settings, SettingsPatch } from "../../../../shared/settings";
import { settingPatch, type SettingEntry } from "@/lib/settings-catalog";
import {
  BooleanControl,
  FontControl,
  NumberControl,
  SelectControl,
} from "@/components/settings/SettingControl";

// One settings row: the label and its sentence on the left, the control on the right, and a
// Reset between them that only exists while the value is the reader's rather than the
// default. Takes what it shows as props — it is drawn once per entry, and the rule for rail
// rows (ReviewRail.tsx) holds here for the same reason.

type SettingRowProps = {
  entry: SettingEntry;
  /** What is applied right now. */
  resolved: ResolvedSettings;
  /** What is stored: the row is "modified" exactly when its key is present here. */
  stored: Settings;
  /** The monospace families installed here, for the font row (`lib/local-fonts`). */
  fonts: readonly string[];
  onChange: (patch: SettingsPatch) => void;
};

/** The control for an entry's kind, with the entry's own key folded into every change. The
 * switch has no default on purpose: a new kind in the catalog has to be drawn here before the
 * build passes. */
function control(
  entry: SettingEntry,
  resolved: ResolvedSettings,
  fonts: readonly string[],
  onChange: (patch: SettingsPatch) => void,
): ReactElement {
  switch (entry.kind) {
    case "select":
      return (
        <SelectControl
          value={resolved[entry.key]}
          options={entry.options}
          label={entry.label}
          onChange={(value) => onChange(settingPatch(entry.key, value))}
        />
      );
    case "number":
      return (
        <NumberControl
          value={resolved[entry.key]}
          range={entry.range}
          unit={entry.unit}
          label={entry.label}
          onChange={(value) => onChange(settingPatch(entry.key, value))}
        />
      );
    case "font":
      return (
        <FontControl
          value={resolved[entry.key]}
          fonts={fonts}
          label={entry.label}
          onChange={(value) => onChange(settingPatch(entry.key, value))}
        />
      );
    case "boolean":
      return (
        <BooleanControl
          value={resolved[entry.key]}
          label={entry.label}
          onChange={(value) => onChange(settingPatch(entry.key, value))}
        />
      );
    default:
      return assertNever(entry);
  }
}

export function SettingRow({
  entry,
  resolved,
  stored,
  fonts,
  onChange,
}: SettingRowProps): ReactElement {
  const modified = stored[entry.key] !== undefined;
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-medium text-foreground">{entry.label}</span>
          {modified && (
            <Button
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-sm text-text-muted"
              aria-label={`Reset ${entry.label} to its default`}
              onClick={() => onChange(settingPatch(entry.key, undefined))}
            >
              Reset
            </Button>
          )}
        </div>
        <p className="mt-0.5 max-w-prose text-sm leading-snug text-text-muted">
          {entry.description}
        </p>
      </div>
      <div className="flex shrink-0 items-center self-center">
        {control(entry, resolved, fonts, onChange)}
      </div>
    </div>
  );
}
