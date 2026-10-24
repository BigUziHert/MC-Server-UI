import { useLayoutEffect, useMemo, useState, type RefObject } from "react";
import { lineAtOffset } from "./file-text-search";

type Highlight = { left: number; top: number; width: number; index: number };
const lowerBound = (offsets: Uint32Array, target: number) => {
  let start = 0;
  let end = offsets.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (offsets[middle] < target) start = middle + 1;
    else end = middle;
  }
  return start;
};

export default function FileFindHighlights({
  editor,
  text,
  queryLength,
  matches,
  newlines,
  current,
}: {
  editor: RefObject<HTMLTextAreaElement | null>;
  text: string;
  queryLength: number;
  matches: Uint32Array;
  newlines: Uint32Array;
  current: number;
}) {
  const [layout, setLayout] = useState({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
    lineHeight: 0,
    padding: 0,
    scrollHeight: 0,
    highlights: [] as Highlight[],
  });

  useLayoutEffect(() => {
    const element = editor.current;
    const context = document.createElement("canvas").getContext("2d");
    if (!element || !context) return;
    let frame = 0;
    const measure = () => {
      const style = getComputedStyle(element);
      const lineHeight = Number.parseFloat(style.lineHeight);
      const padding = Number.parseFloat(style.paddingTop);
      const inset = Number.parseFloat(style.paddingLeft) - element.scrollLeft;
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      context.fontKerning = "none";
      const cellWidth = context.measureText(" ").width;
      const tabWidth = cellWidth * (Number.parseFloat(style.tabSize) || 2);
      const advance = (value: string, from = 0) => {
        let x = from;
        const parts = value.split("\t");
        parts.forEach((part, index) => {
          // The editor uses a monospace font. This also bounds measurement cost
          // for a dense, single-line megabyte file scrolled far to the right.
          x += /^[\x20-\x7e]*$/.test(part)
            ? part.length * cellWidth
            : context.measureText(part).width;
          if (index < parts.length - 1)
            x = (Math.floor(x / tabWidth) + 1) * tabWidth;
        });
        return x;
      };
      const highlights: Highlight[] = [];
      const firstLine = Math.max(
        0,
        Math.floor((element.scrollTop - padding) / lineHeight),
      );
      const lastLine = Math.min(
        newlines.length,
        Math.ceil(
          (element.scrollTop + element.clientHeight - padding) / lineHeight,
        ),
      );
      for (let line = firstLine; line <= lastLine; line++) {
        const start = line ? newlines[line - 1] + 1 : 0;
        const end = newlines[line] ?? text.length;
        let first = lowerBound(matches, start);
        const last = lowerBound(matches, end);
        // Only create highlights intersecting the visible horizontal range.
        let upper = last;
        while (first < upper) {
          const middle = (first + upper) >>> 1;
          if (
            advance(text.slice(start, matches[middle] + queryLength)) + inset <=
            0
          )
            first = middle + 1;
          else upper = middle;
        }
        let previousEnd = first < last ? matches[first] : start;
        let x = advance(text.slice(start, previousEnd));
        for (let index = first; index < last; index++) {
          x = advance(text.slice(previousEnd, matches[index]), x);
          const left = x + inset;
          if (left >= element.clientWidth) break;
          const end = matches[index] + queryLength;
          const right = advance(text.slice(matches[index], end), x);
          const top = padding + line * lineHeight - element.scrollTop;
          const width = Math.max(1, right - x);
          const previous = highlights.at(-1);
          // Adjacent dense matches can share a background, keeping the DOM
          // bounded while the current match retains its own outline.
          if (
            previous &&
            previous.top === top &&
            previous.index !== current &&
            index !== current &&
            Math.abs(previous.left + previous.width - left) < 0.5
          )
            previous.width = left + width - previous.left;
          else highlights.push({ left, top, width, index });
          x = right;
          previousEnd = end;
        }
      }
      setLayout({
        left: element.offsetLeft + element.clientLeft,
        top: element.offsetTop + element.clientTop,
        width: element.clientWidth,
        height: element.clientHeight,
        lineHeight,
        padding,
        scrollHeight: element.scrollHeight,
        highlights,
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    element.addEventListener("scroll", schedule);
    document.fonts.addEventListener("loadingdone", schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      element.removeEventListener("scroll", schedule);
      document.fonts.removeEventListener("loadingdone", schedule);
    };
  }, [editor, text, queryLength, matches, newlines, current]);

  const markerTop = (line: number) =>
    Math.max(
      0,
      Math.min(
        layout.height - 3,
        ((layout.padding + (line + 0.5) * layout.lineHeight) /
          layout.scrollHeight) *
          layout.height,
      ),
    );
  const markers = useMemo(() => {
    const positions = new Set<number>();
    if (!layout.scrollHeight) return [];
    let line = 0;
    for (const offset of matches) {
      while (line < newlines.length && newlines[line] < offset) line++;
      positions.add(Math.floor(markerTop(line) / 3) * 3);
    }
    return [...positions];
  }, [
    matches,
    newlines,
    layout.height,
    layout.lineHeight,
    layout.padding,
    layout.scrollHeight,
  ]);

  return (
    <>
      <div
        className="file-editor-highlights"
        aria-hidden="true"
        style={{
          left: layout.left,
          top: layout.top,
          width: layout.width,
          height: layout.height,
        }}
      >
        {layout.highlights.map((highlight) => (
          <mark
            key={highlight.index}
            className={`file-editor-highlight${highlight.index === current ? " is-current" : ""}`}
            data-match-index={highlight.index}
            style={{
              left: highlight.left,
              top: highlight.top + 2,
              width: highlight.width,
              height: layout.lineHeight - 4,
            }}
          />
        ))}
      </div>
      <div
        className="file-editor-match-rail"
        aria-hidden="true"
        style={{ top: layout.top, height: layout.height }}
      >
        {markers.map((top) => (
          <span
            key={top}
            className="file-editor-match-marker"
            style={{ top }}
          />
        ))}
        {layout.scrollHeight > 0 && (
          <span
            className="file-editor-match-marker is-current"
            style={{
              top: markerTop(lineAtOffset(newlines, matches[current]).line),
            }}
          />
        )}
      </div>
    </>
  );
}
