import type { ReactNode } from "react";
import { AlertCircle, Inbox, LoaderCircle } from "lucide-react";
export default function StatePanel({
  variant,
  title,
  message,
  icon,
  action,
  onRetry,
  className = "",
}: {
  variant: "loading" | "error" | "empty";
  title: string;
  message?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={`state-panel state-panel-${variant} ${className}`}
      role={
        variant === "error"
          ? "alert"
          : variant === "loading"
            ? "status"
            : undefined
      }
    >
      {icon ??
        (variant === "loading" ? (
          <LoaderCircle size={24} className="spin" />
        ) : variant === "error" ? (
          <AlertCircle size={24} />
        ) : (
          <Inbox size={24} />
        ))}
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {variant === "error" && onRetry ? (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      ) : (
        action
      )}
    </div>
  );
}
