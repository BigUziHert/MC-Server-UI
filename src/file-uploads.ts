export const UPLOAD_FILES_PER_BATCH = 100;
export const UPLOAD_FILE_SIZE_LIMIT = 256 * 1024 * 1024;
const LEGACY_UPLOAD_FILES_PER_BATCH = 20;
const COLLECTION_CONCURRENCY = 8;
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
  let lastProgress = -Infinity;
  const emit = (force = false) => {
    const now = performance.now();
    if (!force && now - lastProgress < 50) return;
    lastProgress = now;
    onProgress?.({
      files: source.files.length,
      directories: source.directories.length,
    });
  };
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
  const controller = new AbortController();
  const readingSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    while (pending.length) {
      readingSignal.throwIfAborted();
      // Filesystem entry callbacks often cross a browser/OS boundary. Keep a
      // bounded set in flight instead of paying that latency for every file.
      const batch = pending.splice(-COLLECTION_CONCURRENCY);
      await Promise.all(
        batch.map(async ({ entry, path }) => {
          relativePath(path);
          if (entry.isFile) {
            const file = await entryResult<File>(
              (success, failure) =>
                (entry as FileSystemFileEntry).file(success, failure),
              readingSignal,
            );
            source.files.push({ file, path });
          } else if (entry.isDirectory) {
            source.directories.push(path);
            const reader = (entry as FileSystemDirectoryEntry).createReader();
            for (;;) {
              const children = await entryResult<FileSystemEntry[]>(
                (success, failure) => reader.readEntries(success, failure),
                readingSignal,
              );
              if (!children.length) break;
              for (const child of children)
                pending.push({ entry: child, path: `${path}/${child.name}` });
            }
          } else throw new Error(`This browser could not read ${path}.`);
          readingSignal.throwIfAborted();
          emit();
        }),
      );
    }
    signal?.throwIfAborted();
    emit(true);
    return normalizedSource(source);
  } finally {
    // A failing reader must also release siblings that never call back.
    controller.abort();
  }
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

function fileBatches(files: UploadFile[], maxFilesPerBatch: number) {
  const batches: UploadFile[][] = [];
  let batch: UploadFile[] = [];
  let bytes = 0;
  let pathBytes = 2;
  for (const entry of files) {
    const entryPathBytes = encoder.encode(JSON.stringify(entry.path)).length;
    if (
      batch.length &&
      (batch.length >= maxFilesPerBatch ||
        bytes + entry.file.size > BATCH_BYTES ||
        pathBytes + entryPathBytes + 1 > FIELD_BYTES)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
      pathBytes = 2;
    }
    pathBytes += entryPathBytes + (batch.length ? 1 : 0);
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
  maxFilesPerBatch = LEGACY_UPLOAD_FILES_PER_BATCH,
}: {
  source: UploadSource;
  destination: string;
  request: UploadRequest;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  /** Use only the destination host's advertised limit; old hosts accept 20. */
  maxFilesPerBatch?: number;
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
    ...fileBatches(
      source.files,
      Number.isInteger(maxFilesPerBatch) && maxFilesPerBatch > 0
        ? Math.min(maxFilesPerBatch, UPLOAD_FILES_PER_BATCH)
        : LEGACY_UPLOAD_FILES_PER_BATCH,
    ).map((files) => ({
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
        uploadedPaths?: string[];
      };
      const confirmedPaths = failure?.uploadedPaths;
      const confirmedFiles = Array.isArray(confirmedPaths)
        ? batch.files.filter(({ path }) =>
            confirmedPaths.includes(
              [destination, path].filter(Boolean).join("/"),
            ),
          )
        : batch.files.slice(0, failure?.uploaded);
      if (
        !signal?.aborted &&
        failure?.status &&
        Number.isInteger(failure.uploaded) &&
        failure.uploaded! >= 0 &&
        failure.uploaded! <= batch.files.length &&
        (confirmedPaths === undefined ||
          (Array.isArray(confirmedPaths) &&
            confirmedPaths.length === failure.uploaded &&
            confirmedFiles.length === failure.uploaded &&
            new Set(confirmedPaths).size === confirmedPaths.length)) &&
        Number.isInteger(failure.directories) &&
        failure.directories! >= 0
      ) {
        progress.uploadedFiles += failure.uploaded!;
        progress.uploadedBytes += confirmedFiles.reduce(
          (total, entry) => total + entry.file.size,
          0,
        );
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
