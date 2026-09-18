import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ChevronRight,
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
  type PageProps,
} from "../api";
import "./storage.css";
import SearchField, { useDebouncedValue } from "../SearchField";
import RefreshButton from "../RefreshButton";
import StatePanel from "../StatePanel";
import Pagination from "../Pagination";
import "./file-selection.css";
import "./recycle-bin.css";

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
const messageOf = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
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

export default function FileManager({ notify }: PageProps) {
  const { api, post, downloadUrl } = useServerApi();
  const [path, setPath] = useState("");
  const [showingBin, setShowingBin] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query);
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25);
  const loaded = useRef(false);
  useEffect(() => setPage(1), [debouncedQuery, pageSize, path]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<FileDialog | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteProgress, setDeleteProgress] = useState<number | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);
  const editRequestId = useRef(0);
  const savingRef = useRef(false);
  const pathRef = useRef(path);
  savingRef.current = saving;
  pathRef.current = path;

  const load = useCallback(async () => {
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
  }, [path, api]);

  useEffect(() => {
    loaded.current = false;
    setEntries([]);
    setQuery("");
    setPage(1);
  }, [api, path]);
  useEffect(() => {
    if (!showingBin) void load();
    return () => {
      requestId.current++;
    };
  }, [load, showingBin]);
  useEffect(() => {
    setSelected(new Set());
  }, [path, api, showingBin]);
  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]",
        ) || [],
      );
    focusable()
      .find(
        (element) =>
          element.tagName === "INPUT" || element.tagName === "TEXTAREA",
      )
      ?.focus();
    if (!dialogRef.current?.contains(document.activeElement))
      focusable()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !savingRef.current) {
        event.preventDefault();
        closeDialog();
      }
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items[items.length - 1];
        if (!items.length) {
          event.preventDefault();
          dialogRef.current?.focus();
        } else if (!dialogRef.current?.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
      else searchInput.current?.focus();
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
  }
  function openDelete(entry: Entry) {
    editRequestId.current++;
    setReading(false);
    setDialogError("");
    setDialog({ type: "delete", entry });
  }
  function openDeleteSelected() {
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
    editRequestId.current++;
    setReading(false);
    setReadFailed(false);
    setName("");
    setContent("");
    setDialogError("");
    setDialog({ type: "create", kind });
  }

  async function openEntry(entry: Entry) {
    if (entry.type === "directory") {
      navigate(entry.path);
      return;
    }
    if (!editable(entry.name)) {
      notify("Use the download button to open this file on your computer.");
      return;
    }
    const id = ++editRequestId.current;
    setContent("");
    setDialogError("");
    setReadFailed(false);
    setReading(true);
    setDialog({ type: "edit", entry });
    try {
      const result = await api<{ content: string }>(
        `/files/content?path=${encodeURIComponent(entry.path)}`,
      );
      if (id === editRequestId.current) setContent(result.content);
    } catch (failure) {
      if (id === editRequestId.current) {
        setDialogError(messageOf(failure));
        setReadFailed(true);
      }
    } finally {
      if (id === editRequestId.current) setReading(false);
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    if (!files.length || uploading) return;
    const uploadPath = path;
    setUploading(true);
    const form = new FormData();
    Array.from(files).forEach((file) => form.append("files", file));
    try {
      await api(`/files/upload?path=${encodeURIComponent(path)}`, {
        method: "POST",
        body: form,
      });
      notify(
        `${files.length} ${files.length === 1 ? "file uploaded" : "files uploaded"}.`,
      );
      if (pathRef.current === uploadPath) await load();
    } catch (failure) {
      notify(messageOf(failure), true);
      if (pathRef.current === uploadPath) await load();
    } finally {
      setUploading(false);
      if (uploadInput.current) uploadInput.current.value = "";
    }
  }

  async function submitDialog(event: FormEvent) {
    event.preventDefault();
    if (!dialog || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setDialogError("");
    try {
      if (dialog.type === "delete-many") {
        const deleted = new Set<string>();
        const failures: { entry: Entry; message: string }[] = [];
        setDeleteProgress(0);
        // Freeze the confirmed targets and this server's API binding for the
        // whole operation. Each deletion finishes before the next one starts.
        for (const entry of dialog.entries) {
          try {
            await api(`/files?path=${encodeURIComponent(entry.path)}`, {
              method: "DELETE",
            });
            deleted.add(entry.path);
          } catch (failure) {
            failures.push({ entry, message: messageOf(failure) });
          }
          setDeleteProgress(deleted.size + failures.length);
        }
        setSelected((previous) => {
          const remaining = new Set(
            [...previous].filter((item) => !deleted.has(item)),
          );
          failures.forEach(({ entry }) => remaining.add(entry.path));
          return remaining;
        });
        setEntries((previous) =>
          previous.filter((entry) => !deleted.has(entry.path)),
        );
        const summary = `${deleted.size} ${deleted.size === 1 ? "item" : "items"} moved to Recycle Bin.${failures.length ? ` ${failures.length} ${failures.length === 1 ? "item could not be moved and remains" : "items could not be moved and remain"} selected.` : ""}`;
        notify(summary, failures.length > 0);
        if (failures.length) {
          setDialog({
            type: "delete-many",
            entries: failures.map(({ entry }) => entry),
            failures,
          });
          setDialogError(summary);
        } else closeDialog();
        await load();
        return;
      } else if (dialog.type === "create") {
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
          body: JSON.stringify({ path: dialog.entry.path, content }),
        });
        notify(`${dialog.entry.name} saved.`);
      } else {
        await api(`/files?path=${encodeURIComponent(dialog.entry.path)}`, {
          method: "DELETE",
        });
        notify(`${dialog.entry.name} moved to Recycle Bin.`);
      }
      closeDialog();
      await load();
    } catch (failure) {
      setDialogError(messageOf(failure));
    } finally {
      savingRef.current = false;
      setSaving(false);
      setDeleteProgress(null);
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
  if (showingBin)
    return (
      <RecycleBin
        notify={notify}
        onBack={() => {
          setQuery("");
          setShowingBin(false);
        }}
      />
    );
  return (
    <div className="storage-page">
      <div className="page-heading">
        <div>
          <h1>File Manager</h1>
        </div>
        <button
          className="btn primary"
          onClick={() => uploadInput.current?.click()}
          disabled={uploading || loading}
        >
          {uploading ? (
            <LoaderCircle size={16} className="spin" />
          ) : (
            <Upload size={16} />
          )}
          {uploading ? "Uploading…" : "Upload files"}
        </button>
        <input
          ref={uploadInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) void uploadFiles(event.target.files);
          }}
          aria-label="Upload server files"
        />
      </div>

      <section
        className={`panel files-panel ${dragging ? "files-dragging" : ""}`}
        aria-label="Server files"
        onDragEnter={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
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
          void uploadFiles(event.dataTransfer.files);
        }}
      >
        {dragging && (
          <div className="files-drop-overlay">
            <Upload size={34} />
            <strong>Drop files to upload</strong>
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
              onClick={() => openCreate("directory")}
            >
              <FolderPlus size={15} />
              New folder
            </button>
            <button className="btn small" onClick={() => openCreate("file")}>
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
                  onClick={() => setSelected(new Set())}
                  disabled={saving}
                >
                  Clear selection
                </button>
                <button
                  className="btn danger small"
                  onClick={openDeleteSelected}
                  disabled={saving || loading || !!error}
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
                          disabled={!visible.length || saving}
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
                {!path && (
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
                          disabled={saving}
                          onChange={() => toggleSelection(entry.path)}
                        />
                        <button
                          className={`file-name ${entry.type === "directory" ? "directory" : ""}`}
                          onClick={() => void openEntry(entry)}
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
                        {entry.type === "file" && (
                          <>
                            {editable(entry.name) && (
                              <button
                                className="btn icon"
                                aria-label={`Edit ${entry.name}`}
                                title="Edit file"
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
                    : "Upload your server files or create a new folder."
                }
                action={
                  !query && (
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
        <Pagination
          page={currentPage}
          pageSize={pageSize}
          total={filtered.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          label="files"
          disabled={saving}
        />
        <div className="files-footer">
          <span>
            <span className="storage-status-dot" />
            {formatBytes(totalSize)} in this directory
          </span>
          <span>Drag and drop files here to upload</span>
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
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving) closeDialog();
          }}
        >
          <div
            ref={dialogRef}
            className={`modal storage-modal ${dialog.type === "edit" ? "editor-modal" : ""}`}
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby="file-dialog-title"
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
                  <p>
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
                    autoFocus
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
                  to Recycle Bin? It will be removed from your server files
                  until restored.
                </p>
              )}
              {dialog.type === "delete-many" && (
                <div className="file-bulk-confirmation">
                  <p>
                    Move these {dialog.entries.length}{" "}
                    {dialog.entries.length === 1 ? "item" : "items"} to Recycle
                    Bin?
                  </p>
                  {dialog.entries.some(
                    (entry) => entry.type === "directory",
                  ) && (
                    <p className="file-bulk-folder-warning">
                      Selected folders and everything inside them will be moved
                      together, including nested files and folders.
                    </p>
                  )}
                  <ul
                    className="file-bulk-targets"
                    aria-label="Items to recycle"
                  >
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
              <div className="storage-modal-footer">
                <button
                  type="button"
                  className="btn"
                  disabled={saving}
                  onClick={closeDialog}
                >
                  Cancel
                </button>
                <button
                  className={`btn ${dialog.type === "delete" || dialog.type === "delete-many" ? "danger" : "primary"}`}
                  disabled={
                    saving ||
                    (dialog.type === "edit" && (reading || readFailed)) ||
                    (dialog.type === "create" && !name.trim())
                  }
                >
                  {saving && <LoaderCircle size={15} className="spin" />}
                  {dialog.type === "delete-many"
                    ? saving && deleteProgress !== null
                      ? `Moving ${deleteProgress} of ${dialog.entries.length}…`
                      : dialog.failures?.length
                        ? "Retry failed moves"
                        : "Move to Recycle Bin"
                    : dialog.type === "delete"
                      ? "Move to Recycle Bin"
                      : dialog.type === "edit"
                        ? "Save changes"
                        : `Create ${dialog.kind === "directory" ? "folder" : "file"}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function RecycleBin({ notify, onBack }: PageProps & { onBack: () => void }) {
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
    for (const item of targets.filter((value) =>
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
    if (restorePending.current || item.status !== "ready") return;
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
      notify(`${item.name} restored to /${item.originalPath}.`);
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
    if (!targets.length || restorePending.current) return;
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
    if (!action || restorePending.current || checkingRestore) return;
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
      const summary = `${successes.size} ${successes.size === 1 ? "item" : "items"} ${action.type === "restore" ? "restored" : "permanently deleted"}.${failures.length ? ` ${failures.length} ${failures.length === 1 ? "item failed and remains" : "items failed and remain"} selected.` : ""}`;
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
    `${item.name} ${item.originalPath}`
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
          <p>Restore deleted files or permanently remove recovery data.</p>
        </div>
        <button className="btn" onClick={onBack}>
          <Folder size={16} /> Back to files
        </button>
      </div>
      <section
        className="panel files-panel"
        aria-label="Recycled server files"
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
            Restore returns each item to its original path, including all folder
            contents. Existing files are never overwritten. Incomplete items can
            be permanently deleted, but cannot be restored.
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
                !selectedItems.length ||
                !!restoring ||
                loading ||
                !!error ||
                selectedItems.some((item) => item.status !== "ready")
              }
              title={
                selectedItems.some((item) => item.status !== "ready")
                  ? "Incomplete items cannot be restored. Deselect them to restore other items."
                  : "Restore selected items to their original paths"
              }
              onClick={() => openAction("restore", selectedItems)}
            >
              <Undo2 size={15} /> Restore selected
            </button>
            <button
              className="btn danger small"
              disabled={
                !selectedItems.length || !!restoring || loading || !!error
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
                : "Deleted files and folders appear here so you can restore them."
            }
          />
        ) : (
          <ul className="recycle-bin-items" aria-label="Recycled items">
            {visible.map((item) => (
              <li
                key={item.id}
                className="recycle-bin-item"
                aria-label={`Recycled ${item.originalPath}`}
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
                  {item.type === "directory" ? (
                    <Folder size={22} />
                  ) : (
                    <FileIcon size={22} />
                  )}
                </div>
                <div className="recycle-bin-item-details">
                  <h2>{item.name}</h2>
                  <p className="recycle-bin-original-path">
                    <span>Original path</span>{" "}
                    {item.originalPath
                      ? `/${item.originalPath}`
                      : "Unavailable"}
                  </p>
                  <p className="recycle-bin-item-meta">
                    <span>
                      {item.type === "directory"
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
                    disabled={!!restoring || item.status !== "ready"}
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
                    disabled={!!restoring}
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
                  {item.type === "directory" ? (
                    <Folder size={18} />
                  ) : (
                    <FileIcon size={18} />
                  )}
                  <div>
                    <strong>{item.name}</strong>
                    <span>
                      {item.originalPath
                        ? `/${item.originalPath}`
                        : "Original path unavailable"}
                    </span>
                    <small>
                      {item.type === "directory"
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
                disabled={!!restoring || checkingRestore}
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
