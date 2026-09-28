import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  Copy,
  Link,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  usePanelApi,
  useServerApi,
  relativeTime,
  ServerScope,
  type PageProps,
} from "../api";
import SearchField, { useDebouncedValue } from "../SearchField";
import RefreshButton from "../RefreshButton";
import StatePanel from "../StatePanel";
import { copyText } from "../clipboard";
import Pagination from "../Pagination";
import catalog from "../../shared/subuser-permissions.json";
import "./subusers.css";

type Subuser = {
  id: string;
  email: string;
  role?: string;
  permissions?: string[];
  hostPermissions?: string[];
  effectiveHostPermissions?: string[];
  accessMode?: "all" | "selected";
  serverIds?: string[];
  excludedServerIds?: string[];
  serverOverrides?: Record<
    string,
    { permissions: string[]; hostPermissions?: string[] }
  >;
  legacy?: boolean;
  legacyPending?: boolean;
  panelAccount?: boolean;
  createdAt?: string;
  inviteStatus?: "pending" | "accepted" | "expired" | "not-invited";
  invitedAt?: string;
  acceptedAt?: string;
  accessReview?: { message: string };
};
type AccessSettings = {
  enabled: boolean;
  publicUrl: string;
  transport: "managed" | "direct" | "proxy";
  port: number;
  ready: boolean;
  listening?: boolean;
  error?: string;
  networkWarning?: string;
  certificate?: { fingerprint256: string; validTo: string; hosts: string[] };
  managedHttps?: {
    state: "disabled" | "starting" | "provisioning" | "ready" | "error";
    ready: boolean;
    message: string;
    certificate?: { validTo: string };
  };
};
type NetworkInfo = {
  publicIp: string | null;
  localAddresses: string[];
  port: number;
};
type Invitation = {
  user: Subuser;
  invitationUrl: string;
  inviteExpiresAt: string;
  warning?: string;
  panelWide?: boolean;
};
function accessReady(settings: AccessSettings | null) {
  return (
    !!settings?.enabled &&
    !!settings.ready &&
    !settings.error &&
    settings.listening !== false &&
    (settings.transport !== "managed" ||
      (settings.managedHttps?.state === "ready" && settings.managedHttps.ready))
  );
}
const permissionIds = catalog.groups.flatMap((group) =>
  group.permissions.map((permission) => permission.id),
);

function trustedAddress(settings: AccessSettings) {
  if (settings.transport === "managed" || !settings.publicUrl)
    return settings.publicUrl || "";
  // Preparing an upgrade draft must not change the saved listener or its origin.
  try {
    const address = new URL(settings.publicUrl);
    address.protocol = "https:";
    address.port = "";
    return address.origin;
  } catch {
    return settings.publicUrl;
  }
}

function permissionsFor(user: Subuser) {
  const defaults =
    catalog.roleDefaults[
      user.role as keyof typeof catalog.roleDefaults
    ]?.filter((id) => id !== "server.update") ?? [];
  const selected = new Set(user.permissions ?? defaults);
  return permissionIds.filter((permission) => selected.has(permission));
}

