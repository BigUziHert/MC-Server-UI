// External links leave the sandbox and open the user's browser. Only allow the
// HTTPS catalog/software sites and the public panel address saved by the owner.
const websites = new Set([
  "modrinth.com",
  "www.modrinth.com",
  "curseforge.com",
  "www.curseforge.com",
  "spigotmc.org",
  "www.spigotmc.org",
  "feed-the-beast.com",
  "www.feed-the-beast.com",
  "atlauncher.com",
  "www.atlauncher.com",
  "voidswrath.com",
  "www.voidswrath.com",
  "www.minecraft.net",
  "papermc.io",
  "pufferfish.host",
  "purpurmc.org",
  "fabricmc.net",
  "quiltmc.org",
  "files.minecraftforge.net",
  "neoforged.net",
  "www.mohistmc.com",
  "spongepowered.org",
  "leavesmc.org",
  "canvasmc.io",
  "magmafoundation.org",
]);

export function externalWebsite(value, { publicPanelUrl } = {}) {
  try {
    if (typeof value !== "string") return null;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    // The host supplies this address from its saved access configuration, never
    // from the renderer. Match only the root panel URL, not arbitrary links on
    // the same host or query parameters that might redirect elsewhere.
    if (publicPanelUrl && url.pathname === "/" && !url.search && !url.hash) {
      try {
        const panel = new URL(publicPanelUrl);
        if (panel.href === url.href) return url.href;
      } catch {
        // A missing or invalid setting does not expand the website allowlist.
      }
    }
    if (url.port) return null;
    if (websites.has(url.hostname)) return url.href;
    if (
      url.hostname === "aka.ms" &&
      url.pathname === "/MinecraftEULA" &&
      !url.search &&
      !url.hash
    )
      return url.href;
    if (
      url.hostname === "github.com" &&
      /^\/(?:BigUziHert\/MC-Server-UI|IzzelAliz\/Arclight)(?:\/|$)/i.test(
        url.pathname,
      )
    )
      return url.href;
  } catch {
    // Malformed URLs and unsupported protocols must never reach the OS shell.
  }
  return null;
}

export async function openExternalWebsite(
  value,
  { openExternal, logError, publicPanelUrl },
) {
  const url = externalWebsite(value, { publicPanelUrl });
  if (!url) return false;
  try {
    await openExternal(url);
    return true;
  } catch (cause) {
    await logError(cause);
    return false;
  }
}

export function installExternalLinkHandlers(webContents, origin, openWebsite) {
  webContents.setWindowOpenHandler(({ url }) => {
    void openWebsite(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin === origin) return;
    } catch {
      // Invalid navigation is blocked just like an external destination.
    }
    event.preventDefault();
    void openWebsite(url);
  });
}
