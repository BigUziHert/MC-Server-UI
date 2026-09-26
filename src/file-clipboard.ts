import { useSyncExternalStore } from "react";

export type FileClipboard = {
  origin: string;
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

export function clearFileClipboard() {
  clipboard = null;
  listeners.forEach((listener) => listener());
}

// This clipboard is intentionally in memory and confined to this panel's origin.
// The destination API rechecks source and destination permissions on every paste.
export function useFileClipboard() {
  return useSyncExternalStore(subscribe, () => clipboard);
}
