export const notificationDurationMs = 5_000;

export function DismissCountdown({ durationMs }: { durationMs: number }) {
  return (
    <span
      aria-hidden="true"
      className="dismiss-countdown"
      style={{ animationDuration: `${durationMs}ms` }}
    />
  );
}
