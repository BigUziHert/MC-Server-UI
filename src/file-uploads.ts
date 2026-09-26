export const UPLOAD_FILES_PER_BATCH = 20;
export const UPLOAD_FILE_SIZE_LIMIT = 256 * 1024 * 1024;
const BATCH_BYTES = 64 * 1024 * 1024;
const FIELD_BYTES = 120 * 1024;
const encoder = new TextEncoder();

export type UploadFile = { file: File; path: string };
export type UploadSource = { files: UploadFile[]; directories: string[] };
export type UploadCollectionOptions = {
  signal?: AbortSignal;
  onProgress?: (counts: { files: number; directories: number }) => void;
};
export type UploadProgress = {
  phase: "uploading" | "completed" | "cancelled" | "failed" | "uncertain";
  uploadedFiles: number;
  totalFiles: number;
  uploadedBytes: number;
  totalBytes: number;
  completedDirectories: number;
  totalDirectories: number;
  currentPaths: string[];
};
export type UploadResult = UploadProgress & {
  message?: string;
  cancelled?: boolean;
  uncertainPaths: string[];
};
export type UploadRequest = (
  path: string,
  options: RequestInit,
) => Promise<{ uploaded: number; directories?: number }>;

function relativePath(value: string) {
  const segments = value.split("/");
  if (
    !value ||
    encoder.encode(value).length > 4096 ||
    segments.some(
      (segment) =>
        !segment ||
        segment.length > 180 ||
        segment !== segment.trim() ||
        segment === "." ||
        segment === ".." ||
        /[<>:"\\|?*\x00-\x1f]/.test(segment) ||
        /[ .]$/.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
    )
  )
    throw new Error(
      `The upload contains an unsupported path: ${value || "(empty path)"}.`,
    );
  return value;
}

function addParents(path: string, directories: Set<string>) {
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index++)
    directories.add(segments.slice(0, index).join("/"));
}

/** Validate the complete selection before sending its first mutation. */
function normalizedSource(source: UploadSource): UploadSource {
  const directories = new Set(source.directories.map(relativePath));
  const seen = new Set<string>();
  const files = source.files.map(({ file, path }) => {
    relativePath(path);
    if (seen.has(path))
      throw new Error(`The upload contains two files at ${path}.`);
    if (file.size > UPLOAD_FILE_SIZE_LIMIT)
      throw new Error(`${path} exceeds the 256 MiB limit for one file.`);
    seen.add(path);
    addParents(path, directories);
    return { file, path };
  });
  for (const directory of [...directories]) addParents(directory, directories);
  for (const directory of directories)
    if (seen.has(directory))
      throw new Error(
        `${directory} is both a file and a folder in this upload.`,
      );
  return {
    files,
    directories: [...directories].sort(
      (left, right) =>
        left.split("/").length - right.split("/").length ||
        left.localeCompare(right),
    ),
  };
}

/** A folder input exposes paths for files, but browsers omit empty folders. */
export function collectSelectedUpload(
  files: FileList | readonly File[],
): UploadSource {
  return normalizedSource({
    files: Array.from(files).map((file) => ({
      file,
      path: file.webkitRelativePath || file.name,
    })),
    directories: [],
  });
}

function entryResult<T>(
  read: (
    success: (value: T) => void,
    failure: (cause: DOMException) => void,
  ) => void,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () =>
      reject(
        signal?.reason ||
          new DOMException("Folder reading stopped.", "AbortError"),
      );
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      read(
        (value) => {
          signal?.removeEventListener("abort", aborted);
          resolve(value);
        },
        (cause) => {
          signal?.removeEventListener("abort", aborted);
          reject(cause);
        },
      );
    } catch (cause) {
      signal?.removeEventListener("abort", aborted);
      reject(cause);
    }
  });
}

/** Capture drag-store entries synchronously, then enumerate every reader batch. */
export async function collectDroppedUpload(
  transfer: Pick<DataTransfer, "items" | "files">,
  { signal, onProgress }: UploadCollectionOptions = {},
): Promise<UploadSource> {
  signal?.throwIfAborted();
  const roots = Array.from(transfer.items || [])
    .filter((item) => item.kind === "file")
    .map((item) => ({
      entry: item.webkitGetAsEntry?.() || null,
      file: item.getAsFile(),
    }));
  const fallbackFiles = Array.from(transfer.files || []);
  if (!roots.length) return collectSelectedUpload(fallbackFiles);
  const source: UploadSource = { files: [], directories: [] };
  const emit = () =>
    onProgress?.({
      files: source.files.length,
      directories: source.directories.length,
    });
  const pending: { entry: FileSystemEntry; path: string }[] = [];
  for (const root of roots) {
    if (root.entry) pending.push({ entry: root.entry, path: root.entry.name });
    else if (root.file)
      source.files.push({ file: root.file, path: root.file.name });
    else
      throw new Error(
        "This browser could not read a dropped folder. Choose it with Upload folder instead.",
      );
  }
  while (pending.length) {
    signal?.throwIfAborted();
    const { entry, path } = pending.pop()!;
    relativePath(path);
    if (entry.isFile) {
      const file = await entryResult<File>(
        (success, failure) =>
          (entry as FileSystemFileEntry).file(success, failure),
        signal,
      );
      source.files.push({ file, path });
    } else if (entry.isDirectory) {
      source.directories.push(path);
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const children = await entryResult<FileSystemEntry[]>(
          (success, failure) => reader.readEntries(success, failure),
          signal,
        );
        if (!children.length) break;
        for (const child of children)
          pending.push({ entry: child, path: `${path}/${child.name}` });
      }
    } else throw new Error(`This browser could not read ${path}.`);
    emit();
  }
  signal?.throwIfAborted();
  return normalizedSource(source);
}