export function RemoteAccessSetup({
  onSettings,
  notify,
}: {
  onSettings: (settings: AccessSettings | null) => void;
  notify: PageProps["notify"];
}) {
  const { api: panelApi } = usePanelApi();
  const [settings, setSettings] = useState<AccessSettings | null>(null);
  const [draft, setDraft] = useState({
    enabled: false,
    publicUrl: "",
    port: "3002",
  });
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [networkError, setNetworkError] = useState("");
  const [pollError, setPollError] = useState("");
  const settingsRevision = useRef(0);

  const publishSettings = useCallback(
    (value: AccessSettings) => {
      setSettings(value);
      onSettings(value);
      window.dispatchEvent(
        new CustomEvent("mc-panel-access-settings-changed", { detail: value }),
      );
    },
    [onSettings],
  );

  const applySettings = useCallback(
    (value: AccessSettings) => {
      publishSettings(value);
      setDraft({
        enabled: value.enabled,
        publicUrl: trustedAddress(value),
        port: String(value.port || 3002),
      });
    },
    [publishSettings],
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
        setExpanded(!accessReady(result) || result.transport !== "managed");
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
    [panelApi, applySettings, onSettings],
  );

  useEffect(() => {
    const controller = new AbortController();
    setSaving(false);
    void load(controller.signal);
    return () => {
      settingsRevision.current++;
      controller.abort();
    };
  }, [load]);

  // Certificate issuance and renewal continue in the host. Refresh status without
  // replacing an owner's unfinished edits or accepting a pre-save response.
  useEffect(() => {
    if (!settings?.enabled || settings.transport !== "managed" || saving)
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const revision = settingsRevision.current;
      try {
        const value = await panelApi<AccessSettings>("/access/settings", {
          signal: controller.signal,
        });
        if (controller.signal.aborted || revision !== settingsRevision.current)
          return;
        setPollError("");
        publishSettings(value);
      } catch {
        if (controller.signal.aborted || revision !== settingsRevision.current)
          return;
        setPollError(
          "Unable to check certificate status. MC Panel will try again automatically.",
        );
        setSettings((current) =>
          current ? { ...current, ready: false } : null,
        );
        onSettings(null);
        window.dispatchEvent(
          new CustomEvent("mc-panel-access-settings-changed", { detail: null }),
        );
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void poll(), 3000);
      }
    }
    timer = setTimeout(() => void poll(), 3000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    settings?.enabled,
    settings?.transport,
    saving,
    panelApi,
    publishSettings,
    onSettings,
  ]);

  async function discoverAddress() {
    setDiscovering(true);
    setNetworkError("");
    try {
      const value = await panelApi<NetworkInfo>("/access/network");
      if (value.publicIp) {
        const host = value.publicIp.includes(":")
          ? `[${value.publicIp}]`
          : value.publicIp;
        setDraft((current) => ({
          ...current,
          publicUrl: `https://${host}`,
        }));
      } else
        setNetworkError(
          "Your public IP could not be detected. Enter the public address shown by your router.",
        );
    } catch (cause) {
      setNetworkError(
        cause instanceof Error
          ? cause.message
          : "Unable to detect your public IP. Enter it manually.",
      );
    } finally {
      setDiscovering(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    const revision = ++settingsRevision.current;
    setSaving(true);
    setError("");
    setPollError("");
    try {
      const result = await panelApi<AccessSettings>("/access/settings", {
        method: "PUT",
        body: JSON.stringify({
          enabled: draft.enabled,
          publicUrl: draft.publicUrl.trim(),
          transport: "managed",
          port: Number(draft.port),
        }),
      });
      if (revision !== settingsRevision.current) return;
      applySettings(result);
      if (result.error && result.transport !== "managed")
        setError(result.error);
      else notify("Remote access settings saved.");
    } catch (cause) {
      if (revision !== settingsRevision.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to save remote access settings.",
      );
      // A failed listener restart can also disable remote access on the server.
      // Refresh readiness while retaining the owner's draft for correction.
      try {
        const current = await panelApi<AccessSettings>("/access/settings");
        if (revision !== settingsRevision.current) return;
        publishSettings(current);
      } catch {
        if (revision !== settingsRevision.current) return;
        setSettings((current) =>
          current ? { ...current, ready: false } : null,
        );
        onSettings(null);
        window.dispatchEvent(
          new CustomEvent("mc-panel-access-settings-changed", { detail: null }),
        );
      }
    } finally {
      if (revision === settingsRevision.current) setSaving(false);
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
              ? "Remote access is configured"
              : "Remote access"}
          </h2>
          <p>
            {accessReady(settings)
              ? "Create an invitation link and send it yourself by text or email."
              : "Allow invited accounts to sign in to this panel. Server access is granted separately."}
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
      {settings.transport !== "managed" && settings.publicUrl && (
        <div
          className="subusers-https-status"
          role="note"
          aria-label="Trusted HTTPS upgrade"
        >
          <strong>Upgrade your saved remote access setup</strong>
          <p>
            Your saved address is <code>{settings.publicUrl}</code>. It stays
            unchanged until you save.
          </p>
          <p>
            Saving switches this panel to trusted HTTPS on port 443. Forward TCP
            port 443 to this computer first, and stop any other service using
            that port. Wait for the trusted certificate, then share the new
            address and invitation links. People using an old address must sign
            in at the new one.
          </p>
          <p>
            Existing accounts, passwords, and server permissions are preserved.
          </p>
        </div>
      )}
      {settings.enabled && settings.transport === "managed" && (
        <div
          className={`subusers-https-status ${accessReady(settings) ? "ready" : ""}`}
          role="status"
          aria-live="polite"
        >
          <strong>
            {accessReady(settings)
              ? "Trusted certificate is ready"
              : "Trusted HTTPS setup"}
          </strong>
          <p>
            {pollError ||
              settings.managedHttps?.message ||
              "Checking the certificate for your public panel address…"}
          </p>
          {settings.networkWarning && (
            <p className="subusers-https-warning">{settings.networkWarning}</p>
          )}
          {accessReady(settings) && (
            <p>
              Automatic renewal is enabled while MC Panel is running.
              {settings.managedHttps?.certificate?.validTo &&
                ` Current certificate expires ${new Date(settings.managedHttps.certificate.validTo).toLocaleString()}.`}{" "}
              <a
                href={settings.publicUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open public panel
              </a>{" "}
              on your phone using mobile data to check access from outside your
              home.
            </p>
          )}
          {!accessReady(settings) && (
            <p>
              Invitation links are available after the trusted certificate is
              ready. Your existing accounts and server permissions are
              unchanged.
            </p>
          )}
        </div>
      )}
      {expanded && (
        <form
          id="subusers-access-settings"
          className="subusers-setup-form"
          onSubmit={save}
        >
          <fieldset disabled={saving || discovering}>
            <PermissionCheckbox
              label="Enable remote access"
              description="Allow invited people to sign in through the public panel address."
              checked={draft.enabled}
              onChange={() => setDraft({ ...draft, enabled: !draft.enabled })}
            />
            <div className="subusers-setup-guidance">
              <strong>Trusted HTTPS</strong>
              <p>
                MC Panel runs bundled Caddy to obtain and renew a trusted
                certificate. No separate installation or domain is required.
              </p>
            </div>
            <div className="subusers-setup-field">
              <label htmlFor="subusers-public-url">Public panel address</label>
              <input
                id="subusers-public-url"
                type="url"
                placeholder="https://203.0.113.10"
                required={draft.enabled}
                value={draft.publicUrl}
                onChange={(event) =>
                  setDraft({ ...draft, publicUrl: event.target.value })
                }
              />
              <small>
                Your public IP or domain, starting with https://. Trusted HTTPS
                uses port 443.
              </small>
              <button
                type="button"
                className="btn subusers-detect"
                onClick={() => void discoverAddress()}
              >
                {discovering ? "Detecting…" : "Use my public IP"}
              </button>
            </div>
            {networkError && (
              <p className="subusers-form-error" role="alert">
                {networkError}
              </p>
            )}
            <details className="subusers-advanced">
              <summary>Advanced connection options</summary>
              <div className="subusers-setup-field">
                <label htmlFor="subusers-internal-port">
                  Internal service port
                </label>
                <input
                  id="subusers-internal-port"
                  type="number"
                  min={1024}
                  max={65535}
                  required
                  value={draft.port}
                  onChange={(event) =>
                    setDraft({ ...draft, port: event.target.value })
                  }
                />
                <small>
                  Used only on this computer. Do not forward this port on your
                  router.
                </small>
              </div>
            </details>
            <div className="subusers-setup-guidance">
              <strong>Connect securely from outside your home</strong>
              <ol>
                <li>
                  Forward TCP port <code>443</code> on your router to this
                  computer’s local IP on port <code>443</code>. Reserve that
                  local IP and allow Caddy through Windows Firewall if prompted.
                </li>
                <li>
                  Enable remote access and save. MC Panel automatically requests
                  the trusted certificate and renews it while running.
                </li>
                <li>
                  When the certificate is ready, check the public address on
                  your phone using mobile data, then share invitations.
                </li>
              </ol>
              <p>
                Keep this computer and MC Panel running. Update this address if
                your public IP changes. Valid trusted certificates remove
                certificate warnings in desktop and phone browsers.
              </p>
              <p>
                These settings do not open router or firewall ports. A shared
                ISP address (CGNAT) or blocked incoming port 443 may require a
                public IP from your provider. Port 443 must be available on this
                computer and forwarded to it.
              </p>
              <p>
                Enabling and saving requests certificates from Let’s Encrypt for
                this public address under its{" "}
                <a
                  href="https://letsencrypt.org/repository/"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Subscriber Agreement
                </a>
                .
              </p>
            </div>
            {(error || settings.error) && (
              <p className="subusers-form-error" role="alert">
                <AlertCircle size={16} />
                {error || settings.error}
              </p>
            )}
            <div className="subusers-setup-actions">
              <span>
                {accessReady(settings)
                  ? "Remote access settings saved."
                  : settings.enabled && settings.transport === "managed"
                    ? "Waiting for a trusted certificate before sharing invitation links."
                    : "Save the setup, then create an invitation link below."}
              </span>
              <button className="btn primary" type="submit">
                {saving
                  ? "Saving…"
                  : settings.transport === "managed" &&
                      settings.managedHttps?.state === "error"
                    ? "Retry HTTPS setup"
                    : "Save access settings"}
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

function InvitationDialog({
  invitation,
  onClose,
  panelWide,
}: {
  invitation: Invitation;
  onClose: () => void;
  panelWide: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const link = useRef<HTMLTextAreaElement>(null);
  const invitationId = useId();
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    link.current?.focus();
    link.current?.select();
  }, []);
  async function copy() {
    try {
      await copyText(invitation.invitationUrl, link.current);
      setCopyStatus("Invitation link copied.");
    } catch {
      link.current?.focus();
      link.current?.select();
      setCopyStatus(
        "Clipboard access is unavailable. Copy the selected link manually, or try Copy link again.",
      );
    }
  }
  return (
    <dialog
      ref={dialog}
      className="subusers-dialog subusers-link-dialog"
      aria-labelledby={`${invitationId}-title`}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <div className="subusers-link-content">
        <header className="subusers-dialog-heading">
          <h2 id={`${invitationId}-title`}>Share invitation link</h2>
          <button
            className="btn icon"
            aria-label="Close invitation"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="subusers-editor-body">
          <p className="subusers-editor-notice">
            Send this link privately to <strong>{invitation.user.email}</strong>{" "}
            using your own text or email app. MC Panel does not send an email.
            {panelWide && " This invitation grants no server access."}
          </p>
          <div className="subusers-setup-field">
            <label htmlFor={`${invitationId}-url`}>Invitation link</label>
            <textarea
              ref={link}
              id={`${invitationId}-url`}
              rows={4}
              readOnly
              value={invitation.invitationUrl}
              onFocus={(event) => event.target.select()}
            />
            <small>
              Works once. Expires{" "}
              {new Date(invitation.inviteExpiresAt).toLocaleString()}.
            </small>
          </div>
          <p className="subusers-editor-notice subusers-link-explanation">
            The recipient chooses a password of at least 12 characters, then
            signs in with their email and password. Creating another link
            invalidates their previous unused link. Resetting access disables
            their previous password and signs them out of{" "}
            {panelWide ? "this panel " : "this server "}
            immediately. They regain access after accepting the new link.
          </p>
          {invitation.warning && (
            <p className="subusers-form-error" role="alert">
              <AlertCircle size={16} /> {invitation.warning}
            </p>
          )}
          {copyStatus && (
            <p role="status" className="subusers-copy-status">
              {copyStatus}
            </p>
          )}
        </div>
        <footer className="subusers-dialog-actions">
          <span>Copy the link before closing this window.</span>
          <div>
            <button className="btn" onClick={onClose}>
              Done
            </button>
            <button className="btn primary" onClick={() => void copy()}>
              <Copy size={15} /> Copy link
            </button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}

export default function Subusers({
  notify,
  permissions,
  signedInEmail,
}: PageProps & { permissions?: string[]; signedInEmail?: string }) {
  const serverId = useContext(ServerScope);
  if (!serverId)
    return (
      <StatePanel
        variant="empty"
        title="Choose a server"
        message="Select a server to manage its subusers and permissions."
      />
    );
  return (
    <AccessManagement
      notify={notify}
      permissions={permissions}
      signedInEmail={signedInEmail}
      scope="server"
    />
  );
}

export function PanelUsers({ notify }: PageProps) {
  return <AccessManagement notify={notify} scope="accounts" />;
}

function AccessManagement({
  notify,
  permissions,
  signedInEmail,
  scope,
}: PageProps & {
  permissions?: string[];
  signedInEmail?: string;
  scope: "server" | "accounts";
}) {
  const editorId = useId();
  const remote = permissions !== undefined;
  const accountsView = scope === "accounts";
  const can = (permission: string) =>
    permissions === undefined || permissions.includes(permission);
  const canRead = can("user.read");
  const canCreate = can("user.create");
  const canUpdate = can("user.update");
  const canDelete = can("user.delete");
  const ownAccess = (user: Subuser) =>
    signedInEmail !== undefined &&
    user.email.toLowerCase() === signedInEmail.toLowerCase();
  const manageable = (user: Subuser) =>
    !ownAccess(user) &&
    permissionsFor(user).every(can) &&
    (!remote || (!user.hostPermissions?.length && !user.panelAccount));
  const grantablePermissions = permissionIds.filter(can);
  const groups = catalog.groups
    .map((group) => ({
      ...group,
      permissions: group.permissions.filter(
        (permission) => permission.id !== "server.view" && can(permission.id),
      ),
    }))
    .filter((group) => group.permissions.length);
  const { api: serverApi } = useServerApi();
  const { api: panelApi } = usePanelApi();
  const api = accountsView ? panelApi : serverApi;
  const basePath = accountsView ? "/panel-users" : "/subusers";
  const [users, setUsers] = useState<Subuser[]>([]);
  const [accounts, setAccounts] = useState<Subuser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const loaded = useRef(false);
  const [editor, setEditor] = useState<"invite" | "grant" | Subuser | null>(
    null,
  );
  const [email, setEmail] = useState("");
  const [accountId, setAccountId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [allowServerCreation, setAllowServerCreation] = useState(false);
  const [deleting, setDeleting] = useState<Subuser | null>(null);
  const [resetting, setResetting] = useState<Subuser | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const [accessSettings, setAccessSettings] = useState<AccessSettings | null>(
    null,
  );
  const [inviteOnCreate, setInviteOnCreate] = useState(false);
  const [inviting, setInviting] = useState<string | null>(null);
  const [invitationError, setInvitationError] = useState("");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const emailInput = useRef<HTMLInputElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const editing = editor && typeof editor === "object" ? editor : null;
  const invitingAccount = editor === "invite";
  const accountEditor = invitingAccount || (accountsView && !!editing);
  const invitationReady = canCreate && (remote || accessReady(accessSettings));
  const canSubmitRecord = resetting
    ? canCreate && manageable(resetting)
    : deleting
      ? canDelete && manageable(deleting)
      : editing
        ? canUpdate && manageable(editing)
        : canCreate;
  const candidates = accounts.filter(
    (account) =>
      !users.some(
        (user) => user.email.toLowerCase() === account.email.toLowerCase(),
      ),
  );

  useEffect(() => setPage(1), [debouncedSearch, pageSize]);
  useEffect(() => {
    if (!accountsView) return;
    const update = (event: Event) =>
      setAccessSettings((event as CustomEvent<AccessSettings>).detail);
    window.addEventListener("mc-panel-access-settings-changed", update);
    return () =>
      window.removeEventListener("mc-panel-access-settings-changed", update);
  }, [accountsView]);
  const refresh = useCallback(
    async (background = false) => {
      // A slow read must be allowed to finish. Periodic refreshes must not keep
      // aborting it, or clear the last refresh failure while the host is down.
      if (background && request.current) return false;
      request.current?.abort();
      if (!canRead) {
        setLoading(false);
        return false;
      }
      const controller = new AbortController();
      request.current = controller;
      if (!loaded.current) setLoading(true);
      if (!background) setError("");
      try {
        const [result, panelResult, settings] = await Promise.all([
          api<{ users: Subuser[] }>(basePath, { signal: controller.signal }),
          !remote && !accountsView
            ? panelApi<{ users: Subuser[] }>("/panel-users", {
                signal: controller.signal,
              })
            : Promise.resolve(null),
          accountsView
            ? panelApi<AccessSettings>("/access/settings", {
                signal: controller.signal,
              }).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (controller.signal.aborted) return false;
        setUsers(result.users);
        setAccounts(panelResult?.users ?? (accountsView ? result.users : []));
        setAccessSettings(settings);
        setError("");
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
        if (request.current === controller) request.current = null;
      }
    },
    [api, panelApi, canRead, basePath, remote, accountsView],
  );
  useEffect(() => {
    if (remote) return;
    const update = () => void refresh();
    window.addEventListener("mc-panel-accounts-changed", update);
    return () =>
      window.removeEventListener("mc-panel-accounts-changed", update);
  }, [remote, refresh]);
  useEffect(() => {
    loaded.current = false;
    setUsers([]);
    setAccounts([]);
    setSearch("");
    setPage(1);
    setEditor(null);
    setAccountId("");
    setDeleting(null);
    setResetting(null);
    setInvitation(null);
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);
  useEffect(() => {
    if (!canRead) return;
    // Forget runs on the invited user's device. The owner's account and grant
    // tables must catch up even when no action occurs in this window.
    const update = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    const timer = window.setInterval(update, 5000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [canRead, refresh]);
  useEffect(() => {
    if (!loaded.current || busy || inviting) return;
    const record = editing ?? deleting ?? resetting;
    const missingRecord =
      record && !users.some((user) => user.id === record.id);
    const missingGrantAccount =
      editor === "grant" &&
      !remote &&
      accountId &&
      !accounts.some((account) => account.id === accountId);
    const missingInvitation =
      invitation &&
      !(invitation.panelWide && !accountsView ? accounts : users).some(
        (user) => user.id === invitation.user.id,
      );
    if (missingRecord || missingGrantAccount) {
      setEditor(null);
      setAccountId("");
      setDeleting(null);
      setResetting(null);
      setFormError("");
    }
    if (missingInvitation) setInvitation(null);
    if (missingRecord || missingGrantAccount || missingInvitation) {
      setInvitationError("");
      notify(
        "This access record was removed on the host. The list has been updated.",
      );
    }
  }, [
    users,
    accounts,
    editing,
    deleting,
    resetting,
    editor,
    accountId,
    invitation,
    accountsView,
    remote,
    busy,
    inviting,
    notify,
  ]);
  useEffect(() => {
    const element = dialog.current;
    if (editor || deleting || resetting) {
      element?.showModal();
      if (deleting || resetting) cancelButton.current?.focus();
      else if (editor === "invite" || (editor === "grant" && remote))
        emailInput.current?.focus();
      else
        element
          ?.querySelector<HTMLElement>("select, input[type=checkbox]")
          ?.focus();
    } else element?.close();
  }, [editor, deleting, resetting, remote]);
  useEffect(() => {
    if (formError) errorMessage.current?.scrollIntoView({ block: "nearest" });
  }, [formError]);

  function closeDialog() {
    if (busy) return;
    setEditor(null);
    setDeleting(null);
    setResetting(null);
    setFormError("");
  }
  function openEditor(user?: Subuser, invite = false) {
    if (user ? !canUpdate || !manageable(user) : !canCreate) return;
    setEmail(user?.email ?? "");
    setAccountId("");
    setSelected(user ? permissionsFor(user) : []);
    setAllowServerCreation(
      (user?.effectiveHostPermissions ?? user?.hostPermissions)?.includes(
        "server.create",
      ) ?? false,
    );
    setFormError("");
    setInviteOnCreate(invite && invitationReady);
    setEditor(user ?? (invite ? "invite" : "grant"));
  }
  async function createInvitation(user: Subuser, panelAccount = accountsView) {
    if (!canCreate || (remote && !manageable(user))) return false;
    setInviting(user.id);
    setInvitationError("");
    try {
      const result = await (panelAccount ? panelApi : serverApi)<Invitation>(
        `${panelAccount ? "/panel-users" : "/subusers"}/${encodeURIComponent(user.id)}/invite`,
        { method: "POST", body: "{}" },
      );
      setUsers((previous) =>
        previous.map((item) => (item.id === user.id ? result.user : item)),
      );
      setInvitation({ ...result, panelWide: panelAccount });
      if (panelAccount)
        window.dispatchEvent(new Event("mc-panel-accounts-changed"));
      return true;
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Unable to create the invitation link.";
      setInvitationError(
        `The ${panelAccount ? "account" : "subuser"} is saved, but an invitation link for ${user.email} could not be created. ${message} Use ${user.inviteStatus === "accepted" ? "Reset access" : "Create invite link"} to retry.`,
      );
      notify(
        "Invitation link could not be created. The account is still saved.",
        true,
      );
      return false;
    } finally {
      setInviting(null);
    }
  }
  function togglePermissions(ids: string[]) {
    ids = ids.filter(can);
    setSelected((previous) => {
      const next = new Set(previous);
      const allSelected = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      if (!next.has("server.view")) return [];
      return grantablePermissions.filter((id) => next.has(id));
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !canSubmitRecord || !selected.every(can)) return;
    if (
      !accountEditor &&
      !deleting &&
      !resetting &&
      !selected.includes("server.view")
    ) {
      setFormError(
        "Select Can View Server to grant access, or use Revoke access to remove this person's access.",
      );
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      if (resetting) {
        await createInvitation(resetting);
        setResetting(null);
        return;
      }
      if (deleting) {
        const result = await api<{ warning?: string } | undefined>(
          `${basePath}/${encodeURIComponent(deleting.id)}`,
          { method: "DELETE" },
        );
        notify(
          result?.warning ||
            (accountsView
              ? "Panel account removed."
              : "Access to this server revoked."),
          !!result?.warning,
        );
      } else if (editing) {
        const result = await api<{ warning?: string }>(
          `${basePath}/${encodeURIComponent(editing.id)}`,
          {
            method: "PATCH",
            body: JSON.stringify(
              accountsView
                ? {
                    hostPermissions: allowServerCreation
                      ? ["server.create"]
                      : [],
                  }
                : { permissions: selected },
            ),
          },
        );
        notify(
          result.warning ||
            (accountsView
              ? "Account updated."
              : "Subuser permissions updated. Changes take effect immediately."),
          !!result.warning,
        );
      } else if (invitingAccount) {
        const result = await panelApi<Subuser | { user: Subuser }>(
          "/panel-users",
          {
            method: "POST",
            body: JSON.stringify({ email: email.trim() }),
          },
        );
        const user = "user" in result ? result.user : result;
        // The write itself confirms this identity exists. A failed follow-up
        // read must not make its new invitation look like a removed account.
        const includeAccount = (previous: Subuser[]) => [
          ...previous.filter((item) => item.id !== user.id),
          user,
        ];
        setAccounts(includeAccount);
        if (accountsView) setUsers(includeAccount);
        setEditor(null);
        // Show the saved identity even if the separate invitation request fails.
        await refresh();
        window.dispatchEvent(new Event("mc-panel-accounts-changed"));
        if (inviteOnCreate) await createInvitation(user, true);
        else
          notify(
            invitationReady
              ? "Account created with no server access. Use Create invite link when you are ready to share it."
              : "Account created with no server access. Enable Remote Access in Panel Settings to share an invitation.",
          );
        return;
      } else {
        const result = await serverApi<{ warning?: string }>("/subusers", {
          method: "POST",
          body: JSON.stringify(
            remote
              ? { email: email.trim(), permissions: selected }
              : { accountId, permissions: selected },
          ),
        });
        notify(
          result.warning || "Access granted to this server.",
          !!result.warning,
        );
      }
      setEditor(null);
      setDeleting(null);
      await refresh();
      if (accountsView)
        window.dispatchEvent(new Event("mc-panel-accounts-changed"));
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
  if (!canRead)
    return (
      <StatePanel
        variant="empty"
        title="Subusers unavailable"
        message="You do not have permission to view subusers."
      />
    );
  return (
    <div className={`subusers-page${accountsView ? " panel-users" : ""}`}>
      <header className="page-heading">
        <div>
          {accountsView ? <h3>Panel users</h3> : <h1>Subusers</h1>}
          <p className="subusers-page-description">
            {accountsView
              ? "Invite people to create an account and sign in. Invitations grant no server access."
              : "Manage access to this server. Can View Server is required; every permission below applies only to this server."}
          </p>
        </div>
        <div className="subusers-heading-actions">
          {accountsView && (
            <button
              className="btn"
              disabled={busy || !!inviting || loading}
              onClick={() => openEditor(undefined, true)}
            >
              <Plus size={16} /> Invite person
            </button>
          )}
          {!accountsView && (
            <button
              className="btn primary"
              disabled={!canCreate || busy || !!inviting || loading}
              onClick={() => openEditor()}
            >
              <Plus size={16} />
              {remote ? "New user" : "Grant server access"}
            </button>
          )}
        </div>
      </header>
      {accountsView && (
        <p className="subusers-editor-notice">
          {accessReady(accessSettings)
            ? "Remote Access is enabled. Invited people can sign in, and see only servers the host has shared with them."
            : accessSettings?.enabled && accessSettings.transport === "managed"
              ? "Wait for the trusted certificate to be ready before sharing invitation links. Existing accounts and server permissions are preserved."
              : "Enable Remote Access and configure the public panel address in Panel Settings before sharing invitation links."}
        </p>
      )}
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
            <h2>{accountsView ? "Accounts" : "Users"}</h2>
            <span>{users.length}</span>
          </div>
          <div className="subusers-controls">
            <SearchField
              className="subusers-search"
              aria-label="Search access records"
              placeholder={
                accountsView ? "Search panel users…" : "Search subusers…"
              }
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
            title={
              search
                ? "No matching people"
                : accountsView
                  ? "No panel accounts"
                  : "No subusers"
            }
            message={
              search
                ? "Try another email address."
                : accountsView
                  ? "Invite a person to create an account. Grant server access separately from that server's Subusers page."
                  : "Grant an existing account access to this server. An invitation alone does not share it."
            }
          />
        ) : (
          <table className="subusers-table">
            <thead>
              <tr>
                <th>User</th>
                <th>{accountsView ? "Account" : "Permissions"}</th>
                <th className="subuser-added">Added</th>
                <th className="subuser-row-actions">
                  <span className="subusers-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((user) => {
                const count = permissionsFor(user).length;
                const createdAt =
                  user.createdAt && Number.isFinite(Date.parse(user.createdAt))
                    ? user.createdAt
                    : null;
                return (
                  <tr key={user.id}>
                    <td>
                      <div className="subuser-identity">
                        <span className="subuser-avatar" aria-hidden="true">
                          {user.email.slice(0, 2).toUpperCase()}
                        </span>
                        <div>
                          <strong>{user.email}</strong>
                          <span>
                            {user.inviteStatus === "accepted"
                              ? "Access activated"
                              : user.inviteStatus === "pending"
                                ? "Link created · awaiting acceptance"
                                : user.inviteStatus === "expired"
                                  ? "Invitation expired · create a new link"
                                  : "Not invited"}
                          </span>
                          {accountsView && (
                            <span>
                              Server access is managed from each server’s
                              Subusers page.
                            </span>
                          )}
                          {user.accessReview && (
                            <span role="note">{user.accessReview.message}</span>
                          )}
                          {accountsView &&
                            (user.legacy || user.legacyPending) && (
                              <span>
                                Existing sign-ins keep their previous server
                                access until a panel invitation is accepted.
                              </span>
                            )}
                          {remote && user.panelAccount && (
                            <span>Managed by panel owner</span>
                          )}
                          {ownAccess(user) && (
                            <span>
                              Ask the panel owner to change your own access.
                            </span>
                          )}
                          {accountsView &&
                            (
                              user.effectiveHostPermissions ??
                              user.hostPermissions
                            )?.includes("server.create") && (
                              <span>
                                Can create and import servers on this computer
                              </span>
                            )}
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="subuser-permission-count">
                        {accountsView
                          ? "Panel sign-in"
                          : count === permissionIds.length
                            ? "All permissions"
                            : `${count} selected`}
                      </span>
                    </td>
                    <td className="subuser-added">
                      {createdAt ? (
                        <time
                          dateTime={createdAt}
                          title={new Date(createdAt).toLocaleString()}
                        >
                          {relativeTime(createdAt)}
                        </time>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="subuser-row-actions">
                      <div>
                        {(accountsView || remote) && (
                          <button
                            className="btn subuser-invite"
                            aria-label={`${user.inviteStatus === "accepted" ? "Reset access for" : "Create invite link for"} ${user.email}`}
                            title={
                              ownAccess(user)
                                ? "Ask the panel owner to reset your own access."
                                : invitationReady
                                  ? "Create a one-time link. Any previous unused link will stop working."
                                  : "Enable Remote Access in Panel Settings before creating invitation links."
                            }
                            disabled={
                              !canCreate ||
                              !manageable(user) ||
                              busy ||
                              !!inviting ||
                              !invitationReady
                            }
                            onClick={() =>
                              user.inviteStatus === "accepted"
                                ? setResetting(user)
                                : void createInvitation(user)
                            }
                          >
                            <Link size={14} />
                            {inviting === user.id
                              ? "Creating…"
                              : user.inviteStatus === "accepted"
                                ? "Reset access"
                                : "Create invite link"}
                          </button>
                        )}
                        <button
                          className="btn icon"
                          aria-label={`${accountsView ? "Edit account" : "Edit permissions"} for ${user.email}`}
                          title={
                            accountsView ? "Edit account" : "Edit permissions"
                          }
                          disabled={
                            !canUpdate ||
                            !manageable(user) ||
                            busy ||
                            !!inviting
                          }
                          onClick={() => openEditor(user)}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          className="btn icon subuser-delete"
                          aria-label={`${accountsView ? "Remove panel account" : "Remove access record"} for ${user.email}`}
                          title={
                            accountsView
                              ? "Remove panel account"
                              : "Revoke access"
                          }
                          disabled={
                            !canDelete ||
                            !manageable(user) ||
                            busy ||
                            !!inviting
                          }
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
        className={`subusers-dialog ${deleting || resetting ? "subusers-delete-dialog" : ""}`}
        aria-labelledby={`${editorId}-dialog-title`}
        onCancel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          closeDialog();
        }}
      >
        <form onSubmit={submit}>
          <header className="subusers-dialog-heading">
            <h2 id={`${editorId}-dialog-title`}>
              {deleting
                ? accountsView
                  ? "Remove panel account?"
                  : "Remove access record?"
                : resetting
                  ? "Reset subuser access?"
                  : invitingAccount
                    ? "Invite person"
                    : editing
                      ? accountsView
                        ? "Edit account"
                        : "Edit subuser permissions"
                      : remote
                        ? "Create new subuser"
                        : "Grant server access"}
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
            {resetting ? (
              <p className="subusers-delete-description">
                Reset access for <strong>{resetting.email}</strong>? Their
                current password and sessions stop working immediately. Share
                the new link so they can choose a new password. Their existing
                server grants stay the same.
              </p>
            ) : deleting ? (
              <p className="subusers-delete-description">
                {accountsView ? (
                  <>
                    Remove the panel account for{" "}
                    <strong>{deleting.email}</strong>? Their sign-in, invitation
                    links, and all server grants will be revoked.
                  </>
                ) : (
                  <>
                    Revoke access for <strong>{deleting.email}</strong> to this
                    server? Their panel account and access to other servers stay
                    the same.
                  </>
                )}
              </p>
            ) : (
              <>
                <p className="subusers-editor-notice">
                  {invitingAccount
                    ? "Create a panel account with no server access. Share an invitation to let them choose a password and sign in. Grant access separately from a server’s Subusers page."
                    : editing
                      ? accountsView
                        ? "Computer permissions are separate from access to existing servers."
                        : "Permission changes apply immediately, including to active sessions. These permissions apply only to this server."
                      : remote
                        ? "Explicitly grant this person access to this server. Creating an invitation afterward only lets them set up sign-in; it does not grant additional server access."
                        : "Choose an existing panel account and explicitly grant access to this server. No other server is shared."}
                </p>
                {editor === "grant" && !remote ? (
                  <div className="subusers-email">
                    <label htmlFor={`${editorId}-account`}>Panel account</label>
                    <select
                      id={`${editorId}-account`}
                      required
                      value={accountId}
                      disabled={busy}
                      onChange={(event) => setAccountId(event.target.value)}
                    >
                      <option value="">Choose a person</option>
                      {candidates.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.email}
                        </option>
                      ))}
                    </select>
                    {!candidates.length && (
                      <small className="subusers-email-help">
                        No accounts are waiting for access. Create one in Panel
                        Settings &gt; Remote Access &gt; Panel users.
                      </small>
                    )}
                  </div>
                ) : (
                  <div className="subusers-email">
                    <label htmlFor={`${editorId}-email`}>Email address</label>
                    <input
                      ref={emailInput}
                      id={`${editorId}-email`}
                      type="email"
                      required
                      maxLength={254}
                      placeholder="user@example.com"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      readOnly={!!editing}
                      disabled={busy}
                    />
                    {!editing && (
                      <small className="subusers-email-help">
                        Used for sign-in. You will share the invitation link
                        yourself; no email is sent.
                      </small>
                    )}
                  </div>
                )}
                {invitingAccount && (
                  <div className="subusers-invitation-choice">
                    <PermissionCheckbox
                      label="Create invitation link"
                      disabled={busy || !invitationReady}
                      description={
                        invitationReady
                          ? "Show a one-time link to copy after the account is created."
                          : "Enable Remote Access in Panel Settings before creating links. You can save the account now and invite them later."
                      }
                      checked={inviteOnCreate}
                      onChange={() => setInviteOnCreate(!inviteOnCreate)}
                    />
                    {!invitationReady && (
                      <small>
                        No invitation link can be created until remote access is
                        configured.
                      </small>
                    )}
                  </div>
                )}
                {!accountEditor && (
                  <fieldset
                    className="subusers-permissions"
                    disabled={busy || !canSubmitRecord}
                  >
                    <legend className="subusers-sr-only">
                      Server permissions
                    </legend>
                    <div className="subusers-basic-access">
                      <PermissionCheckbox
                        label="Can View Server"
                        description="Show this server in their panel. Required for all other permissions on this server."
                        checked={selected.includes("server.view")}
                        disabled={!can("server.view")}
                        onChange={() => togglePermissions(["server.view"])}
                      />
                    </div>
                    <div className="subusers-preset">
                      <div>
                        <strong>Server controls</strong>
                        <p>Start, stop, restart, and use the console.</p>
                      </div>
                      <button
                        type="button"
                        className="btn"
                        disabled={!can("server.view")}
                        onClick={() =>
                          setSelected(
                            grantablePermissions.filter(
                              (id) =>
                                id === "server.view" ||
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
                        checked={
                          grantablePermissions.length > 0 &&
                          selected.length === grantablePermissions.length
                        }
                        disabled={!can("server.view")}
                        mixed={
                          selected.length > 0 &&
                          selected.length < grantablePermissions.length
                        }
                        onChange={() => togglePermissions(grantablePermissions)}
                      />
                      <span>
                        {selected.length} / {grantablePermissions.length}
                      </span>
                    </div>
                    <div
                      className="subusers-preset"
                      role="group"
                      aria-label="Permission presets"
                    >
                      {(["admin", "operator", "viewer"] as const).map(
                        (role) => (
                          <button
                            key={role}
                            type="button"
                            className="btn"
                            disabled={!can("server.view")}
                            onClick={() =>
                              setSelected(
                                permissionIds.filter(
                                  (id) =>
                                    can(id) &&
                                    (id === "server.view" ||
                                      (
                                        catalog.roleDefaults[role] as string[]
                                      ).includes(id)),
                                ),
                              )
                            }
                          >
                            Use{" "}
                            {role === "admin"
                              ? "Admin"
                              : role === "operator"
                                ? "Operator"
                                : "Viewer"}{" "}
                            preset
                          </button>
                        ),
                      )}
                    </div>
                    <fieldset
                      className="subusers-additional-permissions"
                      disabled={!selected.includes("server.view")}
                    >
                      <legend className="subusers-sr-only">
                        Additional permissions
                      </legend>
                      <details
                        className="subusers-permission-details"
                        open={remote || undefined}
                      >
                        <summary>Customize permissions</summary>
                        {groups.map((group) => {
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
                              aria-labelledby={`${editorId}-permission-group-${group.id}`}
                            >
                              <div className="subusers-group-heading">
                                <div>
                                  <h3
                                    id={`${editorId}-permission-group-${group.id}`}
                                  >
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
                      </details>
                    </fieldset>
                  </fieldset>
                )}
                {accountsView && editing && (
                  <fieldset
                    className="subusers-permissions subusers-host-permissions"
                    disabled={busy}
                  >
                    <legend>Computer permissions</legend>
                    <PermissionCheckbox
                      label="Create and import servers"
                      description="Browse this computer’s folders, install Java and server software, and fully manage servers they add. Grant only to people you trust with this computer."
                      checked={allowServerCreation}
                      onChange={() =>
                        setAllowServerCreation(!allowServerCreation)
                      }
                    />
                  </fieldset>
                )}
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
            {!deleting && !resetting && (
              <span>
                {accountEditor
                  ? invitingAccount
                    ? "No server access is granted."
                    : "Existing server grants are preserved."
                  : `${selected.length} server ${selected.length === 1 ? "permission" : "permissions"} selected`}
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
                className={`btn ${deleting || resetting ? "danger" : "primary"}`}
                disabled={busy || !canSubmitRecord}
              >
                {busy
                  ? "Saving…"
                  : deleting
                    ? accountsView
                      ? "Remove account"
                      : "Revoke access"
                    : resetting
                      ? "Reset and create link"
                      : invitingAccount
                        ? "Create account"
                        : editing
                          ? accountsView
                            ? "Save account"
                            : "Save permissions"
                          : remote
                            ? "Create subuser"
                            : "Grant access"}
              </button>
            </div>
          </footer>
        </form>
      </dialog>
      {invitation && (
        <InvitationDialog
          invitation={invitation}
          panelWide={invitation.panelWide === true}
          onClose={() => setInvitation(null)}
        />
      )}
    </div>
  );
}
