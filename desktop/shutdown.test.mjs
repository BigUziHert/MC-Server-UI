import test from "node:test";
import assert from "node:assert/strict";
import { flushSelectionForQuit, waitForShutdown } from "./shutdown.mjs";
import { flushRendererSelection } from "./selection.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("selection flush rejection and timeout can cancel or explicitly continue the same quit flow", async () => {
  const reasons = [];
  for (const mode of ["rejected", "timeout"]) {
    for (const accepted of [false, true]) {
      let calls = 0;
      const proceed = await flushSelectionForQuit({
        flush: () =>
          flushRendererSelection(
            {
              executeJavaScript: () =>
                mode === "timeout"
                  ? new Promise(() => {})
                  : Promise.reject(new Error("Missing server")),
            },
            { timeoutMs: 5 },
          ),
        confirm: async (cause) => {
          calls += 1;
          reasons.push(cause.reason);
          return accepted;
        },
      });
      assert.equal(proceed, accepted);
      assert.equal(calls, 1);
    }
  }
  assert.deepEqual(reasons, [
    "save-rejected",
    "save-rejected",
    "timeout",
    "timeout",
  ]);
  assert.equal(
    await flushSelectionForQuit({
      flush: async () => {},
      confirm: assert.fail,
    }),
    true,
  );
});

test("shutdown watchdog keeps saving indefinitely, opens logs, and only returns exit after an explicit choice", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const choices = ["wait", "logs", "exit"];
  let prompted = 0;
  let opened = 0;
  let completed = false;
  const pending = waitForShutdown(new Promise(() => {}), {
    timeoutMs: 100,
    prompt: () => {
      prompted += 1;
      return choices.shift();
    },
    openLogs: () => {
      opened += 1;
    },
  }).then((result) => {
    completed = true;
    return result;
  });
  t.mock.timers.tick(99);
  await tick();
  assert.equal(prompted, 0);
  for (let i = 1; i <= 2; i += 1) {
    t.mock.timers.tick(i === 1 ? 1 : 100);
    await tick();
    assert.equal(prompted, i);
    assert.equal(
      completed,
      false,
      "a timeout or log inspection must not interrupt saving",
    );
  }
  assert.equal(opened, 1);
  t.mock.timers.tick(100);
  assert.equal(await pending, false);
  assert.equal(prompted, 3);
});

test("finishing shutdown dismisses an open watchdog prompt and preserves shutdown failures", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish;
  let promptSignal;
  const pending = waitForShutdown(
    new Promise((resolve) => {
      finish = resolve;
    }),
    {
      timeoutMs: 100,
      prompt: (signal) => {
        promptSignal = signal;
        return new Promise(() => {});
      },
    },
  );
  t.mock.timers.tick(100);
  await tick();
  assert.equal(promptSignal.aborted, false);
  finish();
  assert.equal(await pending, true);
  assert.equal(promptSignal.aborted, true);
  const failure = new Error("Server shutdown failed");
  await assert.rejects(
    waitForShutdown(Promise.reject(failure), { prompt: assert.fail }),
    failure,
  );
});
