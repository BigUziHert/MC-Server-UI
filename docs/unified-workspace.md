# Shared desktop and browser workspace

The renderer remains at its original workspace origin in both desktop and browser. `DesktopWorkspace` owns the combined roster and the `{panelId, serverId}` selection. `ServerWorkspace` and existing feature pages receive an immutable panel/session context and server scope. The same account menu, connection manager, selector, setup dialogs, and server pages serve both runtimes.

## Trust and request boundaries

- Electron owns saved connection IDs, normalized HTTPS origins, certificate trust, encrypted session tokens, live permission rosters, and session epochs. IPC admits only the trusted local main frame.
- Renderer requests use the local owner-authenticated streaming route `/api/desktop/panels/:panelId/proxy/api/...`, with captured `desktopEpoch` and `serverId`. They cannot choose an arbitrary remote URL or provide the remote credential.
- The broker resolves the saved destination, rejects stale epochs and unavailable/signed-out panels, requires current server membership or the separate host-creation grant, and lets the host enforce each operation's permission. It strips renderer credentials and injects the destination panel's bearer credential. Redirects and active document responses are rejected.
- Multipart uploads and downloads stream through the bridge. Downloads are saved on the client computer. Changing selection cannot redirect a pending request or its follow-up operation to the new server.
- Sign-out, expired sessions, and Forget invalidate only that connection's epoch and client transports. Cached rosters contain bounded display fields, never permissions, launch settings, or filesystem paths. They cannot enable operations before successful session and roster revalidation.
- A host-proved `accessRevoked` response removes the saved connection and certificate trust only for the session that received it. Hosts retain bounded, expiring hashes of revoked bearer credentials so clients can distinguish account removal from expiration or a temporary outage. A normal guest response or empty server roster never proves revocation. Pending Forget requests retain their original proof until their receipt is confirmed.

## Browser transport

`src/browser-connections.ts` installs the same connection bridge interface when no native bridge exists. The browser controller in `shared/browser-connections.mjs` saves origin-bound bearer sessions, bounded display rosters, the selected tuple, and pending account-removal proofs in workspace-origin local storage. Passwords are never saved. Web Locks serialize changes across tabs where supported; revision and session-epoch checks invalidate stale requests and streams. Desktop retains its separate main-process and encrypted-storage boundary; browser storage has the browser origin's usual security boundary.

The shared API hooks emit the same scoped resource descriptors in either runtime. Browser transport resolves them to an exact saved HTTPS origin, supplies that panel's credential, rejects redirects, and omits cookies. Remote gateways admit marked browser requests through a narrow CORS policy while retaining bearer permissions, host validation, and remote-only routing. Local owner APIs are never exposed through this CORS path. The browser only creates a local administrator entry after its own hosting API explicitly confirms owner access. A guest or subuser visiting a remote panel cannot inherit local owner controls.

Uploads use the selected host's direct API. Icons are authenticated, bounded PNG blobs. Downloads obtain a short-lived single-use ticket from the selected host, validate its origin and complete resource query, and let the browser stream the file. Credentials never enter these URLs. Browser TLS trust stays with the browser; Electron certificate prompts and saved fingerprint trust are native capabilities.

Browser connections and desktop connections have independent session stores. Update both the workspace assets and destination hosts to use cross-panel browser connections. Native startup, tray, and update controls depend on the actual host's capabilities; the common server and account interface does not depend on the runtime.

## Workspace state

Server selection persists as the panel/server tuple. Remote Properties drafts and transfer/recovery state belong to a panel session; identical server IDs on other computers cannot reuse them. Signing out clears only that session's state. Remote Launchpad preferences include stable panel, account, and server identity. App settings, desktop updates, and startup remain local.

The connection manager stays open when its selected server's account is signed out. Adding a panel or accepting an invitation uses a dialog in the same document. Setup asks for a destination when more than one computer is eligible; local creation requires no remote grant.

Signed-out saved addresses can be removed locally without signing back in. This action checks the captured session epoch and rejects a changed sign-in or pending Forget request; it never claims to remove the host account. This also lets users clear addresses left behind by older hosts or desktops before revocation notifications were supported.

## Verification

`tests/unified-workspace.spec.ts` exercises the full React workspace with local Computer B and remote A/C, colliding IDs/names, host-specific actions, Properties drafts, permission changes, and offline recovery. `tests/unified-connections.spec.ts` exercises independent sign-in/out, Forget, Retry, and invitations. `tests/unified-transport.spec.ts` checks delayed chained operations, session replacement, multipart requests, resource URLs, and downloads through the actual scoped client hooks.

Desktop broker/store tests and the native unified smoke cover the main-process boundary and session persistence using disposable data. `desktop/unified-hosts.test.mjs` also routes through two real, independent host APIs with colliding server IDs: it verifies filesystem effects, downloads, immediate permission revocation, separate computer creation grants, remote imports, and independent sign-out. Its network adapter uses loopback HTTP; the native smoke separately verifies actual Electron HTTPS, certificate trust, streaming transfers, and restart persistence.

`tests/browser-workspace.spec.ts` exercises the real browser adapter and shared React UI, including owner/member distinctions, invitations, multiple panels, creation grants, independent sign-out, and revocation. `tests/browser-transport.spec.ts` connects the browser to two independent HTTPS host APIs with colliding server IDs and verifies uploads, authenticated icons, one-use downloads, CORS, token isolation, session restoration, and revocation. Only that disposable fixture bypasses certificate errors. `server/browser-connections.test.mjs` covers persistence and session races; `server/remote-cors.test.mjs` checks the gateway's browser request boundary.

Loopback hosts simulate separate computers; they do not constitute testing on three physical computers or an external network. Real firewall/NAT configuration, long WAN interruptions, and OS trust behavior on another user's machine still need release validation.

Desktop upgrades migrate saved addresses and certificate fingerprints from the former separate-view connection store. Old renderer-local credentials are not copied into Electron's trusted workspace; that desktop upgrade requires one sign-in per saved panel. Browser upgrades migrate their existing same-origin bearer and local server choice after live validation. No passwords are persisted.
