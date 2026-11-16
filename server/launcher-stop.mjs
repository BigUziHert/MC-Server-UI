// Minecraft emits this message before saving players/worlds. Only trust its
// logger envelope; player chat or an echoed console command must not change the
// process lifecycle. Forge/NeoForge add an optional logger category bracket.
export function minecraftServerMessage(text) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "").trim();
  const java = clean.match(
    /^(?:\[[^\]\r\n]{1,80}\]\s*)?\[Server thread\/INFO\](?:\s*\[[^\]\r\n]{1,120}\])?:\s*(.+)$/,
  );
  const paper = clean.match(/^\[\d{2}:\d{2}:\d{2} INFO\]:\s*(.+)$/);
  return (java ?? paper)?.[1] ?? "";
}

export function isMinecraftShutdownLine(text, { allowSaving = false } = {}) {
  const message = minecraftServerMessage(text);
  return (
    /^Stopping (?:the )?server[.!…]*$/i.test(message) ||
    (allowSaving && /^Saving (?:players|worlds)[.!…]*$/i.test(message))
  );
}

/** Tracks one owned child. Once Minecraft confirms shutdown, a Windows batch
 * launcher needs no more commands. End its input while the server finishes its
 * save, so even localized or hidden PAUSE commands receive EOF and complete.
 * The exact English prompt is a fallback for launchers without shutdown logs.
 * No process lookup, tree kill or synthesized exit code is involved.
 */
export function createLauncherStop({
  child,
  windowsBatch = false,
  onShutdownStarted = () => {},
  onInputClosed = () => {},
}) {
  let requested = false;
  let shutdownStarted = false;
  let paused = false;
  let acknowledged = false;
  const acknowledge = () => {
    if (
      !windowsBatch ||
      !requested ||
      (!shutdownStarted && !paused) ||
      acknowledged ||
      !child.stdin.writable ||
      child.stdin.writableEnded
    )
      return;
    acknowledged = true;
    onInputClosed(shutdownStarted ? "shutdown" : "pause");
    child.stdin.end();
  };
  return {
    get requested() {
      return requested;
    },
    get shutdownStarted() {
      return shutdownStarted;
    },
    observe(text) {
      if (
        !shutdownStarted &&
        text
          .split(/\r?\n/)
          .slice(0, -1)
          .some((line) =>
            isMinecraftShutdownLine(line, { allowSaving: requested }),
          )
      ) {
        requested = true;
        shutdownStarted = true;
        onShutdownStarted();
      }
      if (
        windowsBatch &&
        /(?:^|[\r\n])[\t ]*Press any key to continue\s*\.\s*\.\s*\.[\t ]*(?:$|[\r\n])/i.test(
          text,
        )
      )
        paused = true;
      acknowledge();
    },
    requestStop() {
      if (requested) {
        acknowledge();
        return;
      }
      requested = true;
      if (paused) acknowledge();
      else if (child.stdin.writable && !child.stdin.writableEnded)
        child.stdin.write("stop\n");
    },
  };
}
