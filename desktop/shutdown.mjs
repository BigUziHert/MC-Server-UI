// A deadline offers a decision; it never terminates a process or abandons a save.
export async function waitForShutdown(
  operation,
  { timeoutMs = 120000, prompt, openLogs = () => {} } = {},
) {
  const completed = Promise.resolve(operation).then(
    () => ({ done: true }),
    (cause) => ({ cause }),
  );
  const result = (value) => {
    if (Object.hasOwn(value, "cause")) throw value.cause;
    return value.done === true;
  };
  for (;;) {
    let timer;
    let outcome;
    try {
      outcome = await Promise.race([
        completed,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!outcome.timedOut) return result(outcome);
    const pendingDialog = new AbortController();
    try {
      const decision = await Promise.race([
        completed,
        Promise.resolve()
          .then(() => prompt(pendingDialog.signal))
          .then((choice) => ({ choice })),
      ]);
      if (!Object.hasOwn(decision, "choice")) return result(decision);
      if (decision.choice === "exit") return false;
      if (decision.choice === "logs") await openLogs();
    } finally {
      // Electron accepts this signal to dismiss a watchdog dialog as soon as
      // the real shutdown finishes, without making the user click an old prompt.
      pendingDialog.abort();
    }
  }
}

export async function flushSelectionForQuit({
  flush,
  confirm,
  log = () => {},
}) {
  try {
    await flush();
    return true;
  } catch (cause) {
    if (cause.code !== "PANEL_SELECTION_FLUSH_FAILED") throw cause;
    await log(cause);
    return Boolean(await confirm(cause));
  }
}
