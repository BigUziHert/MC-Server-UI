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
  Mail,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  api as panelApi,
  useServerApi,
  relativeTime,
  type PageProps,
} from "../api";
import SearchField, { useDebouncedValue } from "../SearchField";
import RefreshButton from "../RefreshButton";
import StatePanel from "../StatePanel";
import Pagination from "../Pagination";
import catalog from "../../shared/subuser-permissions.json";
import "./subusers.css";

type Subuser = {
  id: string;
  email: string;
  role?: string;
  permissions?: string[];
  createdAt: string;
  inviteStatus?: "pending" | "accepted" | "expired" | "not-invited";
  invitedAt?: string;
  acceptedAt?: string;
};
type AccessSettings = {
  enabled: boolean;
  publicUrl: string;
  from: string;
  emailConfigured: boolean;
  port: number;
  ready: boolean;
  listening?: boolean;
  error?: string;
};
function accessReady(settings: AccessSettings | null) {
  return !!settings?.ready && !settings.error && settings.listening !== false;
}
const permissionIds = catalog.groups.flatMap((group) =>
  group.permissions.map((permission) => permission.id),
);

function permissionsFor(user: Subuser) {
  const defaults =
    catalog.roleDefaults[user.role as keyof typeof catalog.roleDefaults] ?? [];
  const selected = new Set(user.permissions ?? defaults);
  return permissionIds.filter((permission) => selected.has(permission));
}

