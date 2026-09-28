import { spawn as spawnProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// A separate guardian owns Caddy. The parent keeps stdin open for its lifetime;
// even a hard crash closes that pipe, so the guardian can stop Caddy on Windows
// without relying on Unix process groups or leaving an orphan HTTPS listener.
export function runManagedHttpsChild({
  executablePath,
  configFile,
  spawn = spawnProcess,
  input = process.stdin,
  output = process.stderr,
  signals = process,
  graceMs = 1500,
}) {
  return new Promise((resolve) => {
    let child;
    let stopping = false;
    let finished = false;
    let timer;
    const forceStop = () => {
      if (finished) return;
      try {
        child?.kill("SIGKILL");
      } catch {
        /* Keep the guardian alive until Caddy exits. */
      }
      if (!finished) timer = setTimeout(forceStop, graceMs);
    };
    const stop = () => {
      if (finished || stopping) return;
      stopping = true;
      try {
        child?.kill("SIGTERM");
      } catch {
        /* Forceful termination follows. */
      }
      if (!finished) timer = setTimeout(forceStop, graceMs);
    };
    const parentExit = () => {
      try {
        child?.kill("SIGKILL");
      } catch {
        /* Best effort during process exit. */
      }
    };
    const ignoreBrokenPipe = () => {};
    const done = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.removeListener("end", stop);
      input.removeListener("close", stop);
      input.removeListener("error", stop);
      input.pause();
      signals.removeListener("SIGTERM", stop);
      signals.removeListener("SIGINT", stop);
      signals.removeListener("exit", parentExit);
      // Keep the output error handler: its parent may already be gone.
      resolve(stopping ? 0 : Number.isInteger(code) ? code : 1);
    };
    output.on("error", ignoreBrokenPipe);
    try {
      child = spawn(executablePath, ["run", "--config", configFile], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.pipe(output, { end: false });
      child.stderr?.pipe(output, { end: false });
      child.on("error", (cause) => {
        output.write(`${cause.code || "HTTPS_START_FAILED"}\n`);
        // A failed spawn has no child to reap. Other errors must not cause the
        // guardian to exit before its already-running Caddy child is stopped.
        if (!child.pid) done(1);
        else stop();
      });
      child.once("exit", done);
      input.on("end", stop);
      input.on("close", stop);
      input.on("error", stop);
      signals.on("SIGTERM", stop);
      signals.on("SIGINT", stop);
      signals.once("exit", parentExit);
      input.resume();
      if (input.destroyed || input.readableEnded) stop();
    } catch (cause) {
      output.write(`${cause.code || "HTTPS_START_FAILED"}\n`);
      done(1);
    }
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [, , executablePath, configFile] = process.argv;
  if (!executablePath || !configFile) process.exitCode = 1;
  else
    process.exitCode = await runManagedHttpsChild({
      executablePath,
      configFile,
    });
}
