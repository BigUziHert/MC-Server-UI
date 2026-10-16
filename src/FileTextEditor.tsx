import {
  forwardRef,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import { findTextMatches, lineAtOffset } from "./file-text-search";
import "./file-text-editor.css";

export type FileTextEditorHandle = {
  openFind: () => boolean;
  closeFind: () => boolean;
};

const FileTextEditor = forwardRef<
  FileTextEditorHandle,
  {
    label: string;
    value: string;
    onChange: (value: string) => void;
    readOnly?: boolean;
    disabled?: boolean;
    rows?: number;
  }
>(function FileTextEditor(
  { label, value, onChange, readOnly, disabled, rows = 18 },
  ref,
) {
  const id = useId();
  const editor = useRef<HTMLTextAreaElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const measuringCanvas = useRef<HTMLCanvasElement | null>(null);
  const autoSelect = useRef(true);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [index, setIndex] = useState(0);
  // Textarea selections use LF-normalized display offsets. Keep the original
  // value untouched so opening Find cannot rewrite a file's line endings.
  const displayValue = useMemo(() => value.replace(/\r\n?/g, "\n"), [value]);
  const deferredValue = useDeferredValue(displayValue);
  const deferredQuery = useDeferredValue(query);
  const searching = deferredValue !== displayValue || deferredQuery !== query;
  const matches = useMemo(
    () =>
      findTextMatches(
        open ? deferredValue : "",
        open ? deferredQuery : "",
        matchCase,
      ),
    [open, deferredValue, deferredQuery, matchCase],
  );
  const newlines = useMemo(
    () => findTextMatches(open ? deferredValue : "", "\n", true),
    [open, deferredValue],
  );
  const current = Math.max(0, Math.min(index, matches.length - 1));

  const reveal = useCallback(
    (next: number, focus = false) => {
      const element = editor.current;
      if (!element || searching || !matches.length) return;
      const start = matches[next];
      if (focus) element.focus({ preventScroll: true });
      element.setSelectionRange(start, start + query.length);
      const style = getComputedStyle(element);
      const lineHeight = Number.parseFloat(style.lineHeight) || 22;
      const position = lineAtOffset(newlines, start);
      element.scrollTop = Math.max(
        0,
        position.line * lineHeight +
          Number.parseFloat(style.paddingTop) -
          element.clientHeight / 2,
      );
      measuringCanvas.current ??= document.createElement("canvas");
      const context = measuringCanvas.current.getContext("2d");
      if (context) {
        context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const tabWidth =
          context.measureText(" ").width *
          (Number.parseFloat(style.tabSize) || 2);
        const parts = displayValue.slice(position.start, start).split("\t");
        let left = 0;
        parts.forEach((part, partIndex) => {
          left += context.measureText(part).width;
          if (partIndex < parts.length - 1)
            left = (Math.floor(left / tabWidth) + 1) * tabWidth;
        });
        element.scrollLeft = Math.max(0, left - element.clientWidth / 3);
      }
    },
    [matches, newlines, query.length, searching, displayValue],
  );

  function openFind() {
    if (disabled) return false;
    autoSelect.current = true;
    setOpen(true);
    if (open) {
      findInput.current?.focus();
      findInput.current?.select();
    }
    return true;
  }
  function closeFind() {
    if (!open) return false;
    setOpen(false);
    editor.current?.focus({ preventScroll: true });
    return true;
  }
  useImperativeHandle(ref, () => ({ openFind, closeFind }));
  useEffect(() => {
    if (open) {
      findInput.current?.focus();
      findInput.current?.select();
    }
  }, [open]);
  useEffect(() => {
    if (open && autoSelect.current) reveal(current);
  }, [open, current, reveal]);

  function move(direction: number, focus = false) {
    if (disabled || searching || !matches.length) return;
    const next = (current + direction + matches.length) % matches.length;
    autoSelect.current = true;
    setIndex(next);
    reveal(next, focus);
  }

  return (
    <div className="form-field file-text-editor">
      <div className="file-editor-toolbar">
        <label htmlFor={id}>{label}</label>
        <button
          type="button"
          className="btn small"
          aria-label="Find in file"
          aria-expanded={open}
          aria-controls={`${id}-find`}
          aria-keyshortcuts="Control+f Meta+f"
          title="Find in file (Ctrl+F / ⌘F)"
          disabled={disabled}
          onClick={openFind}
        >
          <Search size={14} aria-hidden="true" /> Find
        </button>
      </div>
      {open && (
        <div
          className="file-editor-find"
          id={`${id}-find`}
          role="search"
          aria-label="Find in file"
        >
          <div className="file-editor-find-controls">
            <input
              ref={findInput}
              type="text"
              aria-label="Find text in file"
              aria-describedby={`${id}-find-count`}
              placeholder="Find a keyword…"
              value={query}
              disabled={disabled}
              onChange={(event) => {
                autoSelect.current = true;
                setQuery(event.target.value);
                setIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.stopPropagation();
                  move(event.shiftKey ? -1 : 1);
                }
              }}
            />
            <button
              type="button"
              className="btn icon"
              aria-label="Match case"
              title="Match case"
              aria-pressed={matchCase}
              disabled={disabled}
              onClick={() => {
                autoSelect.current = true;
                setMatchCase((previous) => !previous);
                setIndex(0);
              }}
            >
              Aa
            </button>
            <button
              type="button"
              className="btn icon"
              aria-label="Previous match"
              title="Previous match (Shift+Enter)"
              disabled={disabled || searching || !matches.length}
              onClick={() => move(-1, true)}
            >
              <ArrowUp size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn icon"
              aria-label="Next match"
              title="Next match (Enter)"
              disabled={disabled || searching || !matches.length}
              onClick={() => move(1, true)}
            >
              <ArrowDown size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="btn icon"
              aria-label="Close find"
              title="Close find (Esc)"
              onClick={closeFind}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <span
            id={`${id}-find-count`}
            className="file-editor-find-count"
            role="status"
            aria-label="Find matches"
          >
            {!query
              ? "Enter a keyword"
              : searching
                ? "Searching…"
                : matches.length
                  ? `${current + 1} of ${matches.length} matches`
                  : "No matches"}
          </span>
        </div>
      )}
      <textarea
        ref={editor}
        id={id}
        className="file-editor"
        readOnly={readOnly}
        value={value}
        onChange={(event) => {
          // Editing must keep its caret; navigation resumes when Find is used.
          autoSelect.current = false;
          onChange(event.target.value);
        }}
        spellCheck={false}
        wrap="off"
        disabled={disabled}
        rows={rows}
      />
    </div>
  );
});

export default FileTextEditor;
