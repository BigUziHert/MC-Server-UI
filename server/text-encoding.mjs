// Preserve legacy single-byte files instead of replacing undecodable bytes.
// Callers enforce their own file type and size limits before decoding.
export function decodeText(buffer) {
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer,
      ),
      encoding: "utf8",
    };
  } catch {
    return { text: buffer.toString("latin1"), encoding: "latin1" };
  }
}

export function encodeText(text, encoding) {
  if (!["utf8", "latin1"].includes(encoding))
    throw Object.assign(
      new Error("Reload the file to read its text encoding."),
      { status: 400 },
    );
  if (encoding === "latin1" && /[^\x00-\xff]/.test(text))
    throw Object.assign(
      new Error(
        "This file uses Latin-1. These characters cannot be saved without changing its encoding. Convert the file to UTF-8 in an external editor first.",
      ),
      { status: 400 },
    );
  return Buffer.from(text, encoding);
}
