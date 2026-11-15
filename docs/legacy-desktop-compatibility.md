# Older desktop frontend compatibility

Current desktop and browser sessions use the unified workspace. Older released desktop shells can still load a connected host's current frontend with the legacy bridge. Removing that bridge's frontend would break those installed clients.

This is verified in release tag `v0.1.3-dev.52.1`: `desktop/main.mjs` constructs `createRemotePanelController` without `remoteFrontend`, and its controller loads the remote host URL. The review's prerequisite for deleting all compatibility paths therefore does not hold.

`src/ConnectPanel.tsx` is the explicit routing boundary. Current sessions use `WorkspaceConnectPanel`; the old host-served path lives in `src/compat/LegacyConnectPanel.tsx`. `LegacyHostedPanelApp` in `src/App.tsx` is named for the same compatibility purpose. Its shared workspace components remain in App to avoid duplicating server management logic.

Legacy local deletion is labelled **Remove from this device**. Unified **Leave this panel** explicitly removes the account on the host; it is separate from local removal. Do not reuse one action for the other.

Retain the non-unified account/connection branches, legacy preload/controller and their tests until support for those released clients is deliberately retired. New features belong in the unified workspace. The old open endpoint exists only for that compatibility bridge.
