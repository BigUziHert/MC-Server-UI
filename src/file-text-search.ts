// UTF-16 offsets match textarea selectionStart/selectionEnd, including Unicode
// text. Typed offsets keep even a one-character search in a 1 MB file compact.
export function findTextMatches(
  text: string,
  query: string,
  matchCase = false,
) {
  if (!query) return new Uint32Array();
  const expression = new RegExp(
    query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    matchCase ? "g" : "gi",
  );
  let offsets = new Uint32Array(Math.min(256, text.length));
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text))) {
    if (count === offsets.length) {
      const grown = new Uint32Array(Math.min(text.length, offsets.length * 2));
      grown.set(offsets);
      offsets = grown;
    }
    offsets[count++] = match.index;
  }
  return offsets.subarray(0, count);
}

export function lineAtOffset(newlines: Uint32Array, offset: number) {
  let start = 0;
  let end = newlines.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (newlines[middle] < offset) start = middle + 1;
    else end = middle;
  }
  return { line: start, start: start ? newlines[start - 1] + 1 : 0 };
}
