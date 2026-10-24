import assert from "node:assert/strict";
import { nextRunFor } from "../index.mjs";

assert.equal(
  Intl.DateTimeFormat().resolvedOptions().timeZone,
  "America/Winnipeg",
);
// Use historical transitions: future timezone rules can change between Node
// releases (Winnipeg stopped changing clocks after October 2026 in tzdb 2026e).
const daily = { enabled: true, type: "daily", time: "02:30" };
assert.equal(
  nextRunFor(daily, new Date("2025-03-09T07:00:00Z")),
  "2025-03-09T08:30:00.000Z",
);
assert.equal(
  nextRunFor(daily, new Date("2025-03-09T08:30:01Z")),
  "2025-03-10T07:30:00.000Z",
);
assert.equal(
  nextRunFor(
    { ...daily, type: "weekly", dayOfWeek: 0 },
    new Date("2025-03-09T08:30:01Z"),
  ),
  "2025-03-16T07:30:00.000Z",
);
const fall = { ...daily, time: "01:30" };
assert.equal(
  nextRunFor(fall, new Date("2025-11-02T05:00:00Z")),
  "2025-11-02T06:30:00.000Z",
);
assert.equal(
  nextRunFor(fall, new Date("2025-11-02T06:30:01Z")),
  "2025-11-03T07:30:00.000Z",
);
assert.equal(
  nextRunFor(
    { ...fall, type: "weekly", dayOfWeek: 0 },
    new Date("2025-11-02T06:30:01Z"),
  ),
  "2025-11-09T07:30:00.000Z",
);
