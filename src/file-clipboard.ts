import { useContext, useSyncExternalStore } from "react";
import { SessionScopeContext } from "./session-scope";

export type FileClipboard = {
  origin: string;
  sessionScope: string;
  sourceServerId: string;
  sourceName: string;
  paths: string[];
};

let clipboard: FileClipboard | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function copyFiles(value: FileClipboard) {
  clipboard = { ...value, paths: [...value.paths] };
  listeners.forEach((listener) => listener());
}

export function clearFileClipboard(sessionScope?: string) {
  if (sessionScope && clipboard?.sessionScope !== sessionScope) return;
  clipboard = null;
  listeners.forEach((listener) => listener());
}

// This clipboard is intentionally in memory and confined to this panel's origin.
// The destination API rechecks source and destination permissions on every paste.
export function useFileClipboard() {
  const scope = useContext(SessionScopeContext);
  return useSyncExternalStore(subscribe, () =>
    clipboard?.sessionScope === scope ? clipboard : null,
  );
}
