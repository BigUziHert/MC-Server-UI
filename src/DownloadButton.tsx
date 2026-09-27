import { useRef, useState, type ButtonHTMLAttributes } from "react";
import { api, isPanelProxyUrl } from "./api";
import { sessionCredential, sessionRevision } from "./session-auth";

export async function downloadToComputer(url: string) {
  const revision = sessionRevision();
  const proxied = isPanelProxyUrl(url);
  const target =
    sessionCredential() && !proxied
      ? (
          await api<{ url: string }>("/access/download", {
            method: "POST",
            body: JSON.stringify({ url }),
          })
        ).url
      : url;
  if (!proxied && revision !== sessionRevision())
    throw new Error("This sign-in ended before the download started.");
  const parsed = new URL(target, window.location.href);
  if (
    parsed.origin !== window.location.origin ||
    !parsed.pathname.startsWith("/api/")
  )
    throw new Error("The download destination does not belong to this panel.");
  // A one-use, one-minute resource ticket retains native streaming; large
  // archives never need to be buffered into a renderer Blob.
  const link = document.createElement("a");
  link.href = parsed.pathname + parsed.search;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

export default function DownloadButton({
  href,
  onError,
  children,
  disabled,
  ...props
}: Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onError" | "onClick" | "type"
> & {
  href: string;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  return (
    <button
      {...props}
      type="button"
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onClick={() => {
        if (pending.current || disabled) return;
        pending.current = true;
        setBusy(true);
        void downloadToComputer(href)
          .catch((error) =>
            onError(
              error instanceof Error
                ? error.message
                : "The download could not start.",
            ),
          )
          .finally(() => {
            pending.current = false;
            setBusy(false);
          });
      }}
    >
      {children}
    </button>
  );
}
