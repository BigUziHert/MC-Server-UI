const invalidAddress = () =>
  Object.assign(
    new Error("Enter an HTTPS panel address or a complete invitation link."),
    { status: 400 },
  );

// Accept the panel root and the one fragment used for invitation setup. Keep
// credentials, query strings, other paths, and ambiguous URL spellings out.
export function normalizePanelConnectionUrl(input) {
  if (typeof input !== "string" || input.length > 2048) throw invalidAddress();
  const value = input.trim();
  if (!/^https:\/\/[^\s/?#\\@]+\/?(?:#invite=[A-Za-z0-9_-]{43})?$/i.test(value))
    throw invalidAddress();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalidAddress();
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    (url.hash && !/^#invite=[A-Za-z0-9_-]{43}$/.test(url.hash))
  )
    throw invalidAddress();
  return `${url.origin}/${url.hash}`;
}
