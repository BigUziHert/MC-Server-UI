import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { PageProps } from "./api";
export default function RefreshButton({
  label,
  refreshing = false,
  disabled = false,
  onRefresh,
  notify,
  successMessage,
  tooltip,
}: {
  label: string;
  refreshing?: boolean;
  disabled?: boolean;
  onRefresh: () => Promise<boolean | void>;
  notify?: PageProps["notify"];
  successMessage?: string;
  /** Hover text; a function is re-evaluated each time the pointer enters. */
  tooltip?: string | (() => string);
}) {
  const [pending, setPending] = useState(false);
  const [, setHoverTick] = useState(0);
  const title =
    typeof tooltip === "function" ? tooltip() : (tooltip ?? label);
  return (
    <button
      type="button"
      className="btn icon"
      aria-label={label}
      aria-busy={refreshing || pending}
      title={title}
      onMouseEnter={
        typeof tooltip === "function"
          ? () => setHoverTick((tick) => tick + 1)
          : undefined
      }
      disabled={disabled || refreshing || pending}
      onClick={async () => {
        if (pending) return;
        setPending(true);
        try {
          if ((await onRefresh()) !== false && successMessage)
            notify?.(successMessage);
        } catch (cause) {
          notify?.(
            cause instanceof Error
              ? cause.message
              : "Refresh failed. Try again.",
            true,
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <RefreshCw size={16} className={pending || refreshing ? "spin" : ""} />
    </button>
  );
}

/** Hover text for refresh buttons, e.g. "Refreshed: 5 minutes ago". */
export function refreshedTooltip(at: number | null) {
  if (at === null) return "Refreshed: never";
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  const unit = (value: number, name: string) =>
    `${value} ${name}${value === 1 ? "" : "s"}`;
  const ago =
    seconds < 60
      ? unit(seconds, "second")
      : seconds < 3600
        ? unit(Math.floor(seconds / 60), "minute")
        : seconds < 86400
          ? unit(Math.floor(seconds / 3600), "hour")
          : unit(Math.floor(seconds / 86400), "day");
  return `Refreshed: ${ago} ago`;
}
