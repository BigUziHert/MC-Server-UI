import type { UploadCollectionOptions, UploadSource } from "./file-uploads";

type ClipboardSelection = {
  id: string;
  files: {
    id: string;
    path: string;
    name: string;
    size: number;
    lastModified: number;
  }[];
  directories: string[];
};

declare global {
  interface Window {
    mcPanelClipboard?: {
      readFiles: () => Promise<ClipboardSelection | null>;
      readFile: (
        selectionId: string,
        fileId: string,
        offset: number,
      ) => Promise<Uint8Array>;
      releaseFiles: (selectionId: string) => Promise<void>;
      markInternalCopy: () => Promise<void>;
    };
  }
}

/** Read only files copied on this desktop, including nested and empty folders. */
export async function collectDesktopClipboardUpload({
  signal,
  onProgress,
}: UploadCollectionOptions = {}): Promise<UploadSource | null> {
  const bridge = window.mcPanelClipboard;
  if (!bridge) return null;
  signal?.throwIfAborted();
  const selection = await bridge.readFiles();
  if (!selection) return null;
  try {
    const source: UploadSource = {
      files: [],
      directories: selection.directories,
    };
    for (const entry of selection.files) {
      signal?.throwIfAborted();
      const parts: ArrayBuffer[] = [];
      let offset = 0;
      do {
        signal?.throwIfAborted();
        const chunk = await bridge.readFile(selection.id, entry.id, offset);
        if (
          (!chunk.byteLength && offset < entry.size) ||
          offset + chunk.byteLength > entry.size
        )
          throw new Error(
            `${entry.path} could not be read completely. Copy it again.`,
          );
        parts.push(new Uint8Array(chunk).buffer);
        offset += chunk.byteLength;
      } while (offset < entry.size);
      source.files.push({
        path: entry.path,
        file: new File(parts, entry.name, { lastModified: entry.lastModified }),
      });
      onProgress?.({
        files: source.files.length,
        directories: source.directories.length,
      });
    }
    signal?.throwIfAborted();
    return source;
  } finally {
    await bridge.releaseFiles(selection.id).catch(() => {});
  }
}
