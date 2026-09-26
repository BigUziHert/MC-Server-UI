import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import {
  ChevronRight,
  Copy,
  ClipboardPaste,
  Download,
  File as FileIcon,
  FileArchive,
  FileCode2,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  useServerApi,
  formatBytes,
  relativeTime,
  messageOf,
  ServerScope,
  type PageProps,
} from "../api";
import "./storage.css";
import "./storage-dialog.css";
import SearchField, { useDebouncedValue } from "../SearchField";
import RefreshButton from "../RefreshButton";
import StatePanel from "../StatePanel";
import Pagination from "../Pagination";
import "./file-selection.css";
import "./recycle-bin.css";
import {
  copyFiles,
  clearFileClipboard,
  useFileClipboard,
} from "../file-clipboard";
import {
  collectDroppedUpload,
  collectSelectedUpload,
  uploadInBatches,
  type UploadSource,
} from "../file-uploads";
import {
  startFileTransfer,
  useFileTransfer,
  dismissFileTransfer,
  pasteFiles,
  UnconfirmedTransfer,
  type Transfer,
} from "../file-transfer-state";

function TransferProgress({
  transfer,
  onDismiss,
}: {
  transfer: Transfer;
  onDismiss: () => void;
}) {
  const running = transfer.status === "running";
  return (
    <section
      className="file-transfer-progress"
      role="status"
      aria-label="File transfer progress"
    >
      <div className="file-transfer-title">
        <strong>
          {running
            ? transfer.kind === "upload"
              ? "Uploading files"
              : "Copying files"
            : transfer.status === "completed"
              ? "Transfer complete"
              : "Transfer needs attention"}
        </strong>
        {!running && (
          <button
            className="btn icon"
            onClick={onDismiss}
            aria-label="Dismiss transfer status"
          >
            <X size={16} />
          </button>
        )}
      </div>
      <p>{transfer.message}</p>
      {running && (
        <>
          <p>
            {transfer.serverName} · /{transfer.destination || "server"}
          </p>
          <progress
            aria-label="File transfer progress"
            max={transfer.totalBytes || undefined}
            value={
              transfer.totalBytes
                ? Math.min(transfer.completedBytes, transfer.totalBytes)
                : undefined
            }
          />
          <small>
            {transfer.totalFiles === null
              ? `${transfer.completedFiles} files found`
              : `${transfer.completedFiles} of ${transfer.totalFiles} files`}
            {transfer.totalBytes
              ? ` · ${formatBytes(transfer.completedBytes)} of ${formatBytes(transfer.totalBytes)}`
              : ""}
          </small>
          <p>You can browse the panel while this finishes.</p>
        </>
      )}
    </section>
  );
}

type Entry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  modified: string;
};
type FileResult = { path: string; entries: Entry[] };
type RecycledItem = {
  id: string;
  name: string;
  originalPath: string;
  kind?: "backup";
  type: "file" | "directory";
  size: number;
  deletedAt: string;
  status: "ready" | "incomplete";
  message?: string;
};
type FileDialog =
  | { type: "create"; kind: "file" | "directory" }
  | { type: "edit"; entry: Entry }
  | { type: "delete"; entry: Entry }
  | {
      type: "delete-many";
      entries: Entry[];
      failures?: { entry: Entry; message: string }[];
    };
type RecycleOperation = {
  id: string;
  path: string;
  status: "running" | "completed" | "failed";
  phase:
    | "scanning"
    | "copying"
    | "verifying"
    | "removing"
    | "finalizing"
    | "completed"
    | "failed";
  crossDrive: boolean;
  filesProcessed: number;
  totalFiles: number | null;
  bytesProcessed: number;
  totalBytes: number | null;
  error?: string;
};
type MoveBatch = {
  id: string;
  targets: Entry[];
  completed: string[];
  failures: { entry: Entry; message: string }[];
  unconfirmed: { entry: Entry; requestId: string } | null;
  running: boolean;
  operation: RecycleOperation | null;
  connectionError: string;
};
type FileApi = ReturnType<typeof useServerApi>["api"];
class UnconfirmedMove extends Error {}
const unconfirmedMessage =
  "The move's outcome could not be confirmed. It may still finish on the server. Check its status or inspect the source folder and Recycle Bin. No move was retried; remaining items were not sent.";
