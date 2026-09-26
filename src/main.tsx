import React from "react";
import ReactDOM from "react-dom/client";
import RemoteAccess from "./RemoteAccess";
import { DesktopUpdatesOverlay } from "./DesktopUpdates";
import "./styles.css";
import { initializeDesktopPreferences } from "./preferences";
const updatesOverlay =
  new URLSearchParams(window.location.search).get("app-updates") === "1";
if (updatesOverlay) document.documentElement.classList.add("updates-overlay");
void initializeDesktopPreferences().then(() =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {updatesOverlay ? <DesktopUpdatesOverlay /> : <RemoteAccess />}
    </React.StrictMode>,
  ),
);
