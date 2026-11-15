import { createContext, useContext, useEffect, useState } from "react";
import { PanelScope } from "./api";

export const SetupAccountContext = createContext("local-owner");
const key = "mc-panel.setup-drafts.v1";
const changed = "mc-panel-setup-drafts-changed";
const lifetime = 7 * 24 * 60 * 60 * 1000;
export type SetupDraft = {
  id: string;
  scope: string;
  createdAt: number;
  name: string;
  serverId?: string;
  serverDir?: string;
  state: unknown;
};

function allDrafts(): SetupDraft[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is SetupDraft =>
          item &&
          typeof item.id === "string" &&
          typeof item.scope === "string" &&
          typeof item.name === "string" &&
          typeof item.createdAt === "number" &&
          item.createdAt <= Date.now() &&
          Date.now() - item.createdAt < lifetime &&
          item.state &&
          typeof item.state === "object",
      )
      .slice(-20);
  } catch {
    return [];
  }
}
export function readSetupDrafts(scope: string) {
  return allDrafts().filter((item) => item.scope === scope);
}
export function saveSetupDraft(draft: SetupDraft) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify(
        [
          ...allDrafts().filter(
            (item) => item.id !== draft.id || item.scope !== draft.scope,
          ),
          draft,
        ].slice(-20),
      ),
    );
    window.dispatchEvent(new Event(changed));
    return true;
  } catch {
    return false;
  }
}
export function removeSetupDraft(scope: string, id: string) {
  try {
    localStorage.setItem(
      key,
      JSON.stringify(
        allDrafts().filter((item) => item.id !== id || item.scope !== scope),
      ),
    );
    window.dispatchEvent(new Event(changed));
  } catch {
    /* A storage failure must not interrupt an installed server. */
  }
}
export function useSetupScope() {
  const panel = useContext(PanelScope);
  const account = useContext(SetupAccountContext);
  return JSON.stringify([
    panel?.origin || window.location.origin,
    panel?.accountId || account,
  ]);
}
export function useSetupDrafts() {
  const scope = useSetupScope();
  const [drafts, setDrafts] = useState(() => readSetupDrafts(scope));
  useEffect(() => {
    const refresh = () => setDrafts(readSetupDrafts(scope));
    refresh();
    window.addEventListener(changed, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(changed, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [scope]);
  return { scope, drafts };
}

export function UnfinishedSetupNotice({
  serverId,
  onResume,
}: {
  serverId: string;
  onResume: () => void;
}) {
  const { drafts } = useSetupDrafts();
  const draft = drafts.find((item) => item.serverId === serverId);
  if (!draft) return null;
  return (
    <div className="management-notice warning" role="status">
      <div>
        <strong>Setup is not finished</strong>
        <p>
          Resume the saved installation before starting this server. The setup
          draft stays on this device for seven days.
        </p>
        <button className="btn" onClick={onResume}>
          Finish setup
        </button>
      </div>
    </div>
  );
}
