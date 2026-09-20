function sameOrigin(value, origin) {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.origin === origin &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

// Copy buttons only need sanitized clipboard writes. Keep reads and every
// other permission denied, including requests from embedded frames or workers.
export function installPanelPermissionHandlers(
  session,
  origin,
  getWebContents,
) {
  const canWrite = (contents, permission, details) => {
    if (
      permission !== "clipboard-sanitized-write" ||
      !contents ||
      contents !== getWebContents() ||
      contents.isDestroyed() ||
      details?.isMainFrame !== true
    )
      return false;
    return (
      sameOrigin(contents.getURL(), origin) &&
      sameOrigin(details.requestingUrl, origin)
    );
  };

  session.setPermissionRequestHandler(
    (contents, permission, callback, details) =>
      callback(canWrite(contents, permission, details)),
  );
  session.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) =>
      sameOrigin(requestingOrigin, origin) &&
      canWrite(contents, permission, details),
  );
}
