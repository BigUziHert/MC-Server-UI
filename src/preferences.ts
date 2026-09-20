type PreferenceStorage = "local" | "session";
let desktop = false;
let writes: Promise<unknown> = Promise.resolve();

const storageFor = (kind: PreferenceStorage) =>
  kind === "session" ? sessionStorage : localStorage;

export function readPreference(
  key: string,
  storage: PreferenceStorage = "local",
) {
  return storageFor(storage).getItem(key);
}

export function writePreference(
  key: string,
  value: string,
  storage: PreferenceStorage = "local",
) {
  storageFor(storage).setItem(key, value);
  if (!desktop) return;
  writes = writes
    .catch(() => {})
    .then(async () => {
      const response = await fetch("/api/desktop/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
        keepalive: true,
      });
      if (!response.ok)
        throw new Error("The display preference could not be saved.");
    });
  // Quit can await the original rejection, but normal navigation must not
  // produce an unhandled rejection when the local filesystem is unavailable.
  void writes.catch(() => {});
}

export async function initializeDesktopPreferences() {
  const connections = window.mcPanelConnections;
  if (!connections) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const context = await Promise.race([
      connections.list(),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(controller.signal.reason),
          { once: true },
        );
      }),
    ]);
    // Only the owner renderer uses these native preferences. A remote view has
    // the same narrow bridge, and the active view may differ from this one.
    if (
      !context.panels.some(
        (panel) => panel.local && panel.origin === window.location.origin,
      )
    )
      return;
    const response = await fetch("/api/desktop/preferences", {
      signal: controller.signal,
    });
    if (!response.ok) return;
    const saved = await response.json();
    if (
      saved.desktop !== true ||
      !saved.preferences ||
      typeof saved.preferences !== "object"
    )
      return;
    for (const [key, value] of Object.entries(saved.preferences)) {
      if (typeof value === "string")
        storageFor(
          key.startsWith("mc-panel.launchpad.view.") ? "session" : "local",
        ).setItem(key, value);
    }
    desktop = true;
  } catch {
    /* Browser and remote panels retain their own origin storage. */
  } finally {
    clearTimeout(timer);
  }
}

declare global {
  interface Window {
    __mcPanelFlushPreferences?: () => Promise<unknown>;
  }
}
window.__mcPanelFlushPreferences = async () => {
  for (;;) {
    const observed = writes;
    await observed;
    if (observed === writes) return;
  }
};
