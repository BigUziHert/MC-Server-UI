# Unified desktop workspace

The desktop renderer always remains at its local runtime origin. `DesktopWorkspace` owns the combined roster and the `{panelId, serverId}` selection. `ServerWorkspace` and existing feature pages receive an immutable panel/session context and server scope. Browser panels retain their existing single-host behavior.

## Trust and request boundaries

- Electron owns saved connection IDs, normalized HTTPS origins, certificate trust, encrypted session tokens, live permission rosters, and session epochs. IPC admits only the trusted local main frame.
- Renderer requests use the local owner-authenticated streaming route `/api/desktop/panels/:panelId/proxy/api/...`, with captured `desktopEpoch` and `serverId`. They cannot choose an arbitrary remote URL or provide the remote credential.
- The broker resolves the saved destination, rejects stale epochs and unavailable/signed-out panels, requires current server membership or the separate host-creation grant, and lets the host enforce each operation's permission. It strips renderer credentials and injects the destination panel's bearer credential. Redirects and active document responses are rejected.
- Multipart uploads and downloads stream through the bridge. Downloads are saved on the client computer. Changing selection cannot redirect a pending request or its follow-up operation to the new server.
- Sign-out, expired sessions, and Forget invalidate only that connection's epoch and client transports. Cached rosters contain bounded display fields, never permissions, launch settings, or filesystem paths. They cannot enable operations before successful session and roster revalidation.

## Workspace state

Server selection persists as the panel/server tuple. Remote Properties drafts and transfer/recovery state belong to a panel session; identical server IDs on other computers cannot reuse them. Signing out clears only that session's state. Remote Launchpad preferences include stable panel, account, and server identity. App settings, desktop updates, and startup remain local.

The connection manager stays open when its selected server's account is signed out. Adding a panel or accepting an invitation uses a dialog in the same document. Setup asks for a destination when more than one computer is eligible; local creation requires no remote grant.

## Verification

`tests/unified-workspace.spec.ts` exercises the full React workspace with local Computer B and remote A/C, colliding IDs/names, host-specific actions, Properties drafts, permission changes, and offline recovery. `tests/unified-connections.spec.ts` exercises independent sign-in/out, Forget, Retry, and invitations. `tests/unified-transport.spec.ts` checks delayed chained operations, session replacement, multipart requests, resource URLs, and downloads through the actual scoped client hooks.

Desktop broker/store tests and the native unified smoke cover the main-process boundary and session persistence using disposable data. `desktop/unified-hosts.test.mjs` also routes through two real, independent host APIs with colliding server IDs: it verifies filesystem effects, downloads, immediate permission revocation, separate computer creation grants, remote imports, and independent sign-out. Its network adapter uses loopback HTTP; the native smoke separately verifies actual Electron HTTPS, certificate trust, streaming transfers, and restart persistence.

Loopback hosts simulate separate computers; they do not constitute testing on three physical computers or an external network. Real firewall/NAT configuration, long WAN interruptions, and OS trust behavior on another user's machine still need release validation.

Existing saved addresses and certificate fingerprints migrate from the former separate-view connection store. Old renderer-local credentials are not copied into the trusted workspace; upgrading requires one sign-in per saved panel. No passwords are persisted.
