import { useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { Copy, X } from "lucide-react";
import { ServerScope, usePanelApi, useServerApi, type PageProps } from "../api";
import { copyText } from "../clipboard";
import catalog from "../../shared/subuser-permissions.json";

export type PeopleSnapshot = {
  panelName?: string;
  servers: { id: string; name: string }[];
  users: {
    id: string;
    email: string;
    serverIds?: string[];
    serverOverrides?: Record<string, { permissions: string[] }>;
  }[];
};

export default function ServerShareDialog({
  onClose,
  onShared,
  permissions,
  notify,
}: PageProps & {
  onClose: () => void;
  onShared: () => void;
  permissions?: string[];
}) {
  const serverId = useContext(ServerScope);
  const { api: panelApi } = usePanelApi();
  const { api: serverApi } = useServerApi();
  const dialog = useRef<HTMLDialogElement>(null);
  const [people, setPeople] = useState<PeopleSnapshot | null>(null);
  const [email, setEmail] = useState("");
  const [selected, setSelected] = useState<string[]>(
    serverId ? [serverId] : [],
  );
  const [role, setRole] = useState("viewer");
  const [copyFrom, setCopyFrom] = useState("");
  const [expiresInHours, setExpiry] = useState(24);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{
    invitationUrl?: string;
    inviteExpiresAt?: string;
    alreadyActive?: boolean;
    servers: { id: string; name: string }[];
  } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const copiedAccount = people?.users.find((person) => person.id === copyFrom);
  const chosenPermissions = (
    role === "status"
      ? ["server.view"]
      : (catalog.roleDefaults[
          role as keyof typeof catalog.roleDefaults
        ] as string[])
  ).filter(
    (id) =>
      id !== "backup.location" && (!permissions || permissions.includes(id)),
  );
  const permissionsForServer = (id: string) =>
    copiedAccount
      ? (
          copiedAccount.serverOverrides?.[id]?.permissions ?? ["server.view"]
        ).filter((permission) => permission !== "backup.location")
      : chosenPermissions;
  const allPermissions = [...new Set(selected.flatMap(permissionsForServer))];
  const codeAccess =
    allPermissions.some((id) => ["file.create", "file.update"].includes(id)) &&
    allPermissions.some((id) =>
      ["control.start", "control.restart"].includes(id),
    );
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (permissions) return;
    const controller = new AbortController();
    void panelApi<PeopleSnapshot>("/access/people", {
      signal: controller.signal,
    })
      .then(setPeople)
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message);
      });
    return () => controller.abort();
  }, [panelApi, permissions]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !selected.length || (codeAccess && !acknowledged)) return;
    setBusy(true);
    setError("");
    try {
      const response = await (permissions ? serverApi : panelApi)<
        typeof result & { warning?: string }
      >(permissions ? "/subusers/share" : "/access/share", {
        method: "POST",
        body: JSON.stringify(
          permissions
            ? {
                email,
                permissions: chosenPermissions,
                invite: true,
                expiresInHours,
              }
            : {
                email,
                grants: selected.map((serverId) => ({
                  serverId,
                  permissions: permissionsForServer(serverId),
                })),
                invite: true,
                expiresInHours,
              },
        ),
      });
      setResult(response);
      onShared();
      notify(
        response?.warning || "Server access shared.",
        Boolean(response?.warning),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to share these servers.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="subusers-dialog"
      aria-labelledby="share-server-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="subusers-dialog-heading">
        <h2 id="share-server-title">Share server access</h2>
        <button
          className="btn icon"
          aria-label="Close sharing"
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <form onSubmit={submit}>
        <div className="subusers-editor-body">
          {result ? (
            <>
              <p>
                Access shared with <strong>{email}</strong> to{" "}
                {result.servers.map((server) => server.name).join(", ")}.
              </p>
              {result.invitationUrl ? (
                <>
                  <label htmlFor="share-invitation-url">Invitation link</label>
                  <textarea
                    id="share-invitation-url"
                    readOnly
                    rows={4}
                    value={result.invitationUrl}
                    onFocus={(event) => event.target.select()}
                  />
                  <p>
                    Expires {new Date(result.inviteExpiresAt!).toLocaleString()}
                    . Share this link privately.
                  </p>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void copyText(result.invitationUrl!)
                        .then(() => notify("Invitation copied."))
                        .catch(() =>
                          setError(
                            "Select and copy the invitation link manually.",
                          ),
                        )
                    }
                  >
                    <Copy size={16} /> Copy link
                  </button>
                </>
              ) : (
                <p>
                  This person already has an active account. Their password is
                  unchanged; they can sign in to see the shared servers.
                </p>
              )}
              <p>
                Panel access and permission to join Minecraft are separate. Add
                their Minecraft name to the whitelist from Players if this
                server uses one.
              </p>
            </>
          ) : (
            <>
              <p>
                {people?.panelName
                  ? `Share servers on ${people.panelName}. `
                  : ""}
                Choose an existing person or enter a new email address. Their
                account and all selected server grants are saved together.
              </p>
              <label htmlFor="share-person">Email address</label>
              <input
                id="share-person"
                type="email"
                required
                maxLength={254}
                autoFocus
                list="share-existing-people"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={busy}
              />
              <datalist id="share-existing-people">
                {people?.users.map((person) => (
                  <option key={person.id} value={person.email} />
                ))}
              </datalist>
              {!permissions && (
                <fieldset disabled={busy || !people}>
                  <legend>Servers to share</legend>
                  {people?.servers.map((server) => (
                    <label key={server.id} className="subusers-clean-confirm">
                      <input
                        type="checkbox"
                        checked={selected.includes(server.id)}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked
                              ? [...selected, server.id]
                              : selected.filter((id) => id !== server.id),
                          )
                        }
                      />{" "}
                      {server.name}
                    </label>
                  ))}
                </fieldset>
              )}
              {!permissions && (
                <>
                  <label htmlFor="share-copy">Copy existing access</label>
                  <select
                    id="share-copy"
                    value={copyFrom}
                    onChange={(event) => {
                      setCopyFrom(event.target.value);
                      setAcknowledged(false);
                      const source = people?.users.find(
                        (person) => person.id === event.target.value,
                      );
                      if (source)
                        setSelected(
                          (source.serverIds ?? []).filter((id) =>
                            people?.servers.some((server) => server.id === id),
                          ),
                        );
                    }}
                  >
                    <option value="">Use permission preset</option>
                    {people?.users.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.email}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <label htmlFor="share-role">Permissions</label>
              <select
                id="share-role"
                value={role}
                disabled={busy || !!copyFrom}
                onChange={(event) => {
                  setRole(event.target.value);
                  setAcknowledged(false);
                }}
              >
                <option value="status">Status only</option>
                <option value="viewer">Read files and backups</option>
                <option value="operator">Manage mods and server</option>
                <option value="admin">Server admin (can invite people)</option>
              </select>
              <p>
                {allPermissions.length} permissions across selected servers.
                Host folder browsing is reserved for the computer owner.
              </p>
              {codeAccess && (
                <label>
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(event) => setAcknowledged(event.target.checked)}
                    required
                  />{" "}
                  I trust this person with this computer: uploading code and
                  starting the server can run programs with the host user's
                  access.
                </label>
              )}
              <label htmlFor="share-expiry">Invitation expires after</label>
              <select
                id="share-expiry"
                value={expiresInHours}
                onChange={(event) => setExpiry(Number(event.target.value))}
                disabled={busy}
              >
                <option value={1}>1 hour</option>
                <option value={24}>1 day</option>
                <option value={168}>7 days</option>
              </select>
            </>
          )}
          {error && (
            <p role="alert" className="subusers-form-error">
              {error}
            </p>
          )}
        </div>
        <footer className="subusers-dialog-actions">
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
          >
            {result ? "Done" : "Cancel"}
          </button>
          {!result && (
            <button
              className="btn primary"
              disabled={
                busy || !selected.length || (codeAccess && !acknowledged)
              }
            >
              {busy ? "Sharing…" : "Share and create invitation"}
            </button>
          )}
        </footer>
      </form>
    </dialog>
  );
}
