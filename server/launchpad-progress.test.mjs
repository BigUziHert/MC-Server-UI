import assert from "node:assert/strict";
import test from "node:test";
import { createInstallProgress } from "./launchpad-progress.mjs";

test("content installs fill by downloaded bytes, then by installed files", () => {
  const job = {};
  const progress = createInstallProgress(job, [{ size: 300 }, { size: 100 }]);
  assert.deepEqual(job.progress, { completed: 0, total: 1000 });
  progress.downloaded(0, 150);
  assert.equal(job.progress.completed, Math.floor(1000 * 0.9 * (150 / 400)));
  progress.staged(0);
  progress.staged(1);
  assert.equal(job.progress.completed, 900);
  progress.installed(1, 2);
  assert.equal(job.progress.completed, 950);
  progress.finish();
  assert.equal(job.progress.completed, 1000);
});

test("a single large mod moves the bar while it downloads", () => {
  const job = {};
  const progress = createInstallProgress(job, [{ size: 50_000_000 }]);
  const seen = [];
  for (const bytes of [5e6, 20e6, 35e6, 50e6]) {
    progress.downloaded(0, bytes);
    seen.push(job.progress.completed);
  }
  assert.deepEqual(seen, [90, 360, 630, 900]);
});

test("files without a declared size count as an average file", () => {
  const job = {};
  const progress = createInstallProgress(job, [{ size: 100 }, { size: null }]);
  progress.staged(0);
  assert.equal(job.progress.completed, 450);
  progress.downloaded(1, 10_000);
  assert.equal(job.progress.completed, 900);
});

test("modpacks reserve part of the bar for their server software", () => {
  const job = {};
  const progress = createInstallProgress(job, [{ size: 10 }], {
    modpack: true,
  });
  progress.staged(0);
  assert.equal(job.progress.completed, 600);
  progress.runtime(50, 100);
  assert.equal(job.progress.completed, 750);
  // Installer messages without byte counts leave the bar where it is.
  progress.runtime(undefined, undefined);
  assert.equal(job.progress.completed, 750);
  progress.finish();
  assert.equal(job.progress.completed, 1000);
});

test("progress never moves backwards", () => {
  const job = {};
  const progress = createInstallProgress(job, [{ size: 100 }]);
  progress.downloaded(0, 80);
  const before = job.progress.completed;
  // A restarted transfer reports fewer bytes; the bar holds its position.
  progress.downloaded(0, 10);
  assert.equal(job.progress.completed, before);
});

test("an empty plan is already fully downloaded", () => {
  const job = {};
  createInstallProgress(job, []);
  assert.equal(job.progress.completed, 900);
});