// Keep pending moves bound to their server even when its page is unmounted.
// A dropped response is resolved through the operation ID, never by replaying DELETE.
const moveBatches = new Map<string, MoveBatch>();
const moveTransports = new Map<string, Set<AbortController>>();
const moveListeners = new Set<() => void>();
const subscribeMoves = (listener: () => void) => {
  moveListeners.add(listener);
  return () => {
    moveListeners.delete(listener);
  };
};
function updateMove(key: string, update: Partial<MoveBatch>, batchId?: string) {
  const previous = moveBatches.get(key);
  if (!previous || (batchId && previous.id !== batchId)) return;
  moveBatches.set(key, { ...previous, ...update });
  moveListeners.forEach((listener) => listener());
}
function waitForMove(
  api: FileApi,
  key: string,
  id: string,
  target?: string,
  onLateResult?: (failure?: Error) => void,
) {
  const batchId = moveBatches.get(key)?.id;
  const update = (value: Partial<MoveBatch>) => updateMove(key, value, batchId);
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let unconfirmed = false;
    let requestPending = target !== undefined;
    let unavailableChecks = 0;
    let statusUnsupported = false;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const finish = (failure?: Error) => {
      if (finished) return;
      finished = true;
      unconfirmed = failure instanceof UnconfirmedMove;
      clearTimeout(timer);
      failure ? reject(failure) : resolve();
    };
    const poll = async () => {
      try {
        const { operation } = await api<{ operation: RecycleOperation | null }>(
          `/files/recycle-operation?requestId=${encodeURIComponent(id)}`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (finished) return;
        if (operation?.id === id) {
          unavailableChecks = 0;
          update({ operation, connectionError: "" });
          if (operation.status === "completed") finish();
          else if (operation.status === "failed")
            finish(
              new Error(operation.error || "The item could not be moved."),
            );
        } else unavailableChecks++;
      } catch (failure) {
        const status = (failure as { status?: number })?.status;
        if (status === 401 || status === 403) {
          finish(new UnconfirmedMove(unconfirmedMessage));
          return;
        }
        if (status === 404) statusUnsupported = true;
        unavailableChecks++;
        if (!finished)
          update({
            connectionError:
              "Connection interrupted. Checking the move's status; it has not been retried.",
          });
      } finally {
        if (
          !finished &&
          unavailableChecks >= 5 &&
          (!requestPending || Date.now() - started >= 30000)
        )
          finish(new UnconfirmedMove(unconfirmedMessage));
        if (!finished && !(statusUnsupported && requestPending))
          timer = setTimeout(poll, 1000);
        else if (!finished)
          timer = setTimeout(
            () => finish(new UnconfirmedMove(unconfirmedMessage)),
            Math.max(0, 30000 - (Date.now() - started)),
          );
      }
    };
    timer = setTimeout(poll, 100);
    if (target !== undefined) {
      const transport = new AbortController();
      if (batchId) {
        if (!moveTransports.has(batchId))
          moveTransports.set(batchId, new Set());
        moveTransports.get(batchId)!.add(transport);
      }
      void api(
        `/files?${new URLSearchParams({ path: target, requestId: id })}`,
        { method: "DELETE", signal: transport.signal },
      )
        .then(() => {
          if (finished && unconfirmed) onLateResult?.();
          else finish();
        })
        .catch((failure) => {
          requestPending = false;
          if (finished) {
            if (unconfirmed && failure?.status >= 400 && failure.status < 500)
              onLateResult?.(failure);
            return;
          }
          // A rejected request is definitive only when the server refused it.
          // Transport failures and server errors may arrive after the move started.
          if (failure?.status === 401)
            finish(new UnconfirmedMove(unconfirmedMessage));
          else if (failure?.status >= 400 && failure.status < 500)
            finish(failure);
          else if (statusUnsupported)
            finish(new UnconfirmedMove(unconfirmedMessage));
          else
            update({
              connectionError:
                "The response was interrupted. Checking the move's status; it has not been retried.",
            });
        })
        .finally(() => {
          if (batchId) {
            const transports = moveTransports.get(batchId);
            transports?.delete(transport);
            if (!transports?.size) moveTransports.delete(batchId);
          }
        });
    }
  });
}
function resolveUnconfirmed(
  key: string,
  requestId: string,
  notify: PageProps["notify"],
  failure?: Error,
) {
  const batch = moveBatches.get(key);
  if (batch?.unconfirmed?.requestId !== requestId) return;
  const { entry } = batch.unconfirmed;
  updateMove(key, {
    running: false,
    unconfirmed: null,
    connectionError: "",
    completed: failure ? batch.completed : [...batch.completed, entry.path],
    failures: failure
      ? [...batch.failures, { entry, message: failure.message }]
      : batch.failures,
  });
  notify(
    failure ? failure.message : `${entry.name} moved to Recycle Bin.`,
    !!failure,
  );
}
function checkUnconfirmed(
  api: FileApi,
  key: string,
  notify: PageProps["notify"],
) {
  const batch = moveBatches.get(key);
  if (!batch?.unconfirmed || batch.running) return;
  const { requestId } = batch.unconfirmed;
  updateMove(key, {
    running: true,
    connectionError: "Checking the move's status…",
  });
  void waitForMove(api, key, requestId)
    .then(() => resolveUnconfirmed(key, requestId, notify))
    .catch((failure) => {
      if (failure instanceof UnconfirmedMove)
        updateMove(
          key,
          {
            running: false,
            connectionError: unconfirmedMessage,
          },
          batch.id,
        );
      else resolveUnconfirmed(key, requestId, notify, failure);
    });
}
function dismissUnconfirmed(key: string) {
  const batch = moveBatches.get(key);
  if (!batch?.unconfirmed || batch.running) return;
  moveBatches.delete(key);
  moveTransports.get(batch.id)?.forEach((transport) => transport.abort());
  moveTransports.delete(batch.id);
  moveListeners.forEach((listener) => listener());
}
function startMoveBatch(
  api: FileApi,
  key: string,
  targets: Entry[],
  notify: PageProps["notify"],
  existing?: RecycleOperation,
) {
  if (moveBatches.get(key)?.running || moveBatches.get(key)?.unconfirmed)
    return null;
  const id = crypto.randomUUID();
  moveBatches.set(key, {
    id,
    targets,
    completed: [],
    failures: [],
    unconfirmed: null,
    running: true,
    operation: existing || null,
    connectionError: "",
  });
  moveListeners.forEach((listener) => listener());
  void (async () => {
    const completed: string[] = [];
    const failures: MoveBatch["failures"] = [];
    for (const entry of targets) {
      const requestId = existing?.id || crypto.randomUUID();
      updateMove(key, { operation: existing || null, connectionError: "" });
      try {
        await waitForMove(
          api,
          key,
          requestId,
          existing ? undefined : entry.path,
          (failure) => resolveUnconfirmed(key, requestId, notify, failure),
        );
        completed.push(entry.path);
      } catch (failure) {
        if (failure instanceof UnconfirmedMove) {
          updateMove(key, {
            unconfirmed: { entry, requestId },
            connectionError: unconfirmedMessage,
          });
          break;
        }
        failures.push({ entry, message: messageOf(failure) });
      }
      updateMove(key, { completed: [...completed], failures: [...failures] });
    }
    const unconfirmed = moveBatches.get(key)?.unconfirmed;
    updateMove(key, {
      running: false,
      connectionError: unconfirmed ? unconfirmedMessage : "",
    });
    const summary = unconfirmed
      ? unconfirmedMessage
      : targets.length === 1 && !failures.length
        ? `${targets[0].name} moved to Recycle Bin.`
        : `${completed.length} ${completed.length === 1 ? "item" : "items"} moved to Recycle Bin.${failures.length ? ` ${failures.length} ${failures.length === 1 ? "item could not be moved and remains" : "items could not be moved and remain"} selected.` : ""}`;
    notify(summary, failures.length > 0 || !!unconfirmed);
  })();
  return id;
}
function moveDescription(batch: MoveBatch) {
  if (batch.connectionError) return batch.connectionError;
  const operation = batch.operation;
  if (!operation) return "Preparing the move…";
  const phase = {
    scanning: "Scanning files",
    copying: "Copying and checking files",
    verifying: "Verifying files",
    removing: "Removing the original files",
    finalizing: "Finishing the move",
    completed: "Move completed",
    failed: "Move failed",
  }[operation.phase];
  const count =
    operation.totalFiles === null
      ? `${operation.filesProcessed} files scanned`
      : `${operation.filesProcessed} of ${operation.totalFiles} files`;
  const bytes = operation.totalBytes
    ? ` · ${formatBytes(operation.bytesProcessed)} of ${formatBytes(operation.totalBytes)}`
    : "";
  return `${phase} · ${count}${bytes}${operation.crossDrive ? " · Moving between drives" : ""}`;
}
function MoveProgress({
  batch,
  onCheck,
  onDismiss,
}: {
  batch: MoveBatch;
  onCheck: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="recycle-bin-notice"
      role="status"
      aria-label="Move to Recycle Bin progress"
    >
      <LoaderCircle size={18} className={batch.running ? "spin" : ""} />
      <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
        <strong>
          {batch.unconfirmed ? "Move not confirmed" : "Moving to Recycle Bin"} ·{" "}
          {batch.completed.length + batch.failures.length} of{" "}
          {batch.targets.length} items finished
        </strong>
        <p>
          {batch.operation?.path ||
            batch.targets[batch.completed.length + batch.failures.length]?.path}
        </p>
        {batch.unconfirmed && (
          <>
            <button
              type="button"
              className="btn small"
              disabled={batch.running}
              onClick={onCheck}
            >
              Check move status
            </button>
            <p>
              After checking the source folder and Recycle Bin, you can dismiss
              this notice. This does not cancel a move on the server.
            </p>
            <button
              type="button"
              className="btn small"
              disabled={batch.running}
              onClick={onDismiss}
            >
              I've checked the files
            </button>
          </>
        )}
        <p>{moveDescription(batch)}</p>
        <p>
          You can keep using the panel. Closing a dialog does not cancel this
          move.
        </p>
      </div>
    </div>
  );
}
const editable = (name: string) =>
  /\.(txt|log|json|ya?ml|toml|properties|conf|cfg|ini|md|xml|csv|js|ts|sh|bat|mcmeta)$/i.test(
    name,
  ) || !name.includes(".");

function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.type === "directory")
    return <Folder size={19} className="folder-icon" />;
  if (/\.(jar|zip|gz|tar|rar|7z)$/i.test(entry.name))
    return <FileArchive size={18} />;
  if (/\.(json|ya?ml|properties|toml|cfg|conf)$/i.test(entry.name))
    return <FileCode2 size={18} />;
  return editable(entry.name) ? <FileText size={18} /> : <FileIcon size={18} />;
}

