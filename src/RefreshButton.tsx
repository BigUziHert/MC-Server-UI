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
