import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useServerApi, relativeTime, type PageProps } from "../api";
import SearchField from "../SearchField";
import catalog from "../../shared/subuser-permissions.json";
import "./subusers.css";

type Subuser = {
  id: string;
  email: string;
  role?: string;
  permissions?: string[];
  createdAt: string;
};
const permissionIds = catalog.groups.flatMap((group) =>
  group.permissions.map((permission) => permission.id),
);

function permissionsFor(user: Subuser) {
  const defaults =
    catalog.roleDefaults[user.role as keyof typeof catalog.roleDefaults] ?? [];
  const selected = new Set(user.permissions ?? defaults);
  return permissionIds.filter((permission) => selected.has(permission));
}

function PermissionCheckbox({
  label,
  accessibleLabel,
  description,
  checked,
  mixed = false,
  onChange,
}: {
  label: string;
  accessibleLabel?: string;
  description?: string;
  checked: boolean;
  mixed?: boolean;
  onChange: () => void;
}) {
  const checkbox = useRef<HTMLInputElement>(null);
  const descriptionId = useId();
  useEffect(() => {
    if (checkbox.current) checkbox.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <label className={`subuser-permission ${description ? "" : "compact"}`}>
      <input
        ref={checkbox}
        type="checkbox"
        checked={checked}
        aria-checked={mixed ? "mixed" : checked}
        aria-label={accessibleLabel ?? label}
        aria-describedby={description ? descriptionId : undefined}
        onChange={onChange}
      />
      <span>
        <strong>{label}</strong>
        {description && <small id={descriptionId}>{description}</small>}
      </span>
    </label>
  );
}

export default function Subusers({ notify }: PageProps) {
  const { api, post } = useServerApi();
  const [users, setUsers] = useState<Subuser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [editor, setEditor] = useState<"create" | Subuser | null>(null);
  const [email, setEmail] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Subuser | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const editing = editor && editor !== "create" ? editor : null;

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const result = await api<{ users: Subuser[] }>("/subusers", {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setUsers(result.users);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : "Unable to load subusers.",
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);
  useEffect(() => {
    const element = dialog.current;
    if (editor || deleting) {
      element?.showModal();
      if (deleting) cancelButton.current?.focus();
      else if (editor === "create") emailInput.current?.focus();
      else
        element
          ?.querySelector<HTMLInputElement>('input[type="checkbox"]')
          ?.focus();
    } else element?.close();
  }, [editor, deleting]);
  useEffect(() => {
    if (formError) errorMessage.current?.scrollIntoView({ block: "nearest" });
  }, [formError]);

  function closeDialog() {
    if (busy) return;
    setEditor(null);
    setDeleting(null);
    setFormError("");
  }
  function openEditor(user?: Subuser) {
    setEmail(user?.email ?? "");
    setSelected(user ? permissionsFor(user) : []);
    setFormError("");
    setEditor(user ?? "create");
  }
  function togglePermissions(ids: string[]) {
    setSelected((previous) => {
      const next = new Set(previous);
      const allSelected = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return permissionIds.filter((id) => next.has(id));
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormError("");
    try {
      if (deleting) {
        await api(`/subusers/${encodeURIComponent(deleting.id)}`, {
          method: "DELETE",
        });
        notify("Local access record removed.");
      } else if (editing) {
        await api(`/subusers/${encodeURIComponent(editing.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ permissions: selected }),
        });
        notify("Subuser permissions saved locally.");
      } else {
        await post("/subusers", { email: email.trim(), permissions: selected });
        notify("Local subuser record created.");
      }
      setEditor(null);
      setDeleting(null);
      await refresh();
    } catch (cause) {
      setFormError(
        cause instanceof Error
          ? cause.message
          : "Unable to save this record. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  const filtered = users.filter((user) =>
    user.email.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="subusers-page">
      <header className="subusers-heading">
        <h1>Subusers</h1>
        <button className="btn primary" onClick={() => openEditor()}>
          <Plus size={16} />
          New user
        </button>
      </header>
      <section className="subusers-list" aria-label="Subuser records">
        <div className="subusers-toolbar">
          <div className="subusers-list-title">
            <Users size={17} />
            <h2>Users</h2>
            <span>{users.length}</span>
          </div>
          <div className="subusers-controls">
            <SearchField
              className="subusers-search"
              aria-label="Search access records"
              placeholder="Search by email…"
              value={search}
              onValueChange={setSearch}
            />
            <button
              className="btn icon"
              aria-label="Refresh access records"
              title="Refresh users"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw
                size={15}
                className={loading ? "subusers-spinning" : ""}
              />
            </button>
          </div>
        </div>
        {error ? (
          <div className="subusers-error" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
            <button className="btn" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        ) : loading ? (
          <div className="subusers-empty" role="status">
            <RefreshCw size={20} className="subusers-spinning" />
            <span>Loading subusers…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="subusers-empty">
            <Users size={25} />
            <div>
              <h2>{search ? "No matching people" : "No subusers"}</h2>
              <p>
                {search
                  ? "Try another email address."
                  : "Create a local record for someone who helps manage this server."}
              </p>
            </div>
          </div>
        ) : (
          <table className="subusers-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Permissions</th>
                <th className="subuser-added">Added</th>
                <th className="subuser-row-actions">
                  <span className="subusers-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((user) => {
                const count = permissionsFor(user).length;
                return (
                  <tr key={user.id}>
                    <td>
                      <div className="subuser-identity">
                        <span className="subuser-avatar" aria-hidden="true">
                          {user.email.slice(0, 2).toUpperCase()}
                        </span>
                        <div>
                          <strong>{user.email}</strong>
                          <span>Local record</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="subuser-permission-count">
                        {count === permissionIds.length
                          ? "All permissions"
                          : `${count} selected`}
                      </span>
                    </td>
                    <td className="subuser-added">
                      <time
                        dateTime={user.createdAt}
                        title={new Date(user.createdAt).toLocaleString()}
                      >
                        {relativeTime(user.createdAt)}
                      </time>
                    </td>
                    <td className="subuser-row-actions">
                      <div>
                        <button
                          className="btn icon"
                          aria-label={`Edit permissions for ${user.email}`}
                          title="Edit permissions"
                          onClick={() => openEditor(user)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="btn icon subuser-delete"
                          aria-label={`Remove access record for ${user.email}`}
                          title="Remove local record"
                          onClick={() => {
                            setFormError("");
                            setDeleting(user);
                          }}
                        >
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <dialog
        ref={dialog}
        className={`subusers-dialog ${deleting ? "subusers-delete-dialog" : ""}`}
        aria-labelledby="subuser-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          closeDialog();
        }}
      >
        <form onSubmit={submit}>
          <header className="subusers-dialog-heading">
            <h2 id="subuser-dialog-title">
              {deleting
                ? "Remove access record?"
                : editing
                  ? "Edit subuser permissions"
                  : "Create new subuser"}
            </h2>
            <button
              type="button"
              className="btn icon"
              aria-label="Close dialog"
              disabled={busy}
              onClick={closeDialog}
            >
              <X size={18} />
            </button>
          </header>
          <div className="subusers-editor-body">
            {deleting ? (
              <p className="subusers-delete-description">
                Remove the local record for <strong>{deleting.email}</strong>?
                You can add it again later.
              </p>
            ) : (
              <>
                <p className="subusers-editor-notice">
                  Permissions are saved locally. No invitation will be sent, and
                  this record does not grant access.
                </p>
                <div className="subusers-email">
                  <label htmlFor="subuser-email">Email address</label>
                  <input
                    ref={emailInput}
                    id="subuser-email"
                    type="email"
                    required
                    maxLength={254}
                    placeholder="user@example.com"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    readOnly={!!editing}
                    disabled={busy}
                  />
                </div>
                <fieldset className="subusers-permissions" disabled={busy}>
                  <legend className="subusers-sr-only">
                    Intended permissions
                  </legend>
                  <div className="subusers-all-permissions">
                    <PermissionCheckbox
                      label="All permissions"
                      description="Select every permission for this local record."
                      checked={selected.length === permissionIds.length}
                      mixed={
                        selected.length > 0 &&
                        selected.length < permissionIds.length
                      }
                      onChange={() => togglePermissions(permissionIds)}
                    />
                    <span>
                      {selected.length} / {permissionIds.length}
                    </span>
                  </div>
                  {catalog.groups.map((group) => {
                    const ids = group.permissions.map(
                      (permission) => permission.id,
                    );
                    const count = ids.filter((id) =>
                      selected.includes(id),
                    ).length;
                    return (
                      <section
                        className="subusers-permission-group"
                        key={group.id}
                        aria-labelledby={`permission-group-${group.id}`}
                      >
                        <div className="subusers-group-heading">
                          <div>
                            <h3 id={`permission-group-${group.id}`}>
                              {group.label}
                            </h3>
                            <p>{group.description}</p>
                          </div>
                          <PermissionCheckbox
                            label="Select all"
                            accessibleLabel={`Select all ${group.label}`}
                            checked={count === ids.length}
                            mixed={count > 0 && count < ids.length}
                            onChange={() => togglePermissions(ids)}
                          />
                        </div>
                        <div className="subusers-permission-grid">
                          {group.permissions.map((permission) => (
                            <PermissionCheckbox
                              key={permission.id}
                              label={permission.label}
                              description={permission.description}
                              checked={selected.includes(permission.id)}
                              onChange={() =>
                                togglePermissions([permission.id])
                              }
                            />
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </fieldset>
              </>
            )}
            {formError && (
              <p
                ref={errorMessage}
                className="subusers-form-error"
                role="alert"
              >
                <AlertCircle size={16} />
                {formError}
              </p>
            )}
          </div>
          <footer className="subusers-dialog-actions">
            {!deleting && (
              <span>
                {selected.length}{" "}
                {selected.length === 1 ? "permission" : "permissions"} selected
              </span>
            )}
            <div>
              <button
                ref={cancelButton}
                type="button"
                className="btn"
                disabled={busy}
                onClick={closeDialog}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={`btn ${deleting ? "danger" : "primary"}`}
                disabled={busy}
              >
                {busy
                  ? "Saving…"
                  : deleting
                    ? "Remove record"
                    : editing
                      ? "Save permissions"
                      : "Create subuser"}
              </button>
            </div>
          </footer>
        </form>
      </dialog>
    </div>
  );
}
