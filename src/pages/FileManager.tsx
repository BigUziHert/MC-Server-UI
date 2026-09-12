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
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api, post, formatBytes, relativeTime, type PageProps } from "../api";
import "./storage.css";

type Entry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  modified: string;
};
type FileResult = { path: string; entries: Entry[] };
type FileDialog =
  | { type: "create"; kind: "file" | "directory" }
  | { type: "edit"; entry: Entry }
  | { type: "delete"; entry: Entry };
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
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
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
  const uploadInput = useRef<HTMLInputElement>(null);
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
      if (id === requestId.current) setEntries(result.entries);
    } catch (failure) {
      if (id === requestId.current) setError(messageOf(failure));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
    return () => {
      requestId.current++;
    };
  }, [load]);
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
      previous?.focus();
    };
  }, [dialog]);

  function navigate(next: string) {
    setQuery("");
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
    } finally {
      setUploading(false);
      if (uploadInput.current) uploadInput.current.value = "";
    }
  }

  async function submitDialog(event: FormEvent) {
    event.preventDefault();
    if (!dialog || saving) return;
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
          body: JSON.stringify({ path: dialog.entry.path, content }),
        });
        notify(`${dialog.entry.name} saved.`);
      } else {
        await api(`/files?path=${encodeURIComponent(dialog.entry.path)}`, {
          method: "DELETE",
        });
        notify(`${dialog.entry.name} deleted.`);
      }
      closeDialog();
      await load();
    } catch (failure) {
      setDialogError(messageOf(failure));
    } finally {
      setSaving(false);
    }
  }

  const visible = entries
    .filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "directory"
          ? -1
          : 1,
    );
  const segments = path.split("/").filter(Boolean);
  const totalSize = entries.reduce(
    (sum, entry) => sum + (entry.type === "file" ? entry.size : 0),
    0,
  );
  return (
    <div className="storage-page">
      <div className="page-heading">
        <div>
          <h1>File Manager</h1>
          <p>Your world, plugins, and configuration. All in one place.</p>
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
            <button
              className="btn icon"
              title="Refresh files"
              aria-label="Refresh files"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw size={15} className={loading ? "spin" : ""} />
            </button>
          </div>
        </div>
        <div className="files-filter">
          <label className="storage-search">
            <Search size={16} />
            <input
              placeholder="Search files and folders…"
              aria-label="Search files and folders"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button aria-label="Clear search" onClick={() => setQuery("")}>
                <X size={14} />
              </button>
            )}
          </label>
          <span className="muted files-count">{entries.length} items</span>
        </div>
        {error ? (
          <div className="empty-state">
            <strong>Unable to load files</strong>
            <p>{error}</p>
            <button className="btn" onClick={() => void load()}>
              Try again
            </button>
          </div>
        ) : loading ? (
          <div className="empty-state">
            <LoaderCircle size={24} className="spin" />
            <p>Loading your files…</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table file-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Size</th>
                  <th scope="col">Last modified</th>
                  <th scope="col">
                    <span className="storage-sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
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
                  <tr key={entry.path}>
                    <td>
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
                              href={`/api/files/download?path=${encodeURIComponent(entry.path)}`}
                              download
                            >
                              <Download size={15} />
                            </a>
                          </>
                        )}
                        <button
                          className="btn icon delete-action"
                          aria-label={`Delete ${entry.name}`}
                          title="Delete"
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
              <div className="empty-state">
                <Folder size={30} />
                <strong>{query ? "No matching files" : "A fresh start"}</strong>
                <p>
                  {query
                    ? "Try a different file or folder name."
                    : "Upload your server files or create a new folder."}
                </p>
                {!query && (
                  <button
                    className="btn"
                    onClick={() => uploadInput.current?.click()}
                    disabled={uploading}
                  >
                    <Upload size={15} />
                    Upload files
                  </button>
                )}
              </div>
            )}
          </div>
        )}
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
          Changes are saved directly to your server. Stop the server before
          changing world files.
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
                        : "Delete this item?"}
                  </h2>
                  <p>
                    {dialog.type === "create"
                      ? `Create in /${path || "server"}`
                      : dialog.type === "edit"
                        ? `/${dialog.entry.path}`
                        : "This action cannot be undone."}
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
                  Delete <strong>{dialog.entry.name}</strong>
                  {dialog.entry.type === "directory"
                    ? " and everything inside it"
                    : ""}{" "}
                  from your server?
                </p>
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
                  className={`btn ${dialog.type === "delete" ? "danger" : "primary"}`}
                  disabled={
                    saving ||
                    (dialog.type === "edit" && (reading || readFailed)) ||
                    (dialog.type === "create" && !name.trim())
                  }
                >
                  {saving && <LoaderCircle size={15} className="spin" />}
                  {dialog.type === "delete"
                    ? "Delete permanently"
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