export default function FileManager({
  notify,
  serverName = "This server",
  permissions,
  path,
  onPathChange: setPath,
  showingBin,
  onBinChange: setShowingBin,
}: PageProps & {
  serverName?: string;
  permissions?: string[];
  path: string;
  onPathChange: (path: string) => void;
  showingBin: boolean;
  onBinChange: (showing: boolean) => void;
}) {
  const canRead =
    permissions === undefined || permissions.includes("file.read");
  const canContent =
    permissions === undefined || permissions.includes("file.read-content");
  const canCreate =
    permissions === undefined || permissions.includes("file.create");
  const canUpdate =
    permissions === undefined || permissions.includes("file.update");
  const canDelete =
    permissions === undefined || permissions.includes("file.delete");
  const canBin =
    canRead &&
    (permissions === undefined || permissions.includes("backup.read"));
  const { api, post, downloadUrl } = useServerApi();
  const serverId = useContext(ServerScope);
  const transferKey = `${window.location.origin}:${serverId || "default"}`;
  const transfer = useFileTransfer(transferKey);
  const transferring = transfer?.status === "running";
  const uploading = transferring && transfer.kind === "upload";
  const clipboard = useFileClipboard();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query);
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25);
  const loaded = useRef(false);
  useEffect(() => setPage(1), [debouncedQuery, pageSize, path]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<FileDialog | null>(null);
  const canSubmitDialog =
    dialog?.type === "create"
      ? canCreate
      : dialog?.type === "edit"
        ? canContent && canUpdate
        : canDelete;
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [encoding, setEncoding] = useState<"utf8" | "latin1">("utf8");
  const [revision, setRevision] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const moveKey = downloadUrl("/files");
  const moveBatch = useSyncExternalStore(
    subscribeMoves,
    () => moveBatches.get(moveKey) || null,
  );
  const moving = Boolean(moveBatch?.running);
  const movePending = moving || Boolean(moveBatch?.unconfirmed);
  const [checkingMove, setCheckingMove] = useState(true);
  const [dialogMoveId, setDialogMoveId] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const focusSearchAfterClose = useRef(false);
  const dragDepth = useRef(0);
  const editRequestId = useRef(0);
  const savingRef = useRef(false);
  const pathRef = useRef(path);
  const handledMove = useRef<string | null>(null);
  const handledTransfer = useRef<string | null>(null);
  savingRef.current = saving;
  pathRef.current = path;

  const load = useCallback(async () => {
    if (!canRead) {
      setLoading(false);
      return false;
    }
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const result = await api<FileResult>(
        `/files?path=${encodeURIComponent(path)}`,
      );
      if (id === requestId.current) {
        loaded.current = true;
        setEntries(result.entries);
        const available = new Set(result.entries.map((entry) => entry.path));
        setSelected(
          (previous) =>
            new Set([...previous].filter((item) => available.has(item))),
        );
        return true;
      }
      return false;
    } catch (failure) {
      if (id === requestId.current) setError(messageOf(failure));
      return false;
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [path, api, canRead]);

  useEffect(() => {
    if (
      !transfer ||
      transfer.status === "running" ||
      handledTransfer.current === `${transfer.id}:${transfer.status}`
    )
      return;
    handledTransfer.current = `${transfer.id}:${transfer.status}`;
    void load();
  }, [transfer, load]);

  useEffect(() => {
    let active = true;
    if (!canDelete) {
      setCheckingMove(false);
      return;
    }
    setCheckingMove(true);
    void api<{ operation: RecycleOperation | null }>(
      "/files/recycle-operation",
      {
        signal: AbortSignal.timeout(5000),
      },
    )
      .then(({ operation }) => {
        if (!active || operation?.status !== "running") return;
        startMoveBatch(
          api,
          moveKey,
          [
            {
              name: operation.path.split("/").pop() || operation.path,
              path: operation.path,
              type: "directory",
              size: 0,
              modified: "",
            },
          ],
          notify,
          operation,
        );
      })
      .catch(() => {})
      .finally(() => {
        if (active) setCheckingMove(false);
      });
    return () => {
      active = false;
    };
  }, [api, moveKey, canDelete]);

  useEffect(() => {
    const resultKey =
      moveBatch &&
      `${moveBatch.id}:${moveBatch.completed.length}:${moveBatch.failures.length}:${!!moveBatch.unconfirmed}`;
    if (!moveBatch || moveBatch.running || handledMove.current === resultKey)
      return;
    handledMove.current = resultKey;
    const completed = new Set(moveBatch.completed);
    if (
      !dialog &&
      moveBatch.targets.some(
        (entry) =>
          completed.has(entry.path) &&
          document.activeElement?.getAttribute("aria-label") ===
            `Delete ${entry.name}`,
      )
    )
      searchInput.current?.focus();
    setEntries((previous) =>
      previous.filter((entry) => !completed.has(entry.path)),
    );
    setSelected((previous) => {
      const remaining = new Set(
        [...previous].filter((item) => !completed.has(item)),
      );
      moveBatch.failures.forEach(({ entry }) => remaining.add(entry.path));
      return remaining;
    });
    // A background completion must not dismiss or overwrite a newer dialog.
    if (dialogMoveId === moveBatch.id) {
      if (moveBatch.unconfirmed) {
        setDialogError(unconfirmedMessage);
      } else if (moveBatch.failures.length) {
        if (moveBatch.targets.length > 1)
          setDialog({
            type: "delete-many",
            entries: moveBatch.failures.map(({ entry }) => entry),
            failures: moveBatch.failures,
          });
        setDialogError(
          moveBatch.targets.length > 1
            ? `${moveBatch.completed.length} ${moveBatch.completed.length === 1 ? "item" : "items"} moved to Recycle Bin. ${moveBatch.failures.length} ${moveBatch.failures.length === 1 ? "item could not be moved and remains" : "items could not be moved and remain"} selected.`
            : moveBatch.failures[0].message,
        );
        setDialogMoveId(null);
      } else {
        focusSearchAfterClose.current = true;
        closeDialog();
      }
    }
    void load();
  }, [moveBatch, dialogMoveId, load]);

  useEffect(() => {
    loaded.current = false;
    setEntries([]);
    setQuery("");
    setPage(1);
  }, [api, path]);
  useEffect(() => {
    if (!showingBin || !canBin) void load();
    return () => {
      requestId.current++;
    };
  }, [load, showingBin, canBin]);
  useEffect(() => {
    setSelected(new Set());
  }, [path, api, showingBin]);
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const element = dialogRef.current;
    element?.showModal();
    element
      ?.querySelector<HTMLElement>(
        "input:not(:disabled), textarea:not(:disabled)",
      )
      ?.focus();
    return () => {
      element?.close();
      if (!focusSearchAfterClose.current && previous?.isConnected)
        previous.focus();
      if (
        (focusSearchAfterClose.current ||
          document.activeElement !== previous) &&
        searchInput.current?.isConnected
      )
        searchInput.current.focus();
      focusSearchAfterClose.current = false;
    };
  }, [dialog]);

  function navigate(next: string) {
    if (savingRef.current || next === path) return;
    setSelected(new Set());
    setQuery("");
    setEntries([]);
    setPath(next);
  }
  function closeDialog() {
    editRequestId.current++;
    setReading(false);
    setDialog(null);
    setDialogMoveId(null);
  }
  function openDelete(entry: Entry) {
    if (!canDelete || movePending || checkingMove) return;
    editRequestId.current++;
    setReading(false);
    setDialogError("");
    setDialog({ type: "delete", entry });
  }
  function openDeleteSelected() {
    if (!canDelete || movePending || checkingMove) return;
    const targets = entries.filter((entry) => selected.has(entry.path));
    if (!targets.length || savingRef.current) return;
    editRequestId.current++;
    setReading(false);
    setDialogError("");
    setDialog({ type: "delete-many", entries: targets });
  }
  function toggleSelection(entryPath: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(entryPath)) next.delete(entryPath);
      else next.add(entryPath);
      return next;
    });
  }
  function openCreate(kind: "file" | "directory") {
    if (!canCreate) return;
    editRequestId.current++;
    setReading(false);
    setReadFailed(false);
    setName("");
    setContent("");
    setRevision(undefined);
    setDialogError("");
    setDialog({ type: "create", kind });
  }

  async function openEntry(entry: Entry) {
    if (entry.type === "directory") {
      navigate(entry.path);
      return;
    }
    if (!canContent) return;
    if (!editable(entry.name)) {
      notify("Use the download button to open this file on your computer.");
      return;
    }
    const id = ++editRequestId.current;
    setContent("");
    setRevision(undefined);
    setDialogError("");
    setReadFailed(false);
    setReading(true);
    setDialog({ type: "edit", entry });
    try {
      const result = await api<{
        content: string;
        encoding?: "utf8" | "latin1";
        revision?: string;
      }>(`/files/content?path=${encodeURIComponent(entry.path)}`);
      if (id === editRequestId.current) {
        setContent(result.content);
        setEncoding(result.encoding ?? "utf8");
        setRevision(result.revision);
      }
    } catch (failure) {
      if (id === editRequestId.current) {
        setDialogError(messageOf(failure));
        setReadFailed(true);
      }
    } finally {
      if (id === editRequestId.current) setReading(false);
    }
  }

  function uploadFiles(source: () => UploadSource | Promise<UploadSource>) {
    if (!canCreate || transferring || movePending) return;
    const uploadPath = path;
    startFileTransfer(
      transferKey,
      { kind: "upload", destination: uploadPath, serverName },
      async (report) => {
        report({ message: "Reading files and folders…" });
        const files = await source();
        const result = await uploadInBatches({
          source: files,
          destination: uploadPath,
          request: api,
          onProgress: (progress) =>
            report({
              message: "Uploading files…",
              completedFiles: progress.uploadedFiles,
              totalFiles: progress.totalFiles,
              completedBytes: progress.uploadedBytes,
              totalBytes: progress.totalBytes,
            }),
        });
        if (result.phase !== "completed")
          throw new (
            result.phase === "uncertain" ? UnconfirmedTransfer : Error
          )(
            result.message ||
              `Upload stopped after ${result.uploadedFiles} files. Check the destination before retrying.`,
          );
        return `${result.uploadedFiles} ${result.uploadedFiles === 1 ? "file uploaded" : "files uploaded"}${result.totalDirectories ? ` with ${result.totalDirectories} folders` : ""} to /${uploadPath || "server"}.`;
      },
      notify,
    );
    if (uploadInput.current) uploadInput.current.value = "";
    if (folderInput.current) folderInput.current.value = "";
  }

  function copySelection() {
    if (!canContent || !serverId || loading) return;
    const targets = entries.filter((entry) => selected.has(entry.path));
    if (!targets.length) return;
    copyFiles({
      origin: window.location.origin,
      sourceServerId: serverId,
      sourceName: serverName,
      paths: targets.map((entry) => entry.path),
    });
    notify(
      `${targets.length} ${targets.length === 1 ? "item" : "items"} ready to paste.`,
    );
  }
  function pasteSelection() {
    if (
      !canCreate ||
      !clipboard ||
      clipboard.origin !== window.location.origin ||
      transferring ||
      movePending ||
      loading
    )
      return;
    const destination = path;
    startFileTransfer(
      transferKey,
      { kind: "copy", destination, serverName },
      (report, requestId) =>
        pasteFiles(
          api,
          {
            sourceServerId: clipboard.sourceServerId,
            paths: [...clipboard.paths],
            destinationPath: destination,
          },
          report,
          requestId,
        ),
      notify,
    );
  }

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        dialog ||
        showingBin
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          "input:not([type=checkbox]):not([type=radio]):not([type=button]),textarea,[contenteditable=true],[role=textbox]",
        )
      )
        return;
      if (window.getSelection()?.toString()) return;
      if (event.key.toLowerCase() === "c" && selected.size && canContent) {
        event.preventDefault();
        copySelection();
      }
      if (event.key.toLowerCase() === "v" && clipboard && canCreate) {
        event.preventDefault();
        pasteSelection();
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });

  async function submitDialog(event: FormEvent) {
    event.preventDefault();
    if (!dialog || !canSubmitDialog || savingRef.current) return;
    if (dialog.type === "delete" || dialog.type === "delete-many") {
      if (movePending || checkingMove) return;
      setDialogError("");
      setDialogMoveId(
        startMoveBatch(
          api,
          moveKey,
          dialog.type === "delete" ? [dialog.entry] : dialog.entries,
          notify,
        ),
      );
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setDialogError("");
    try {
      if (dialog.type === "create") {
        await post("/files", {
          path,
          name: name.trim(),
          type: dialog.kind,
          content,
        });
        notify(`${dialog.kind === "directory" ? "Folder" : "File"} created.`);
      } else if (dialog.type === "edit") {
        await api("/files/content", {
          method: "PUT",
          body: JSON.stringify({
            path: dialog.entry.path,
            content,
            encoding,
            revision,
          }),
        });
        notify(`${dialog.entry.name} saved.`);
      }
      closeDialog();
      await load();
    } catch (failure) {
      setDialogError(messageOf(failure));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const filtered = entries
    .filter((entry) =>
      entry.name.toLowerCase().includes(debouncedQuery.toLowerCase()),
    )
    .sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "directory"
          ? -1
          : 1,
    );
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / pageSize)),
  );
  const visible = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const segments = path.split("/").filter(Boolean);
  const selectedEntries = entries.filter((entry) => selected.has(entry.path));
  const visibleSelectedCount = visible.filter((entry) =>
    selected.has(entry.path),
  ).length;
  const allVisibleSelected =
    visible.length > 0 && visibleSelectedCount === visible.length;
  const hiddenSelectedCount = selectedEntries.length - visibleSelectedCount;
  function toggleVisibleSelection() {
    setSelected((previous) => {
      const next = new Set(previous);
      visible.forEach((entry) =>
        allVisibleSelected ? next.delete(entry.path) : next.add(entry.path),
      );
      return next;
    });
  }
  const totalSize = entries.reduce(
    (sum, entry) => sum + (entry.type === "file" ? entry.size : 0),
    0,
  );
  if (!canRead)
    return (
      <StatePanel
        variant="empty"
        title="Files unavailable"
        message="You do not have permission to browse server files."
      />
    );
  if (showingBin && canBin)
    return (
      <>
        {transfer && (
          <TransferProgress
            transfer={transfer}
            onDismiss={() => dismissFileTransfer(transferKey)}
          />
        )}
        {movePending && moveBatch && (
          <MoveProgress
            batch={moveBatch}
            onCheck={() => checkUnconfirmed(api, moveKey, notify)}
            onDismiss={() => dismissUnconfirmed(moveKey)}
          />
        )}
        <RecycleBin
          notify={notify}
          permissions={permissions}
          onBack={() => {
            setQuery("");
            setShowingBin(false);
          }}
        />
      </>
    );
  return (
    <div className="storage-page">
      <div className="page-heading file-manager-heading">
        <div>
          <h1>File Manager</h1>
        </div>
        <div className="storage-actions">
          <button
            className="btn"
            disabled={!canCreate || transferring || movePending || loading}
            onClick={() => folderInput.current?.click()}
          >
            <FolderPlus size={16} /> Upload folder
          </button>
          <button
            className="btn primary"
            onClick={() => uploadInput.current?.click()}
            disabled={!canCreate || transferring || movePending || loading}
          >
            {uploading ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Upload size={16} />
            )}
            {uploading ? "Uploading…" : "Upload files"}
          </button>
        </div>
        <input
          ref={uploadInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) {
              const files = Array.from(event.target.files);
              uploadFiles(() => collectSelectedUpload(files));
            }
          }}
          disabled={!canCreate}
          aria-label="Upload server files"
        />
        <input
          ref={(element) => {
            folderInput.current = element;
            element?.setAttribute("webkitdirectory", "");
          }}
          type="file"
          multiple
          hidden
          disabled={!canCreate}
          aria-label="Upload server folder"
          onChange={(event) => {
            if (event.target.files) {
              const files = Array.from(event.target.files);
              uploadFiles(() => collectSelectedUpload(files));
            }
          }}
        />
      </div>

      {clipboard && clipboard.origin === window.location.origin && (
        <div
          className="file-clipboard-notice"
          role="status"
          aria-label="Copied files"
        >
          <Copy size={16} />
          <span>
            {clipboard.paths.length}{" "}
            {clipboard.paths.length === 1 ? "item" : "items"} copied from{" "}
            <strong>{clipboard.sourceName}</strong>. Open a folder or another
            server on this PC, then Paste.
          </span>
          <button
            className="btn icon"
            onClick={clearFileClipboard}
            aria-label="Clear copied files"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {transfer && (
        <TransferProgress
          transfer={transfer}
          onDismiss={() => dismissFileTransfer(transferKey)}
        />
      )}

      {movePending && moveBatch && (
        <MoveProgress
          batch={moveBatch}
          onCheck={() => checkUnconfirmed(api, moveKey, notify)}
          onDismiss={() => dismissUnconfirmed(moveKey)}
        />
      )}

      <section
        className={`panel files-panel ${dragging ? "files-dragging" : ""}`}
        aria-label="Server files"
        onDragEnter={(event) => {
          if (
            canCreate &&
            !transferring &&
            !movePending &&
            event.dataTransfer.types.includes("Files")
          ) {
            event.preventDefault();
            dragDepth.current++;
            setDragging(true);
          }
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files"))
            event.preventDefault();
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepth.current--;
          if (dragDepth.current <= 0) {
            dragDepth.current = 0;
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          const transfer = event.dataTransfer;
          uploadFiles(() => collectDroppedUpload(transfer));
        }}
      >
        {dragging && (
          <div className="files-drop-overlay">
            <Upload size={34} />
            <strong>Drop files or folders to upload</strong>
            <span>Upload to /{path || "server"}</span>
          </div>
        )}
        <div className="files-toolbar">
          <nav className="file-breadcrumb" aria-label="File path">
            <HardDrive size={16} />
            <button onClick={() => navigate("")} aria-label="Server root">
              server
            </button>
            {segments.map((segment, index) => (
              <span key={`${segment}-${index}`}>
                <ChevronRight size={13} />
                <button
                  onClick={() =>
                    navigate(segments.slice(0, index + 1).join("/"))
                  }
                  aria-current={
                    index === segments.length - 1 ? "location" : undefined
                  }
                >
                  {segment}
                </button>
              </span>
            ))}
          </nav>
          <div className="storage-actions">
            <button
              className="btn small"
              onClick={pasteSelection}
              disabled={
                !canCreate ||
                !clipboard ||
                clipboard.origin !== window.location.origin ||
                transferring ||
                movePending ||
                loading
              }
              title="Paste copied files into this folder (Ctrl+V)"
            >
              <ClipboardPaste size={15} /> Paste
            </button>
            <button
              className="btn small"
              onClick={() => openCreate("directory")}
              disabled={!canCreate}
            >
              <FolderPlus size={15} />
              New folder
            </button>
            <button
              className="btn small"
              disabled={!canCreate}
              onClick={() => openCreate("file")}
            >
              <FilePlus2 size={15} />
              New file
            </button>
            <RefreshButton
              label="Refresh files"
              disabled={saving || uploading}
              onRefresh={load}
              notify={notify}
              successMessage="Files refreshed."
            />
          </div>
        </div>
        <div className="files-filter">
          <SearchField
            className="storage-search"
            ref={searchInput}
            placeholder="Search files and folders…"
            aria-label="Search files and folders"
            value={query}
            onValueChange={setQuery}
          />
          <div className="file-selection-slot">
            {!selectedEntries.length && (
              <span className="muted files-count">{entries.length} items</span>
            )}
            <div
              className="file-selection-bar"
              role="region"
              aria-label="Selected files and folders"
              style={{
                visibility: selectedEntries.length ? "visible" : "hidden",
              }}
            >
              <div className="file-selection-summary" aria-live="polite">
                <strong>{selectedEntries.length} selected</strong>
                <span>
                  {hiddenSelectedCount > 0
                    ? `${hiddenSelectedCount} outside this page or filter`
                    : "\u00a0"}
                </span>
              </div>
              <div className="file-selection-actions">
                <button
                  className="btn small"
                  onClick={copySelection}
                  disabled={!canContent || loading || saving}
                  title="Copy selected files and folders (Ctrl+C)"
                >
                  <Copy size={15} /> Copy
                </button>
                <button
                  className="btn small"
                  onClick={() => setSelected(new Set())}
                  disabled={saving}
                >
                  Clear selection
                </button>
                <button
                  className="btn danger small"
                  onClick={openDeleteSelected}
                  disabled={
                    !canDelete ||
                    saving ||
                    movePending ||
                    checkingMove ||
                    loading ||
                    !!error
                  }
                >
                  <Trash2 size={15} /> Delete selected
                </button>
              </div>
            </div>
          </div>
        </div>
        {error && (
          <StatePanel
            variant="error"
            title="Unable to load files"
            message={error}
            onRetry={() => void load()}
          />
        )}
        {loading && !loaded.current ? (
          <StatePanel variant="loading" title="Loading your files…" />
        ) : (
          <div className="table-wrap">
            <table className="data-table file-table">
              {visible.length > 0 && (
                <thead>
                  <tr>
                    <th scope="col">
                      <div className="file-selection-name">
                        <input
                          className="file-selection-checkbox"
                          type="checkbox"
                          aria-label="Select all visible files and folders"
                          checked={allVisibleSelected}
                          aria-checked={
                            visibleSelectedCount > 0 && !allVisibleSelected
                              ? "mixed"
                              : allVisibleSelected
                          }
                          ref={(input) => {
                            if (input)
                              input.indeterminate =
                                visibleSelectedCount > 0 && !allVisibleSelected;
                          }}
                          disabled={
                            (!canDelete && !canContent) ||
                            !visible.length ||
                            saving
                          }
                          onChange={toggleVisibleSelection}
                        />
                        <span>Name</span>
                      </div>
                    </th>
                    <th scope="col">Size</th>
                    <th scope="col">Last modified</th>
                    <th scope="col">
                      <span className="storage-sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
              )}
              <tbody>
                {!path && canBin && (
                  <tr
                    className="recycle-bin-entry"
                    aria-label="Protected Recycle Bin"
                  >
                    <td colSpan={4}>
                      <div className="recycle-bin-entry-content">
                        <LockKeyhole size={16} aria-label="Protected folder" />
                        <button
                          className="file-name"
                          aria-label="Open Recycle Bin"
                          onClick={() => {
                            setSelected(new Set());
                            setShowingBin(true);
                          }}
                        >
                          <Trash2 size={19} />
                          <span>Recycle Bin</span>
                          <ChevronRight size={13} />
                        </button>
                        <span className="recycle-bin-entry-note">
                          Protected · Restore deleted items
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
                {path && !query && (
                  <tr className="parent-directory">
                    <td colSpan={4}>
                      <button
                        className="file-name"
                        onClick={() =>
                          navigate(segments.slice(0, -1).join("/"))
                        }
                      >
                        <Folder size={19} />
                        <span>..</span>
                        <span className="muted">Parent directory</span>
                      </button>
                    </td>
                  </tr>
                )}
                {visible.map((entry) => (
                  <tr
                    key={entry.path}
                    className={
                      selected.has(entry.path) ? "file-row-selected" : undefined
                    }
                  >
                    <td>
                      <div className="file-selection-name">
                        <input
                          className="file-selection-checkbox"
                          type="checkbox"
                          aria-label={`Select ${entry.name}`}
                          checked={selected.has(entry.path)}
                          disabled={(!canDelete && !canContent) || saving}
                          onChange={() => toggleSelection(entry.path)}
                        />
                        <button
                          className={`file-name ${entry.type === "directory" ? "directory" : ""}`}
                          onClick={() => void openEntry(entry)}
                          disabled={entry.type === "file" && !canContent}
                          title={entry.name}
                        >
                          <EntryIcon entry={entry} />
                          <span>{entry.name}</span>
                          {entry.type === "directory" && (
                            <ChevronRight
                              size={13}
                              className="file-open-chevron"
                            />
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="muted">
                      {entry.type === "directory"
                        ? "—"
                        : formatBytes(entry.size)}
                    </td>
                    <td
                      className="muted"
                      title={new Date(entry.modified).toLocaleString()}
                    >
                      {relativeTime(entry.modified)}
                    </td>
                    <td>
                      <div className="file-row-actions">
                        {entry.type === "file" && canContent && (
                          <>
                            {editable(entry.name) && (
                              <button
                                className="btn icon"
                                aria-label={`${canUpdate ? "Edit" : "View"} ${entry.name}`}
                                title={canUpdate ? "Edit file" : "View file"}
                                onClick={() => void openEntry(entry)}
                              >
                                <Pencil size={14} />
                              </button>
                            )}
                            <a
                              className="btn icon"
                              aria-label={`Download ${entry.name}`}
                              title="Download file"
                              href={downloadUrl(
                                `/files/download?path=${encodeURIComponent(entry.path)}`,
                              )}
                              download
                            >
                              <Download size={15} />
                            </a>
                          </>
                        )}
                        <button
                          className="btn icon delete-action"
                          aria-label={`Delete ${entry.name}`}
                          title="Move to Recycle Bin"
                          disabled={!canDelete || movePending || checkingMove}
                          onClick={() => openDelete(entry)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!visible.length && (
              <StatePanel
                variant="empty"
                icon={<Folder size={30} />}
                title={query ? "No matching files" : "A fresh start"}
                message={
                  query
                    ? "Try a different file or folder name."
                    : canCreate
                      ? "Upload your server files or create a new folder."
                      : "There are no files in this folder."
                }
                action={
                  !query &&
                  canCreate && (
                    <button
                      className="btn"
                      onClick={() => uploadInput.current?.click()}
                      disabled={uploading}
                    >
                      <Upload size={15} />
                      Upload files
                    </button>
                  )
                }
              />
            )}
          </div>
        )}
        {filtered.length > 0 && (
          <Pagination
            page={currentPage}
            pageSize={pageSize}
            total={filtered.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            label="files"
            disabled={saving}
          />
        )}
        <div className="files-footer">
          <span>
            <span className="storage-status-dot" />
            {formatBytes(totalSize)} in this directory
          </span>
          {canCreate && <span>Drag and drop files here to upload</span>}
        </div>
      </section>
      <div className="storage-hint">
        <HardDrive size={16} />
        <p>
          File changes apply immediately. Deleted files can be restored from
          Recycle Bin while the server is running.
        </p>
      </div>

      {dialog && (
        <dialog
          ref={dialogRef}
          className={`modal storage-modal storage-native-dialog ${dialog.type === "edit" ? "editor-modal" : ""}`}
          aria-labelledby="file-dialog-title"
          aria-describedby="file-dialog-description"
          onCancel={(event) => {
            event.preventDefault();
            if (!savingRef.current) closeDialog();
          }}
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget || savingRef.current)
              return;
            const bounds = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < bounds.left ||
              event.clientX > bounds.right ||
              event.clientY < bounds.top ||
              event.clientY > bounds.bottom
            )
              closeDialog();
          }}
        >
          <form onSubmit={submitDialog}>
            <div className="storage-modal-heading">
              <div>
                <h2 id="file-dialog-title">
                  {dialog.type === "create"
                    ? `New ${dialog.kind === "directory" ? "folder" : "file"}`
                    : dialog.type === "edit"
                      ? dialog.entry.name
                      : dialog.type === "delete-many"
                        ? "Move selected items to Recycle Bin?"
                        : "Move this item to Recycle Bin?"}
                </h2>
                <p id="file-dialog-description">
                  {dialog.type === "create"
                    ? `Create in /${path || "server"}`
                    : dialog.type === "edit"
                      ? `/${dialog.entry.path}`
                      : "You can restore these items from Recycle Bin."}
                </p>
              </div>
              <button
                type="button"
                className="btn icon"
                aria-label="Close dialog"
                disabled={saving}
                onClick={closeDialog}
              >
                <X size={18} />
              </button>
            </div>
            {dialog.type === "create" && (
              <label className="form-field">
                {dialog.kind === "directory" ? "Folder name" : "File name"}
                <input
                  required
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={
                    dialog.kind === "directory"
                      ? "my-plugins"
                      : "server.properties"
                  }
                  maxLength={180}
                  disabled={saving}
                />
              </label>
            )}
            {(dialog.type === "edit" ||
              (dialog.type === "create" && dialog.kind === "file")) && (
              <label className="form-field">
                {dialog.type === "edit"
                  ? "File contents"
                  : "Contents (optional)"}
                {reading ? (
                  <div className="editor-loading">
                    <LoaderCircle size={18} className="spin" />
                    Reading file…
                  </div>
                ) : (
                  <textarea
                    className="file-editor"
                    readOnly={dialog.type === "edit" && !canUpdate}
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    spellCheck={false}
                    disabled={saving}
                    rows={dialog.type === "edit" ? 18 : 6}
                  />
                )}
              </label>
            )}
            {dialog.type === "delete" && (
              <p className="delete-description">
                Move <strong>{dialog.entry.name}</strong>
                {dialog.entry.type === "directory"
                  ? " and everything inside it"
                  : ""}{" "}
                to Recycle Bin? It will be removed from your server files until
                restored.
              </p>
            )}
            {dialog.type === "delete-many" && (
              <div className="file-bulk-confirmation">
                <p>
                  Move these {dialog.entries.length}{" "}
                  {dialog.entries.length === 1 ? "item" : "items"} to Recycle
                  Bin?
                </p>
                {dialog.entries.some((entry) => entry.type === "directory") && (
                  <p className="file-bulk-folder-warning">
                    Selected folders and everything inside them will be moved
                    together, including nested files and folders.
                  </p>
                )}
                <ul className="file-bulk-targets" aria-label="Items to recycle">
                  {dialog.entries.map((entry) => (
                    <li key={entry.path}>
                      <EntryIcon entry={entry} />
                      <div>
                        <strong>{entry.name}</strong>
                        <span>/{entry.path}</span>
                        {entry.type === "directory" && (
                          <small>Folder · includes all contents</small>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                {!!dialog.failures?.length && (
                  <ul className="file-bulk-errors" aria-label="Move errors">
                    {dialog.failures.map(({ entry, message }) => (
                      <li key={entry.path}>
                        <strong>{entry.name}:</strong> {message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {dialogError && (
              <p className="storage-form-error" role="alert">
                {dialogError}
              </p>
            )}
            {moving && moveBatch && dialogMoveId === moveBatch.id && (
              <div className="recycle-bin-notice" role="status">
                <LoaderCircle size={18} className="spin" />
                <div>
                  <p>{moveDescription(moveBatch)}</p>
                  <p>
                    You can close this dialog while the move continues. Closing
                    does not cancel it.
                  </p>
                </div>
              </div>
            )}
            <div className="storage-modal-footer">
              <button
                type="button"
                className="btn"
                disabled={saving}
                onClick={closeDialog}
              >
                {movePending && dialogMoveId === moveBatch?.id
                  ? "Close"
                  : "Cancel"}
              </button>
              <button
                className={`btn ${dialog.type === "delete" || dialog.type === "delete-many" ? "danger" : "primary"}`}
                disabled={
                  !canSubmitDialog ||
                  saving ||
                  ((dialog.type === "delete" ||
                    dialog.type === "delete-many") &&
                    (movePending || checkingMove)) ||
                  (dialog.type === "edit" && (reading || readFailed)) ||
                  (dialog.type === "create" && !name.trim())
                }
              >
                {saving && <LoaderCircle size={15} className="spin" />}
                {dialog.type === "delete-many"
                  ? moving && dialogMoveId === moveBatch?.id
                    ? `Moving ${moveBatch.completed.length + moveBatch.failures.length} of ${dialog.entries.length}…`
                    : dialog.failures?.length
                      ? "Retry failed moves"
                      : "Move to Recycle Bin"
                  : dialog.type === "delete"
                    ? moving && dialogMoveId === moveBatch?.id
                      ? "Moving to Recycle Bin…"
                      : "Move to Recycle Bin"
                    : dialog.type === "edit"
                      ? "Save changes"
                      : `Create ${dialog.kind === "directory" ? "folder" : "file"}`}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}

function RecycleBin({
  notify,
  onBack,
  permissions,
}: PageProps & { onBack: () => void; permissions?: string[] }) {
  const canRestore =
    permissions === undefined ||
    (permissions.includes("file.create") &&
      permissions.includes("backup.create"));
  const canDelete =
    permissions === undefined ||
    (permissions.includes("file.delete") &&
      permissions.includes("backup.delete"));
  const { api, post } = useServerApi();
  const [items, setItems] = useState<RecycledItem[]>([]);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query);
  const loaded = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [restoring, setRestoring] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<{
    type: "restore" | "delete";
    targets: RecycledItem[];
    failures?: { item: RecycledItem; message: string }[];
  } | null>(null);
  const [actionError, setActionError] = useState("");
  const [restoreWarnings, setRestoreWarnings] = useState<string[]>([]);
  const [checkingRestore, setCheckingRestore] = useState(false);
  const restoreReview = useRef(0);
  const [completed, setCompleted] = useState(0);
  const actionDialog = useRef<HTMLDialogElement>(null);
  const cancelAction = useRef<HTMLButtonElement>(null);
  const [restoreErrors, setRestoreErrors] = useState<Record<string, string>>(
    {},
  );
  const requestId = useRef(0);
  const restorePending = useRef(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError("");
    try {
      const result = await api<{ items: RecycledItem[]; protected: true }>(
        "/files/recycle-bin",
      );
      if (id === requestId.current) {
        loaded.current = true;
        setItems(result.items);
        const available = new Set(result.items.map((item) => item.id));
        setSelected(
          (previous) =>
            new Set([...previous].filter((id) => available.has(id))),
        );
        return true;
      }
      return false;
    } catch (failure) {
      if (id === requestId.current) setError(messageOf(failure));
      return false;
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    loaded.current = false;
    setItems([]);
    setQuery("");
    void load();
    return () => {
      requestId.current++;
    };
  }, [load]);
  const actionOpen = !!action;
  useEffect(() => {
    if (actionOpen) {
      actionDialog.current?.showModal();
      cancelAction.current?.focus();
    } else actionDialog.current?.close();
  }, [actionOpen]);

  async function checkRestore(targets: RecycledItem[]) {
    const warnings: string[] = [];
    for (const item of targets.filter(
      (value) =>
        value.kind !== "backup" &&
        /^mods\/[^/]+\.jar$/i.test(value.originalPath),
    )) {
      try {
        const result = await api<{
          duplicates: { path: string; title: string }[];
          warnings: string[];
        }>(`/files/recycle-bin/${encodeURIComponent(item.id)}/restore-preview`);
        warnings.push(
          ...result.duplicates.map(
            (duplicate) =>
              `Restoring ${item.name} would add another copy of ${duplicate.title || "this mod"}. Already installed: ${duplicate.path}. Remove the extra copy before starting the server.`,
          ),
          ...result.warnings,
        );
      } catch (cause) {
        warnings.push(
          `Could not check ${item.name} for duplicate mods: ${messageOf(cause)}`,
        );
      }
    }
    return [...new Set(warnings)];
  }
  async function restore(item: RecycledItem) {
    if (!canRestore || restorePending.current || item.status !== "ready")
      return;
    restorePending.current = true;
    setRestoring(item.id);
    setRestoreErrors((previous) => ({ ...previous, [item.id]: "" }));
    try {
      const warnings = await checkRestore([item]);
      if (warnings.length) {
        setRestoreWarnings(warnings);
        setActionError("");
        setAction({ type: "restore", targets: [item] });
        return;
      }
      await post(
        `/files/recycle-bin/${encodeURIComponent(item.id)}/restore`,
        {},
      );
      setItems((previous) => previous.filter((entry) => entry.id !== item.id));
      setSelected(
        (previous) => new Set([...previous].filter((id) => id !== item.id)),
      );
      notify(
        item.kind === "backup"
          ? `${item.name} restored to Backups.`
          : `${item.name} restored to /${item.originalPath}.`,
      );
      searchInput.current?.focus();
    } catch (failure) {
      setRestoreErrors((previous) => ({
        ...previous,
        [item.id]: messageOf(failure),
      }));
    } finally {
      restorePending.current = false;
      setRestoring(null);
    }
  }

  async function openAction(
    type: "restore" | "delete",
    targets: RecycledItem[],
  ) {
    if (
      (type === "restore" ? !canRestore : !canDelete) ||
      !targets.length ||
      restorePending.current
    )
      return;
    setActionError("");
    setCompleted(0);
    setRestoreWarnings([]);
    setAction({ type, targets: [...targets] });
    const token = ++restoreReview.current;
    if (type === "restore") {
      setCheckingRestore(true);
      const warnings = await checkRestore(targets);
      if (token === restoreReview.current) {
        setRestoreWarnings(warnings);
        setCheckingRestore(false);
      }
    }
  }
  function closeAction() {
    if (restorePending.current) return;
    restoreReview.current++;
    setCheckingRestore(false);
    setRestoreWarnings([]);
    setAction(null);
    setActionError("");
    searchInput.current?.focus();
  }
  async function submitAction(event: FormEvent) {
    event.preventDefault();
    if (
      !action ||
      (action.type === "restore" ? !canRestore : !canDelete) ||
      restorePending.current ||
      checkingRestore
    )
      return;
    restorePending.current = true;
    const successes = new Set<string>();
    const failures: { item: RecycledItem; message: string }[] = [];
    setActionError("");
    setCompleted(0);
    try {
      for (const item of action.targets) {
        setRestoring(item.id);
        try {
          const url = `/files/recycle-bin/${encodeURIComponent(item.id)}`;
          if (action.type === "restore") await post(`${url}/restore`, {});
          else await api(url, { method: "DELETE" });
          successes.add(item.id);
        } catch (cause) {
          failures.push({ item, message: messageOf(cause) });
        }
        setCompleted(successes.size + failures.length);
      }
      setItems((previous) =>
        previous.filter((item) => !successes.has(item.id)),
      );
      setSelected((previous) => {
        const remaining = new Set(
          [...previous].filter((id) => !successes.has(id)),
        );
        failures.forEach(({ item }) => remaining.add(item.id));
        return remaining;
      });
      const restoredBackups =
        action.type === "restore" &&
        action.targets.some(
          (item) => item.kind === "backup" && successes.has(item.id),
        );
      const summary = `${successes.size} ${successes.size === 1 ? "item" : "items"} ${action.type === "restore" ? "restored" : "permanently deleted"}.${restoredBackups ? " Restored archives are available in Backups." : ""}${failures.length ? ` ${failures.length} ${failures.length === 1 ? "item failed and remains" : "items failed and remain"} selected.` : ""}`;
      notify(summary, failures.length > 0);
      if (failures.length) {
        setAction({
          ...action,
          targets: failures.map(({ item }) => item),
          failures,
        });
        setActionError(summary);
      } else {
        setAction(null);
        searchInput.current?.focus();
      }
      await load();
    } finally {
      restorePending.current = false;
      setRestoring(null);
    }
  }

  const visible = items.filter((item) =>
    `${item.name} ${item.originalPath} ${item.kind === "backup" ? "backup archive" : ""}`
      .toLowerCase()
      .includes(debouncedQuery.toLowerCase()),
  );
  const selectedItems = items.filter((item) => selected.has(item.id));
  const visibleSelected = visible.filter((item) =>
    selected.has(item.id),
  ).length;
  const allSelected = visible.length > 0 && visibleSelected === visible.length;
  const hiddenSelected = selectedItems.length - visibleSelected;
  function toggleVisible() {
    setSelected((previous) => {
      const next = new Set(previous);
      visible.forEach((item) =>
        allSelected ? next.delete(item.id) : next.add(item.id),
      );
      return next;
    });
  }
  return (
    <div className="storage-page recycle-bin-page">
      <div className="page-heading">
        <div>
          <h1>Recycle Bin</h1>
          <p>
            Restore deleted files and backup archives, or permanently remove
            recovery data.
          </p>
        </div>
        <button className="btn" onClick={onBack}>
          <Folder size={16} /> Back to files
        </button>
      </div>
      <section
        className="panel files-panel"
        aria-label="Recycled server files and backups"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => event.preventDefault()}
      >
        <div className="files-toolbar">
          <nav className="file-breadcrumb" aria-label="File path">
            <HardDrive size={16} />
            <button onClick={onBack} aria-label="Server root">
              server
            </button>
            <span>
              <ChevronRight size={13} />
              <span aria-current="location">Recycle Bin</span>
            </span>
          </nav>
          <div className="recycle-bin-tools">
            <span className="recycle-bin-protected">
              <LockKeyhole size={13} /> Protected
            </span>
            <RefreshButton
              label="Refresh Recycle Bin"
              disabled={!!restoring}
              onRefresh={load}
              notify={notify}
              successMessage="Recycle Bin refreshed."
            />
          </div>
        </div>
        <div className="recycle-bin-notice">
          <LockKeyhole size={18} />
          <p>
            Recycle Bin is protected and stored outside your server files.
            Restore returns files and folders to their original paths and backup
            archives to Backups. Restoring an archive does not change your
            server files. Existing files are never overwritten. Incomplete items
            can be permanently deleted, but cannot be restored.
          </p>
        </div>
        <div className="files-filter">
          <SearchField
            className="storage-search"
            ref={searchInput}
            aria-label="Search recycled items"
            placeholder="Search recycled items…"
            value={query}
            onValueChange={setQuery}
          />
          <span className="muted files-count">
            {items.length} {items.length === 1 ? "item" : "items"}
          </span>
        </div>
        <div
          className="recycle-selection-bar"
          role="region"
          aria-label="Recycle Bin selection"
        >
          <div className="recycle-selection-summary">
            <label className="recycle-select-all">
              <input
                className="file-selection-checkbox"
                type="checkbox"
                aria-label="Select all visible recycled items"
                checked={allSelected}
                aria-checked={
                  visibleSelected > 0 && !allSelected ? "mixed" : allSelected
                }
                ref={(input) => {
                  if (input)
                    input.indeterminate = visibleSelected > 0 && !allSelected;
                }}
                onChange={toggleVisible}
                disabled={!visible.length || !!restoring || loading || !!error}
              />
              <span>{selectedItems.length} selected</span>
            </label>
            <span className="muted">
              {hiddenSelected > 0
                ? `${hiddenSelected} hidden by the filter`
                : "\u00a0"}
            </span>
          </div>
          <div className="recycle-selection-actions">
            <button
              className="btn small"
              disabled={!selectedItems.length || !!restoring}
              onClick={() => setSelected(new Set())}
            >
              Clear selection
            </button>
            <button
              className="btn small"
              disabled={
                !canRestore ||
                !selectedItems.length ||
                !!restoring ||
                loading ||
                !!error ||
                selectedItems.some((item) => item.status !== "ready")
              }
              title={
                selectedItems.some((item) => item.status !== "ready")
                  ? "Incomplete items cannot be restored. Deselect them to restore other items."
                  : "Restore files to their original paths and archives to Backups"
              }
              onClick={() => openAction("restore", selectedItems)}
            >
              <Undo2 size={15} /> Restore selected
            </button>
            <button
              className="btn danger small"
              disabled={
                !canDelete ||
                !selectedItems.length ||
                !!restoring ||
                loading ||
                !!error
              }
              onClick={() => openAction("delete", selectedItems)}
            >
              <Trash2 size={15} /> Delete selected permanently
            </button>
          </div>
        </div>
        {error && (
          <StatePanel
            variant="error"
            title="Unable to load Recycle Bin"
            message={error}
            onRetry={() => void load()}
          />
        )}
        {loading && !loaded.current ? (
          <StatePanel variant="loading" title="Loading recycled items…" />
        ) : !visible.length ? (
          <StatePanel
            variant="empty"
            icon={<Trash2 size={30} />}
            title={
              query ? "No matching recycled items" : "Recycle Bin is empty"
            }
            message={
              query
                ? "Try a different name or original path."
                : "Deleted files, folders, and backup archives appear here so you can restore them."
            }
          />
        ) : (
          <ul className="recycle-bin-items" aria-label="Recycled items">
            {visible.map((item) => (
              <li
                key={item.id}
                className="recycle-bin-item"
                aria-label={
                  item.kind === "backup"
                    ? `Recycled backup ${item.name}`
                    : `Recycled ${item.originalPath}`
                }
              >
                <input
                  className="file-selection-checkbox recycle-item-checkbox"
                  type="checkbox"
                  aria-label={`Select recycled ${item.name}`}
                  checked={selected.has(item.id)}
                  disabled={!!restoring}
                  onChange={() =>
                    setSelected((previous) => {
                      const next = new Set(previous);
                      if (next.has(item.id)) next.delete(item.id);
                      else next.add(item.id);
                      return next;
                    })
                  }
                />
                <div className="recycle-bin-item-icon">
                  {item.kind === "backup" ? (
                    <FileArchive size={22} />
                  ) : item.type === "directory" ? (
                    <Folder size={22} />
                  ) : (
                    <FileIcon size={22} />
                  )}
                </div>
                <div className="recycle-bin-item-details">
                  <h2>{item.name}</h2>
                  <p className="recycle-bin-original-path">
                    <span>
                      {item.kind === "backup" ? "Restore to" : "Original path"}
                    </span>{" "}
                    {item.kind === "backup"
                      ? "Backups"
                      : item.originalPath
                        ? `/${item.originalPath}`
                        : "Unavailable"}
                  </p>
                  <p className="recycle-bin-item-meta">
                    <span>
                      {item.kind === "backup"
                        ? "Backup archive"
                        : item.type === "directory"
                          ? "Folder · includes all contents"
                          : "File"}
                    </span>
                    <span>{formatBytes(item.size)}</span>
                    <time
                      dateTime={item.deletedAt}
                      title={new Date(item.deletedAt).toLocaleString()}
                    >
                      Deleted {relativeTime(item.deletedAt)}
                    </time>
                  </p>
                  {item.status !== "ready" && (
                    <p className="recycle-bin-incomplete">
                      {item.message ||
                        "This item is incomplete and cannot be restored yet. Its retained data is protected."}
                    </p>
                  )}
                  {restoreErrors[item.id] && (
                    <p className="storage-form-error" role="alert">
                      {restoreErrors[item.id]}
                    </p>
                  )}
                </div>
                <div className="recycle-item-actions">
                  <button
                    className="btn small"
                    aria-label={`Restore ${item.name}`}
                    disabled={
                      !canRestore || !!restoring || item.status !== "ready"
                    }
                    onClick={() => void restore(item)}
                  >
                    {restoring === item.id ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <Undo2 size={15} />
                    )}
                    {restoring === item.id ? "Restoring…" : "Restore"}
                  </button>
                  <button
                    className="btn danger small"
                    aria-label={`Permanently delete ${item.name}`}
                    disabled={!canDelete || !!restoring}
                    onClick={() => openAction("delete", [item])}
                  >
                    <Trash2 size={15} /> Delete permanently
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="files-footer">
          <span>
            <LockKeyhole size={12} /> Permanent deletion cannot be undone
          </span>
        </div>
      </section>
      <dialog
        ref={actionDialog}
        className="modal storage-modal recycle-action-dialog"
        aria-labelledby="recycle-action-title"
        onCancel={(event) => {
          event.preventDefault();
          closeAction();
        }}
      >
        {action && (
          <form onSubmit={submitAction}>
            <div className="storage-modal-heading">
              <div>
                <h2 id="recycle-action-title">
                  {action.type === "delete"
                    ? "Permanently delete from Recycle Bin?"
                    : "Restore selected items?"}
                </h2>
                <p>
                  {action.type === "delete"
                    ? "This permanently removes the recovery data listed below. It cannot be undone."
                    : action.targets.some((item) => item.kind === "backup")
                      ? "Restore backup archives to Backups and files to their original server paths. Restoring archives does not change your server files. Existing files will not be overwritten."
                      : "Restore these items to their original server paths. Existing files will not be overwritten."}
                </p>
              </div>
              <button
                type="button"
                className="btn icon"
                aria-label="Close recovery confirmation"
                disabled={!!restoring}
                onClick={closeAction}
              >
                <X size={18} />
              </button>
            </div>
            <ul
              className="file-bulk-targets"
              aria-label="Confirmed recovery items"
            >
              {action.targets.map((item) => (
                <li key={item.id}>
                  {item.kind === "backup" ? (
                    <FileArchive size={18} />
                  ) : item.type === "directory" ? (
                    <Folder size={18} />
                  ) : (
                    <FileIcon size={18} />
                  )}
                  <div>
                    <strong>{item.name}</strong>
                    <span>
                      {item.kind === "backup"
                        ? "Backups"
                        : item.originalPath
                          ? `/${item.originalPath}`
                          : "Original path unavailable"}
                    </span>
                    <small>
                      {item.kind === "backup"
                        ? "Backup archive"
                        : item.type === "directory"
                          ? "Folder · all remaining contents"
                          : "File"}{" "}
                      · {formatBytes(item.size)}
                    </small>
                    <small>
                      Deleted {new Date(item.deletedAt).toLocaleString()}
                      {!item.originalPath && ` · Recovery item ${item.id}`}
                    </small>
                    {item.status !== "ready" && (
                      <small>Incomplete recovery item</small>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {checkingRestore && (
              <StatePanel variant="loading" title="Checking restored mods…" />
            )}
            {!!restoreWarnings.length && (
              <div className="management-notice warning" role="status">
                <div>
                  <strong>Review duplicate mods before restoring</strong>
                  {restoreWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              </div>
            )}
            {actionError && (
              <p className="storage-form-error" role="alert">
                {actionError}
              </p>
            )}
            {!!action.failures?.length && (
              <ul
                className="file-bulk-errors"
                aria-label="Recovery action errors"
              >
                {action.failures.map(({ item, message }) => (
                  <li key={item.id}>
                    <strong>{item.name}:</strong> {message}
                  </li>
                ))}
              </ul>
            )}
            <div className="storage-modal-footer">
              <button
                ref={cancelAction}
                className="btn"
                type="button"
                disabled={!!restoring}
                onClick={closeAction}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={`btn ${action.type === "delete" ? "danger" : "primary"}`}
                disabled={
                  !!restoring ||
                  checkingRestore ||
                  (action.type === "restore" ? !canRestore : !canDelete)
                }
              >
                {restoring
                  ? `${action.type === "delete" ? "Deleting" : "Restoring"} ${completed} of ${action.targets.length}…`
                  : action.failures?.length
                    ? "Retry failed items"
                    : action.type === "delete"
                      ? "Delete permanently"
                      : "Restore selected items"}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}
