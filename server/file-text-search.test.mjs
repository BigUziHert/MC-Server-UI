import test from "node:test";
import assert from "node:assert/strict";
import { findTextMatches, lineAtOffset } from "../src/file-text-search.ts";

test("editor find treats keywords literally and preserves Unicode selection offsets", () => {
  const value = "😀 İ [a.*] then [A.*] and aaaaa";
  assert.deepEqual([...findTextMatches(value, "[a.*]")], [5, 16]);
  assert.deepEqual([...findTextMatches(value, "[a.*]", true)], [5]);
  assert.deepEqual([...findTextMatches(value, "absent")], []);
  assert.deepEqual([...findTextMatches(value, "")], []);
  for (const start of findTextMatches(value, "[a.*]"))
    assert.equal(value.slice(start, start + 5).toLowerCase(), "[a.*]");
});

test("editor find counts a dense 1 MB file with compact non-overlapping offsets", () => {
  const matches = findTextMatches("a".repeat(1024 * 1024), "aa");
  assert.equal(matches.length, 512 * 1024);
  assert.equal(matches.at(-1), 1024 * 1024 - 2);
  assert.ok(matches.buffer.byteLength <= matches.length * 8);
});

test("editor navigation locates the line around empty lines and the last line", () => {
  const value = "first\n\nlast";
  const breaks = findTextMatches(value, "\n", true);
  assert.deepEqual(lineAtOffset(breaks, 0), { line: 0, start: 0 });
  assert.deepEqual(lineAtOffset(breaks, 5), { line: 0, start: 0 });
  assert.deepEqual(lineAtOffset(breaks, 6), { line: 1, start: 6 });
  assert.deepEqual(lineAtOffset(breaks, 7), { line: 2, start: 7 });
  assert.deepEqual(lineAtOffset(breaks, value.length), { line: 2, start: 7 });
});
