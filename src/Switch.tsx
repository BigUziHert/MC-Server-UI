import type { ReactNode } from "react";
export default function Switch({
  checked,
  onCheckedChange,
  label,
  disabled,
  id,
  className = "",
  "aria-label": accessibleLabel,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={accessibleLabel}
      disabled={disabled}
      className={`shared-switch ${className}`}
      onClick={() => onCheckedChange(!checked)}
    >
      <span className="shared-switch-track" aria-hidden="true">
        <span />
      </span>
      <span>{label}</span>
    </button>
  );
}
