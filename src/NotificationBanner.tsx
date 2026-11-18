import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Check, X } from "lucide-react";
import { DismissCountdown, notificationDurationMs } from "./DismissCountdown";

type Notice = {
  owner: object;
  id: number;
  message: string;
  error: boolean;
  startedAt: number;
};
const NotificationContext = createContext<Dispatch<
  SetStateAction<Notice | null>
> | null>(null);

export function useNotify() {
  const setNotice = useContext(NotificationContext);
  if (!setNotice) throw new Error("Notifications require a workspace.");
  const owner = useRef({ active: true }).current;
  useLayoutEffect(() => {
    owner.active = true;
    return () => {
      // A late result from a closed server must stay in its original workspace.
      owner.active = false;
      setNotice((current) => (current?.owner === owner ? null : current));
    };
  }, [owner, setNotice]);
  return useCallback(
    (message: string, error = false) => {
      if (!owner.active) return;
      const startedAt = performance.now();
      setNotice((current) => ({
        owner,
        id: (current?.id ?? 0) + 1,
        message,
        error,
        startedAt,
      }));
    },
    [owner, setNotice],
  );
}

export function notificationHost() {
  // Native modal dialogs make the rest of the document inert.
  return (
    document.activeElement?.closest("dialog:modal") ??
    Array.from(document.querySelectorAll("dialog:modal")).at(-1) ??
    document.body
  );
}

function NotificationBanner({
  message,
  error,
  startedAt,
  onDismiss,
}: {
  message: string;
  error: boolean;
  startedAt?: number;
  onDismiss?: () => void;
}) {
  const [host, setHost] = useState(notificationHost);
  useLayoutEffect(() => {
    const observer = new MutationObserver(() => setHost(notificationHost()));
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    setHost(notificationHost());
    return () => observer.disconnect();
  }, []);
  // Moving into or out of a dialog remounts the bar. Resume at its elapsed time.
  const animationDelay = useMemo(
    () => (startedAt === undefined ? 0 : startedAt - performance.now()),
    [host, startedAt],
  );
  return createPortal(
    <div
      className={`panel notification-banner${error ? " error" : ""}`}
      role={error ? "alert" : "status"}
      aria-label="Notification"
      style={{ "--notification-delay": `${animationDelay}ms` } as CSSProperties}
    >
      {error ? <AlertCircle size={20} /> : <Check size={20} />}
      <span>{message}</span>
      {onDismiss && (
        <button
          className="btn icon"
          type="button"
          aria-label="Dismiss notification"
          onClick={onDismiss}
        >
          <X size={16} />
        </button>
      )}
      {startedAt !== undefined && (
        <DismissCountdown durationMs={notificationDurationMs} />
      )}
    </div>,
    host,
  );
}

export function NotificationProvider({
  children,
  connectionError,
}: {
  children: ReactNode;
  connectionError?: string;
}) {
  const [notice, setNotice] = useState<Notice | null>(null);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(
      () => setNotice((current) => (current === notice ? null : current)),
      Math.max(
        0,
        notice.startedAt + notificationDurationMs - performance.now(),
      ),
    );
    return () => clearTimeout(timer);
  }, [notice]);
  return (
    <NotificationContext.Provider value={setNotice}>
      {children}
      {notice ? (
        <NotificationBanner
          key={notice.id}
          {...notice}
          onDismiss={() => setNotice(null)}
        />
      ) : connectionError ? (
        <NotificationBanner message={connectionError} error />
      ) : null}
    </NotificationContext.Provider>
  );
}
