export function DismissCountdown({ durationMs }: { durationMs: number }) {
  return (
    <span
      aria-hidden="true"
      className="dismiss-countdown"
      style={{ animationDuration: `${durationMs}ms` }}
    />
  );
}
