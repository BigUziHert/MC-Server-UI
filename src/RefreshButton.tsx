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
}: {
  label: string;
  refreshing?: boolean;
  disabled?: boolean;
  onRefresh: () => Promise<boolean | void>;
  notify?: PageProps["notify"];
  successMessage?: string;
}) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className="btn icon"
      aria-label={label}
      title={label}
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
