import { formatDuration, remainingPercent } from "@t3tools/shared/usageLimits";
import { RotateCcwIcon } from "lucide-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { WindowBar, barColor } from "../usage/UsageLimits";

/** The selected instance's own account, the one its models spend, from the last published snapshot. */
export function ModelPickerUsageLimits({ entry }: { readonly entry: ProviderInstanceEntry }) {
  const now = Date.parse(`${useNowMinute()}Z`);
  const windows = entry.snapshot.usageLimits?.windows ?? [];
  if (windows.length === 0) return null;
  const color = barColor(entry.driverKind);
  return (
    <section
      aria-label={`${entry.displayName} usage limits`}
      className="grid shrink-0 grid-cols-[minmax(0,1fr)_3.5rem_auto_auto] items-center gap-x-2 border-t border-border/70 px-3 py-1.5 text-xs"
    >
      {windows.map((window) => {
        const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
        return (
          <div key={window.id} className="contents">
            <span className="truncate text-muted-foreground">{window.label}</span>
            <WindowBar color={color} window={window} now={now} />
            <span className="text-end font-medium text-foreground tabular-nums">
              {remainingPercent(window)}% left
            </span>
            {Number.isFinite(resetsAt) ? (
              <span className="flex items-center justify-end gap-0.5 text-muted-foreground tabular-nums">
                <RotateCcwIcon className="size-3" aria-hidden />
                <span className="sr-only">Resets in </span>
                {formatDuration(resetsAt - now)}
              </span>
            ) : (
              <span />
            )}
          </div>
        );
      })}
    </section>
  );
}
