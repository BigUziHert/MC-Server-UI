export const browserConnectionsKey: string;
export type BrowserIdentity = {
  role: "subuser";
  email: string;
  userId: string;
  accountId?: string;
  serverId: string | null;
  permissions: string[];
  hostPermissions: string[];
};
export type BrowserPanel = {
  id: string;
  label: string;
  origin: string;
  local: boolean;
  signedIn: boolean;
  connectionState: "connected" | "unavailable" | "connecting";
  sessionEpoch: string;
  session?: BrowserIdentity;
  pendingLeave?: boolean;
  servers: any[];
  error?: string;
};
export type BrowserSnapshot = {
  runtime: "browser";
  unified: true;
  ready: boolean;
  error?: string;
  selectedServer: { panelId: string; serverId: string } | null;
  activeId?: string;
  localServers: any[];
  panels: BrowserPanel[];
};
export type BrowserBridge = {
  runtime: "browser";
  unified: true;
  list(): Promise<BrowserSnapshot>;
  open(url: string): Promise<BrowserSnapshot>;
  signIn(
    id: string,
    input: { email: string; password: string },
  ): Promise<BrowserSnapshot>;
  acceptInvitation(
    id: string,
    input: { token: string; password: string },
  ): Promise<BrowserSnapshot>;
  signOut(id: string): Promise<BrowserSnapshot>;
  retry(id: string): Promise<BrowserSnapshot>;
  forget(id: string, accountId?: string): Promise<BrowserSnapshot>;
  removeSavedConnection(id: string, epoch: string): Promise<BrowserSnapshot>;
  selectServer(id: string, serverId: string | null): Promise<BrowserSnapshot>;
  activate(id: string): Promise<BrowserSnapshot>;
  disconnect(id: string): Promise<BrowserSnapshot>;
  selectLocalServer(id: string): Promise<BrowserSnapshot>;
  selectRemoteServer(id: string, serverId: string): Promise<BrowserSnapshot>;
  reportServers(servers?: unknown): Promise<void>;
  flush(): Promise<unknown>;
};
export function browserSession(value: unknown): BrowserIdentity;
export function browserRoster(value: unknown, live?: boolean): any[];
export function createBrowserConnectionController(options: {
  origin: string;
  storage: Pick<Storage, "getItem" | "setItem">;
  fetch: typeof fetch;
  legacyToken?: () => string | null;
  legacySelection?: () => string | null;
  homeCredential?: (token: string | null) => void;
  changed?: () => void;
  newId?: () => string;
  lock?: <T>(operation: () => Promise<T>) => Promise<T>;
  pollMs?: number;
}): {
  bridge: BrowserBridge;
  initialize(): Promise<BrowserSnapshot>;
  fetch(input: string, options?: RequestInit): Promise<Response>;
  download(input: string): Promise<string>;
  storageChanged(): void;
  close(): Promise<void>;
};
