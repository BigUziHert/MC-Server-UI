import assert from "node:assert/strict";
import { nextRunFor } from "../index.mjs";

assert.equal(
  Intl.DateTimeFormat().resolvedOptions().timeZone,
  "America/Winnipeg",
);
const daily = { enabled: true, type: "daily", time: "02:30" };
assert.equal(
  nextRunFor(daily, new Date("2027-03-14T07:00:00Z")),
  "2027-03-14T08:30:00.000Z",
);
assert.equal(
  nextRunFor(daily, new Date("2027-03-14T08:30:01Z")),
  "2027-03-15T07:30:00.000Z",
);
assert.equal(
  nextRunFor(
    { ...daily, type: "weekly", dayOfWeek: 0 },
    new Date("2027-03-14T08:30:01Z"),
  ),
  "2027-03-21T07:30:00.000Z",
);
const fall = { ...daily, time: "01:30" };
assert.equal(
  nextRunFor(fall, new Date("2027-11-07T05:00:00Z")),
  "2027-11-07T06:30:00.000Z",
);
assert.equal(
  nextRunFor(fall, new Date("2027-11-07T06:30:01Z")),
  "2027-11-08T07:30:00.000Z",
);
assert.equal(
  nextRunFor(
    { ...fall, type: "weekly", dayOfWeek: 0 },
    new Date("2027-11-07T06:30:01Z"),
  ),
  "2027-11-14T07:30:00.000Z",
);
