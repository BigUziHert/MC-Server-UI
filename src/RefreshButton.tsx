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
    tooltip === undefined
      ? label
      : refreshing || pending
        ? "Refreshing…"
        : typeof tooltip === "function"
          ? tooltip()
          : tooltip;
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

/**
 * Hover text for refresh buttons, e.g. "Refreshed: 5 minutes ago".
 * Pass `loading` so the tooltip says "Refreshing…" while data is loading.
 * Anything under a minute is shown as 1 minute.
 */
export function refreshedTooltip(at: number | null, loading = false) {
  if (loading) return "Refreshing…";
  if (at === null) return "Refreshed: never";
  const minutes = Math.max(1, Math.floor((Date.now() - at) / 60000));
  const unit = (value: number, name: string) =>
    `${value} ${name}${value === 1 ? "" : "s"}`;
  const ago =
    minutes < 60
      ? unit(minutes, "minute")
      : minutes < 1440
        ? unit(Math.floor(minutes / 60), "hour")
        : unit(Math.floor(minutes / 1440), "day");
  return `Refreshed: ${ago} ago`;
}
