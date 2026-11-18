import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { CheckCheck, CircleHelp, X } from "lucide-react";
import { notificationDurationMs } from "./DismissCountdown";
import type { PageProps } from "./api";

type Notice = {
  owner: object;
  id: number;
  message: string;
  error: boolean;
  inlineResultVisible?: () => boolean;
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
  return useCallback<PageProps["notify"]>(
    (message, error = false, inlineResultVisible) => {
      if (!owner.active || inlineResultVisible?.()) return;
      setNotice((current) => ({
        owner,
        id: (current?.id ?? 0) + 1,
        message,
        error,
        inlineResultVisible,
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

function Toast({
  message,
  error,
  onDismiss,
  inlineResultVisible,
}: {
  message: string;
  error: boolean;
  onDismiss?: () => void;
  inlineResultVisible?: () => boolean;
}) {
  const [host, setHost] = useState(notificationHost);
  useLayoutEffect(() => {
    const update = () => {
      if (inlineResultVisible?.()) onDismiss?.();
      else setHost(notificationHost());
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open", "data-file-result"],
    });
    update();
    return () => observer.disconnect();
  }, [inlineResultVisible, onDismiss]);
  return createPortal(
    <div
      className={`toast${error ? " error" : ""}`}
      role={error ? "alert" : "status"}
      aria-label="Notification"
    >
      {error ? <CircleHelp size={18} /> : <CheckCheck size={18} />}
      <span>{message}</span>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={onDismiss}
        >
          <X size={16} />
        </button>
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
  const dismiss = useCallback(
    () => setNotice((current) => (current === notice ? null : current)),
    [notice],
  );
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(dismiss, notificationDurationMs);
    return () => clearTimeout(timer);
  }, [notice, dismiss]);
  return (
    <NotificationContext.Provider value={setNotice}>
      {children}
      {notice ? (
        <Toast
          key={notice.id}
          message={notice.message}
          error={notice.error}
          inlineResultVisible={notice.inlineResultVisible}
          onDismiss={dismiss}
        />
      ) : connectionError ? (
        <Toast message={connectionError} error />
      ) : null}
    </NotificationContext.Provider>
  );
}