function RemoteAccessSetup({
  onSettings,
  notify,
}: {
  onSettings: (settings: AccessSettings | null) => void;
  notify: PageProps["notify"];
}) {
  const [settings, setSettings] = useState<AccessSettings | null>(null);
  const [draft, setDraft] = useState({
    enabled: false,
    publicUrl: "",
    from: "",
    port: "3002",
    apiKey: "",
  });
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const applySettings = useCallback(
    (value: AccessSettings) => {
      setSettings(value);
      onSettings(value);
      setDraft({
        enabled: value.enabled,
        publicUrl: value.publicUrl || "",
        from: value.from || "",
        port: String(value.port || 3002),
        apiKey: "",
      });
    },
    [onSettings],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError("");
      try {
        const result = await panelApi<AccessSettings>("/access/settings", {
          signal,
        });
        if (signal?.aborted) return;
        applySettings(result);
        setExpanded(!accessReady(result));
      } catch (cause) {
        if (signal?.aborted) return;
        if ((cause as { status?: number }).status === 403) {
          setHidden(true);
          onSettings(null);
        } else
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to load invitation settings.",
          );
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [applySettings, onSettings],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await panelApi<AccessSettings>("/access/settings", {
        method: "PUT",
        body: JSON.stringify({
          enabled: draft.enabled,
          publicUrl: draft.publicUrl.trim(),
          from: draft.from.trim(),
          port: Number(draft.port),
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
        }),
      });
      applySettings(result);
      if (result.error) setError(result.error);
      else notify("Remote access settings saved.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to save remote access settings.",
      );
      // A failed listener restart can also disable remote access on the server.
      // Refresh readiness while retaining the owner's draft for correction.
      try {
        const current = await panelApi<AccessSettings>("/access/settings");
        setSettings(current);
        onSettings(current);
      } catch {
        setSettings((current) =>
          current ? { ...current, ready: false } : null,
        );
        onSettings(null);
      }
    } finally {
      setSaving(false);
    }
  }

  if (hidden) return null;
  if (loading)
    return (
      <section className="subusers-setup">
        <StatePanel variant="loading" title="Loading invitation settings…" />
      </section>
    );
  if (!settings)
    return (
      <section className="subusers-setup">
        <StatePanel
          variant="error"
          title="Unable to load invitation settings"
          message={error}
          onRetry={() => void load()}
        />
      </section>
    );
  return (
    <section className="subusers-setup" aria-label="Remote access setup">
      <div className="subusers-setup-heading">
        <ShieldCheck size={20} />
        <div>
          <h2>
            {accessReady(settings)
              ? "Invitations are configured"
              : "Set up phone access"}
          </h2>
          <p>
            {accessReady(settings)
              ? "Invite someone by email to control this server with their own permissions."
              : "Connect a public panel address and email delivery before sending invitations."}
          </p>
        </div>
        <button
          className="btn"
          aria-expanded={expanded}
          aria-controls="subusers-access-settings"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Hide setup" : "Edit setup"}
        </button>
      </div>
      {expanded && (
        <form
          id="subusers-access-settings"
          className="subusers-setup-form"
          onSubmit={save}
        >
          <fieldset disabled={saving}>
            <PermissionCheckbox
              label="Enable remote access"
              description="Allow invited people to sign in through the public panel address."
              checked={draft.enabled}
              onChange={() => setDraft({ ...draft, enabled: !draft.enabled })}
            />
            <div className="subusers-setup-grid">
              <div className="subusers-setup-field">
                <label htmlFor="subusers-public-url">HTTPS panel URL</label>
                <input
                  id="subusers-public-url"
                  type="url"
                  placeholder="https://panel.example.com"
                  required={draft.enabled}
                  value={draft.publicUrl}
                  onChange={(event) =>
                    setDraft({ ...draft, publicUrl: event.target.value })
                  }
                />
                <small>
                  The address invited people will open on their phone.
                </small>
              </div>
              <div className="subusers-setup-field">
                <label htmlFor="subusers-mail-from">Sending address</label>
                <input
                  id="subusers-mail-from"
                  placeholder="Minecraft Panel <panel@example.com>"
                  required={draft.enabled}
                  value={draft.from}
                  onChange={(event) =>
                    setDraft({ ...draft, from: event.target.value })
                  }
                />
                <small>Use a sender from a domain verified in Resend.</small>
              </div>
              <div className="subusers-setup-field">
                <label htmlFor="subusers-mail-key">Resend API key</label>
                <input
                  id="subusers-mail-key"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={
                    settings.emailConfigured
                      ? "Saved — leave blank to keep"
                      : "re_…"
                  }
                  value={draft.apiKey}
                  onChange={(event) =>
                    setDraft({ ...draft, apiKey: event.target.value })
                  }
                />
                <small>
                  {settings.emailConfigured
                    ? "A key is saved. Enter a new key only to replace it."
                    : "Used to deliver invitation and sign-in emails. Leave blank to keep a saved key."}
                </small>
              </div>
              <div className="subusers-setup-field">
                <label htmlFor="subusers-remote-port">Remote access port</label>
                <input
                  id="subusers-remote-port"
                  type="number"
                  min={1024}
                  max={65535}
                  required
                  value={draft.port}
                  onChange={(event) =>
                    setDraft({ ...draft, port: event.target.value })
                  }
                />
                <small>A separate port for authenticated remote access.</small>
              </div>
            </div>
            <p className="subusers-setup-guidance">
              Point an HTTPS reverse proxy or tunnel at{" "}
              <code>http://127.0.0.1:{draft.port || "3002"}</code>, then use its
              public address above. Configure the domain and HTTPS with your
              provider, and route to this remote access port. The desktop panel
              port is for local owner access. Keep this computer and the panel
              running so invitations and phone access work.
            </p>
            {(error || settings.error) && (
              <p className="subusers-form-error" role="alert">
                <AlertCircle size={16} />
                {error || settings.error}
              </p>
            )}
            <div className="subusers-setup-actions">
              <span>
                {accessReady(settings)
                  ? "Settings saved. Check that the public address opens from your phone."
                  : "Save the setup, then send an invitation below."}
              </span>
              <button className="btn primary" type="submit">
                {saving ? "Saving…" : "Save access settings"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}

function PermissionCheckbox({
  label,
  accessibleLabel,
  description,
  checked,
  mixed = false,
  disabled = false,
  onChange,
}: {
  label: string;
  accessibleLabel?: string;
  description?: string;
  checked: boolean;
  mixed?: boolean;
  disabled?: boolean;
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
        disabled={disabled}
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
  const debouncedSearch = useDebouncedValue(search);
  const [page, setPage] = useState(1),
    [pageSize, setPageSize] = useState(25);
  const loaded = useRef(false);
  useEffect(() => setPage(1), [debouncedSearch, pageSize]);
  const [editor, setEditor] = useState<"create" | Subuser | null>(null);
  const [email, setEmail] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<Subuser | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [accessSettings, setAccessSettings] = useState<AccessSettings | null>(
    null,
  );
  const [sendOnCreate, setSendOnCreate] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState("");
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
    if (!loaded.current) setLoading(true);
    setError("");
    try {
      const result = await api<{ users: Subuser[] }>("/subusers", {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return false;
      setUsers(result.users);
      loaded.current = true;
      return true;
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : "Unable to load subusers.",
        );
      return false;
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    loaded.current = false;
    setUsers([]);
    setSearch("");
    setPage(1);
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
    setSendOnCreate(accessReady(accessSettings));
    setEditor(user ?? "create");
  }
  async function sendInvitation(user: Subuser) {
    setInviting(user.id);
    setInvitationError("");
    try {
      const result = await post<{ message: string; user: Subuser }>(
        `/subusers/${encodeURIComponent(user.id)}/invite`,
      );
      setUsers((previous) =>
        previous.map((item) => (item.id === user.id ? result.user : item)),
      );
      notify(result.message || `Invitation sent to ${user.email}.`);
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Unable to send the invitation.";
      setInvitationError(
        `The subuser is saved, but the invitation to ${user.email} was not sent. ${message} Use ${user.invitedAt ? "Invite again" : "Send invite"} to retry.`,
      );
      notify("Invitation was not sent. The subuser is still saved.", true);
    } finally {
      setInviting(null);
    }
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
        notify("Subuser access revoked.");
      } else if (editing) {
        await api(`/subusers/${encodeURIComponent(editing.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ permissions: selected }),
        });
        notify("Subuser permissions updated. Changes take effect immediately.");
      } else {
        const result = await post<Subuser | { user: Subuser }>("/subusers", {
          email: email.trim(),
          permissions: selected,
        });
        // Creation has succeeded even if the separate email request fails.
        setEditor(null);
        await refresh();
        if (sendOnCreate)
          await sendInvitation("user" in result ? result.user : result);
        else
          notify(
            "Subuser created. Send an invitation when access is configured.",
          );
        return;
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
    user.email.toLowerCase().includes(debouncedSearch.toLowerCase()),
  );

  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filtered.length / pageSize)),
  );
  const visible = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  return (
    <div className="subusers-page">
      <header className="page-heading">
        <div>
          <h1>Subusers</h1>
          <p className="subusers-page-description">
            Invite people to manage this server from their phone or browser.
          </p>
        </div>
        <button
          className="btn primary"
          disabled={busy || !!inviting}
          onClick={() => openEditor()}
        >
          <Plus size={16} />
          New user
        </button>
      </header>
      <RemoteAccessSetup onSettings={setAccessSettings} notify={notify} />
      {invitationError && (
        <p className="subusers-form-error" role="alert">
          <AlertCircle size={16} />
          {invitationError}
        </p>
      )}
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
              placeholder="Search subusers…"
              value={search}
              onValueChange={setSearch}
            />
            <RefreshButton
              label="Refresh access records"
              disabled={busy}
              onRefresh={refresh}
              notify={notify}
              successMessage="Access records refreshed."
            />
          </div>
        </div>
        {error && (
          <StatePanel
            variant="error"
            title="Unable to refresh subusers"
            message={error}
            onRetry={() => void refresh()}
          />
        )}
        {loading ? (
          <StatePanel variant="loading" title="Loading subusers…" />
        ) : filtered.length === 0 ? (
          <StatePanel
            variant="empty"
            icon={<Users size={25} />}
            title={search ? "No matching people" : "No subusers"}
            message={
              search
                ? "Try another email address."
                : "Add someone by email, choose their permissions, and send an invitation."
            }
          />
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
              {visible.map((user) => {
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
                          <span
                            title={
                              user.invitedAt
                                ? `Last invitation sent ${new Date(user.invitedAt).toLocaleString()}`
                                : undefined
                            }
                          >
                            {user.inviteStatus === "accepted"
                              ? "Access activated"
                              : user.inviteStatus === "pending"
                                ? "Invitation sent · awaiting sign-in"
                                : user.inviteStatus === "expired"
                                  ? "Invitation expired · send again"
                                  : "Not invited"}
                          </span>
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
                          className="btn subuser-invite"
                          aria-label={`${user.invitedAt ? "Resend invitation to" : "Send invitation to"} ${user.email}`}
                          title={
                            accessReady(accessSettings)
                              ? "Send a sign-in invitation by email"
                              : "Complete remote access setup to send invitations"
                          }
                          disabled={
                            busy || !!inviting || !accessReady(accessSettings)
                          }
                          onClick={() => void sendInvitation(user)}
                        >
                          <Mail size={14} />
                          {inviting === user.id
                            ? "Sending…"
                            : user.invitedAt
                              ? "Invite again"
                              : "Send invite"}
                        </button>
                        <button
                          className="btn icon"
                          aria-label={`Edit permissions for ${user.email}`}
                          title="Edit permissions"
                          disabled={busy || !!inviting}
                          onClick={() => openEditor(user)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="btn icon subuser-delete"
                          aria-label={`Remove access record for ${user.email}`}
                          title="Revoke access"
                          disabled={busy || !!inviting}
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
        {filtered.length > 0 && (
          <Pagination
            page={currentPage}
            pageSize={pageSize}
            total={filtered.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            label="subusers"
          />
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
                Revoke access for <strong>{deleting.email}</strong>? Their
                active sessions and invitation links will stop working for this
                server. You can invite them again later.
              </p>
            ) : (
              <>
                <p className="subusers-editor-notice">
                  {editing
                    ? "Permission changes apply immediately, including to active sessions."
                    : "Choose what this person can do on this server. Their invitation opens the panel in their phone or browser."}
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
                {!editing && (
                  <div className="subusers-invitation-choice">
                    <PermissionCheckbox
                      label="Send invitation by email"
                      disabled={busy || !accessReady(accessSettings)}
                      description={
                        accessReady(accessSettings)
                          ? "Send a sign-in link as soon as this subuser is created."
                          : "Complete remote access setup before sending invitations. You can create the subuser now and invite them later."
                      }
                      checked={sendOnCreate}
                      onChange={() => setSendOnCreate(!sendOnCreate)}
                    />
                    {!accessReady(accessSettings) && (
                      <small>
                        No invitation will be sent until remote access is
                        configured.
                      </small>
                    )}
                  </div>
                )}
                <fieldset className="subusers-permissions" disabled={busy}>
                  <legend className="subusers-sr-only">
                    Server permissions
                  </legend>
                  <div className="subusers-preset">
                    <div>
                      <strong>Server controls</strong>
                      <p>Start, stop, restart, and use the console.</p>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      onClick={() =>
                        setSelected(
                          permissionIds.filter((id) =>
                            id.startsWith("control."),
                          ),
                        )
                      }
                    >
                      Use Control preset
                    </button>
                  </div>
                  <div className="subusers-all-permissions">
                    <PermissionCheckbox
                      label="All permissions"
                      description="Grant every listed permission for this server."
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
