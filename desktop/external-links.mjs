// External links leave the sandbox and open the user's browser. Only allow the
// HTTPS catalog and software sites used by Launchpad, Versions, and Help.
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

export function externalWebsite(value) {
  try {
    if (typeof value !== "string") return null;
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return null;
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

export async function openExternalWebsite(value, { openExternal, logError }) {
  const url = externalWebsite(value);
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
