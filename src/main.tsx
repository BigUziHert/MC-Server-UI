import React from "react";
import ReactDOM from "react-dom/client";
import RemoteAccess from "./RemoteAccess";
import { DesktopUpdatesWindow } from "./DesktopUpdates";
import "./styles.css";
import { initializeDesktopPreferences } from "./preferences";
void initializeDesktopPreferences().then(() =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {new URLSearchParams(window.location.search).get("app-updates") ===
      "1" ? (
        <DesktopUpdatesWindow />
      ) : (
        <RemoteAccess />
      )}
    </React.StrictMode>,
  ),
);
