import React from "react";
import ReactDOM from "react-dom/client";
import RemoteAccess from "./RemoteAccess";
import "./styles.css";
import { initializeDesktopPreferences } from "./preferences";
void initializeDesktopPreferences().then(() =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <RemoteAccess />
    </React.StrictMode>,
  ),
);
