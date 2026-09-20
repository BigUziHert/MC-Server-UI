// The browser clipboard API may be unavailable in embedded browsers. Keep the
// fallback within the user's copy action and never read their clipboard.
export async function copyText(
  value: string,
  selectable?: HTMLTextAreaElement | null,
) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Try the browser's selection-based copy command below.
  }

  const previous = document.activeElement;
  const focused = previous instanceof HTMLElement ? previous : null;
  const input =
    previous instanceof HTMLInputElement ||
    previous instanceof HTMLTextAreaElement
      ? previous
      : null;
  const start = input?.selectionStart ?? null;
  const end = input?.selectionEnd ?? null;
  const direction = input?.selectionDirection ?? undefined;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange(),
      )
    : [];
  const reuse = selectable?.isConnected && selectable.value === value;
  const field = reuse ? selectable : document.createElement("textarea");
  if (!reuse) {
    field.value = value;
    field.readOnly = true;
    field.tabIndex = -1;
    field.setAttribute("aria-hidden", "true");
    Object.assign(field.style, {
      position: "fixed",
      top: "0",
      left: "0",
      width: "1px",
      height: "1px",
      padding: "0",
      border: "0",
      opacity: "0",
      pointerEvents: "none",
    });
    // A modal dialog makes the rest of the document inert. Its copy target
    // must stay inside that dialog to receive focus and a real selection.
    (focused?.closest("dialog[open]") ?? document.body).append(field);
  }
  let copied = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, value.length);
    copied = document.execCommand("copy");
  } finally {
    if (!reuse) field.remove();
    if (focused?.isConnected) focused.focus({ preventScroll: true });
    if (input?.isConnected && start !== null && end !== null)
      input.setSelectionRange(start, end, direction);
    if (selection && ranges.length) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
  if (!copied) throw new Error("Clipboard access is unavailable.");
}
