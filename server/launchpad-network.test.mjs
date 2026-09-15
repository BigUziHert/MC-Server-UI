import test from "node:test";
import assert from "node:assert/strict";
import { providerJson } from "./launchpad-network.mjs";

test("catalog requests keep a deadline when a caller supplies a lifetime signal", async (t) => {
  const caller = new AbortController(),
    deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", (delay) => {
    assert.equal(delay, 60000);
    return deadline.signal;
  });
  let sent;
  const response = providerJson(
    "https://api.modrinth.com/v2/tag/game_version",
    {
      signal: caller.signal,
      fetch: async (_url, { signal }) => {
        sent = signal;
        return new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    },
  );
  assert.notEqual(sent, caller.signal);
  deadline.abort(new Error("catalog deadline"));
  await assert.rejects(response, /catalog deadline/);
  assert.equal(caller.signal.aborted, false);
});

test("catalog cancellation still propagates through the deadline signal", async (t) => {
  const caller = new AbortController(),
    deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const response = providerJson(
    "https://api.modrinth.com/v2/tag/game_version",
    {
      signal: caller.signal,
      fetch: async (_url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    },
  );
  caller.abort(new Error("closed by caller"));
  await assert.rejects(response, /closed by caller/);
  assert.equal(deadline.signal.aborted, false);
});