function directoryBatches(directories: string[]) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 2;
  for (const directory of directories) {
    const entryBytes = encoder.encode(JSON.stringify(directory)).length;
    if (
      batch.length &&
      (batch.length >= 1000 || bytes + entryBytes + 1 > FIELD_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 2;
    }
    bytes += entryBytes + (batch.length ? 1 : 0);
    batch.push(directory);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function fileBatches(files: UploadFile[]) {
  const batches: UploadFile[][] = [];
  let batch: UploadFile[] = [];
  let bytes = 0;
  for (const entry of files) {
    if (
      batch.length &&
      (batch.length >= UPLOAD_FILES_PER_BATCH ||
        bytes + entry.file.size > BATCH_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(entry);
    bytes += entry.file.size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Each acknowledged batch is final. Failed or interrupted batches are never retried. */
export async function uploadInBatches({
  source: input,
  destination,
  request,
  signal,
  onProgress,
}: {
  source: UploadSource;
  destination: string;
  request: UploadRequest;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
}): Promise<UploadResult> {
  const progress: UploadProgress = {
    phase: "uploading",
    uploadedFiles: 0,
    totalFiles: input.files.length,
    uploadedBytes: 0,
    totalBytes: input.files.reduce(
      (total, entry) => total + entry.file.size,
      0,
    ),
    completedDirectories: 0,
    totalDirectories: input.directories.length,
    currentPaths: [],
  };
  const finish = (
    phase: UploadProgress["phase"],
    message?: string,
    uncertainPaths: string[] = [],
  ): UploadResult => {
    progress.phase = phase;
    onProgress?.({ ...progress, currentPaths: [...progress.currentPaths] });
    return {
      ...progress,
      currentPaths: [...progress.currentPaths],
      message,
      uncertainPaths,
      cancelled: signal?.aborted || false,
    };
  };
  let source: UploadSource;
  try {
    if (destination) relativePath(destination);
    source = normalizedSource(input);
    progress.totalDirectories = source.directories.length;
  } catch (cause) {
    return finish(
      "failed",
      cause instanceof Error
        ? cause.message
        : "The upload selection is invalid.",
    );
  }
  const batches = [
    ...directoryBatches(source.directories).map((directories) => ({
      directories,
      files: [] as UploadFile[],
    })),
    ...fileBatches(source.files).map((files) => ({
      directories: [] as string[],
      files,
    })),
  ];
  for (const batch of batches) {
    if (signal?.aborted)
      return finish(
        "cancelled",
        "Upload stopped. Previously completed batches remain on the server.",
      );
    const form = new FormData();
    if (batch.directories.length)
      form.append("directories", JSON.stringify(batch.directories));
    if (batch.files.length) {
      for (const entry of batch.files)
        form.append("files", entry.file, entry.file.name);
      form.append(
        "paths",
        JSON.stringify(batch.files.map((entry) => entry.path)),
      );
      form.append(
        "modified",
        JSON.stringify(batch.files.map((entry) => entry.file.lastModified)),
      );
    }
    progress.currentPaths = [
      ...batch.directories,
      ...batch.files.map((entry) => entry.path),
    ];
    onProgress?.({ ...progress, currentPaths: [...progress.currentPaths] });
    try {
      const result = await request(
        `/files/upload?path=${encodeURIComponent(destination)}`,
        { method: "POST", body: form, signal },
      );
      if (result.uploaded !== batch.files.length)
        throw new Error("The server did not confirm every file in the batch.");
      progress.uploadedFiles += batch.files.length;
      progress.uploadedBytes += batch.files.reduce(
        (total, entry) => total + entry.file.size,
        0,
      );
      progress.completedDirectories += batch.directories.length;
      onProgress?.({ ...progress, currentPaths: [...progress.currentPaths] });
    } catch (cause) {
      const failure = cause as {
        status?: number;
        uploaded?: number;
        directories?: number;
      };
      if (
        !signal?.aborted &&
        failure?.status &&
        Number.isInteger(failure.uploaded) &&
        failure.uploaded! >= 0 &&
        failure.uploaded! <= batch.files.length &&
        Number.isInteger(failure.directories) &&
        failure.directories! >= 0
      ) {
        progress.uploadedFiles += failure.uploaded!;
        progress.uploadedBytes += batch.files
          .slice(0, failure.uploaded)
          .reduce((total, entry) => total + entry.file.size, 0);
        progress.completedDirectories += Math.min(
          failure.directories!,
          batch.directories.length,
        );
        return finish(
          "failed",
          `${
            cause instanceof Error
              ? cause.message
              : "The server could not finish this upload batch."
          } Previously completed files remain on the server. Check the destination before uploading this batch again.`,
        );
      }
      return finish(
        "uncertain",
        `${cause instanceof Error && cause.message ? `${cause.message} ` : ""}The current batch was not confirmed and may have reached the server. Check the destination before uploading it again. Previously completed batches remain on the server.`,
        [...progress.currentPaths],
      );
    }
  }
  progress.currentPaths = [];
  return finish("completed");
}
