// Web Storage is origin-scoped (scheme + hostname + port); cookies are not.
// Credentials never enter resource URLs or requests to another origin.
const key = "mc-panel.session.v1";
let memoryToken: string | null = null;
let revision = 0;
const valid = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
try {
  const saved = localStorage.getItem(key);
  memoryToken = valid(saved) ? saved : null;
} catch {
  /* Private storage can be unavailable; this session still works. */
}

export const sessionCredential = () => memoryToken;
export const sessionRevision = () => revision;
export function saveSessionCredential(value: string | null) {
  if (value !== null && !valid(value))
    throw new Error("Invalid panel session response.");
  if (memoryToken === value) return;
  memoryToken = value;
  revision++;
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* Keep the in-memory sign-in usable until this view closes. */
  }
}
window.addEventListener("storage", (event) => {
  if (event.key !== key && event.key !== null) return;
  memoryToken = valid(event.newValue) ? event.newValue : null;
  revision++;
  window.dispatchEvent(new Event("mc-panel-session-changed"));
});

export function authenticatedFetch(input: string, options: RequestInit = {}) {
  const target = new URL(input, window.location.href);
  if (
    target.origin !== window.location.origin ||
    !target.pathname.startsWith("/api/")
  )
    throw new Error("Panel credentials can only be sent to this panel's API.");
  const headers = new Headers(options.headers);
  const token = memoryToken;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(target.pathname + target.search, {
    ...options,
    // Preserve the separate local desktop owner cookie and safe legacy-host
    // compatibility in isolated Electron views. New remote sessions use headers.
    credentials: token ? "omit" : "same-origin",
    redirect: "error",
    headers,
  });
}
