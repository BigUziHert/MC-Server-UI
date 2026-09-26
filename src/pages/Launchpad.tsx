import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Download,
  FileCode2,
  Info,
  KeyRound,
  Layers3,
  LoaderCircle,
  Package,
  Puzzle,
  RefreshCw,
  SlidersHorizontal,
  ExternalLink,
  Trash2,
  X,
} from "lucide-react";
import {
  formatBytes,
  messageOf,
  ServerScope,
  useServerApi,
  type PageProps,
} from "../api";
import { canChangeContent } from "../page-permissions";
import SearchField, { useDebouncedValue } from "../SearchField";
import RefreshButton from "../RefreshButton";
import StatePanel from "../StatePanel";
import Pagination from "../Pagination";
import Switch from "../Switch";
import { readPreference, writePreference } from "../preferences";
import { projectPageUrl } from "../../shared/launchpad-project.mjs";
import "./management.css";
import "./launchpad.css";

type ContentType = "modpack" | "mod" | "datapack" | "plugin";
type Platform = {
  id: string;
  name: string;
  available: boolean;
  reason?: string;
  types: ContentType[];
  requiresKey?: boolean;
  keyConfigured?: boolean;
  sortOptions?: { id: string; label: string }[];
};
type Version = {
  id: string;
  name: string;
  version: string;
  gameVersions: string[];
  loaders: string[];
  publishedAt: string;
  downloadable: boolean;
};
type Project = {
  id: string;
  platform: string;
  title: string;
  description: string;
  iconUrl?: string | null;
  downloads?: number;
  author?: string;
  url?: string;
};
type InstalledItem = {
  path: string;
  sha512?: string;
  name: string;
  size: number;
  platform: string | null;
  projectId?: string;
  versionId?: string;
  versionName?: string;
  title?: string;
  iconUrl?: string;
  author?: string;
  update?: Version | null;
  url?: string;
  updateCheck?: "checked" | "unavailable" | "pending";
  updateIssue?: string;
};
type Job = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  message: string;
  completed: number;
  total: number;
  error?: string;
  retryable?: boolean;
  retryInput?: {
    planId: string;
    confirmed: true;
    cleanInstall?: true;
    acknowledgedUnavailableDependencies?: true;
  };
  recoveryEntries?: unknown[];
};
type Config = {
  platforms: Platform[];
  gameVersion: string | null;
  loader: string | null;
  status: string;
  gameVersions?: string[];
  loaders?: string[];
  warnings: string[];
  job?: Job | null;
};
type SearchResult = {
  projects: Project[];
  total: number;
  offset: number;
  limit: number;
  warnings?: string[];
};
type InstalledResult = {
  items: InstalledItem[];
  warnings: string[];
  checkingUpdates?: boolean;
  progress?: { completed: number; total: number };
};
function pendingInventory(result: InstalledResult): InstalledResult {
  return {
    ...result,
    warnings: [],
    checkingUpdates: false,
    progress: undefined,
    items: result.items.map((item) => ({
      ...item,
      update: null,
      updateIssue: undefined,
      updateCheck: item.platform && item.projectId ? "pending" : undefined,
    })),
  };
}
function mergeLocalInventory(
  local: InstalledResult,
  previous?: InstalledResult,
): InstalledResult {
  const known = new Map(previous?.items.map((item) => [item.path, item]));
  return {
    ...local,
    items: local.items.map((item) => {
      const old = known.get(item.path);
      if (!old || !item.sha512 || item.sha512 !== old.sha512) return item;
      return {
        ...item,
        platform: old.platform || item.platform,
        projectId: old.projectId ?? item.projectId,
        versionId: old.versionId ?? item.versionId,
        versionName: old.versionName ?? item.versionName,
        title: old.title ?? item.title,
        iconUrl: old.iconUrl ?? item.iconUrl,
        author: old.author ?? item.author,
        url: old.url ?? item.url,
        update: old.update !== undefined ? old.update : item.update,
        updateCheck: old.updateCheck ?? item.updateCheck,
        updateIssue: old.updateIssue ?? item.updateIssue,
      };
    }),
  };
}
type Plan = {
  planId: string;
  title: string;
  versionName: string;
  expiresAt: string;
  files: {
    path: string;
    size: number;
    action: "install" | "replace";
    previousPath?: string;
  }[];
  warnings: string[];
  cleanInstall?: boolean;
  hasExistingContent?: boolean;
  summary?: { fileCount: number; totalBytes: number };
  runtime?: {
    provider: string;
    version: string;
    build: string;
    software: string;
  };
  unavailableDependencies?: {
    platform: string;
    projectId?: string;
    versionId?: string | null;
    requiredBy: string;
    issue?: string;
  }[];
  bundledDependencies?: {
    title: string;
    version?: string;
    path: string;
    bundledWith: string;
    serverCompatible?: boolean;
  }[];
};
type Selection = {
  project: Project;
  installed?: InstalledItem;
  bulk?: boolean;
};
type RemovalPlan = {
  planId?: string;
  title: string;
  files: { path: string; size: number }[];
  dependents: { path: string; title: string }[];
  warnings: string[];
  blocked: boolean;
  requiresAcknowledgement?: boolean;
  expiresAt?: string;
};
const kinds = [
  { id: "modpack", label: "Modpacks", icon: Layers3 },
  { id: "mod", label: "Mods", icon: Puzzle },
  { id: "datapack", label: "Datapacks", icon: FileCode2 },
  { id: "plugin", label: "Plugins", icon: Package },
] as const;
const rowsOptions = [5, 10, 25, 50, 75, 100];
const installedSortOptions = [
  { id: "updates", label: "Updates first" },
  { id: "name", label: "Name (A–Z)" },
  { id: "size", label: "Size (largest first)" },
  { id: "author", label: "Mod author (A–Z)" },
] as const;
type InstalledSort = (typeof installedSortOptions)[number]["id"];
type SavedView = {
  platform?: string;
  type?: ContentType;
  gameVersion?: string;
  loader?: string;
  installedOnly?: boolean;
  sort?: string;
  installedSort?: InstalledSort;
};
function readSavedView(key: string): SavedView {
  try {
    const raw = readPreference(key, "session");
    if (!raw || raw.length > 4096) return {};
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    const values = saved as Record<string, unknown>;
    return {
      platform:
        typeof values.platform === "string" ? values.platform : undefined,
      type: kinds.some((kind) => kind.id === values.type)
        ? (values.type as ContentType)
        : undefined,
      gameVersion:
        typeof values.gameVersion === "string" &&
        (values.gameVersion === "" ||
          /^\d+(?:\.\d+)+$/.test(values.gameVersion))
          ? values.gameVersion
          : undefined,
      loader: typeof values.loader === "string" ? values.loader : undefined,
      installedOnly:
        typeof values.installedOnly === "boolean"
          ? values.installedOnly
          : undefined,
      sort: typeof values.sort === "string" ? values.sort : undefined,
      installedSort: installedSortOptions.some(
        (item) => item.id === values.installedSort,
      )
        ? (values.installedSort as InstalledSort)
        : undefined,
    };
  } catch {
    return {};
  }
}
function compareInstalled(
  a: InstalledItem,
  b: InstalledItem,
  sort: InstalledSort,
) {
  const alphabetical = (left: string, right: string) =>
    left.localeCompare(right, undefined, {
      sensitivity: "base",
      numeric: true,
    });
  let order = 0;
  if (sort === "updates") {
    order = Number(Boolean(b.update)) - Number(Boolean(a.update));
  } else if (sort === "size") {
    const size = (item: InstalledItem) =>
      Number.isFinite(item.size) && item.size >= 0 ? item.size : -1;
    order = size(b) - size(a);
  } else if (sort === "author") {
    const left = a.author?.trim() ?? "";
    const right = b.author?.trim() ?? "";
    order = Number(!left) - Number(!right) || alphabetical(left, right);
  }
  return (
    order ||
    alphabetical(a.title?.trim() || a.name, b.title?.trim() || b.name) ||
    a.path.localeCompare(b.path)
  );
}
function updateCheckLabel(
  entry: InstalledItem,
  enabled: boolean,
  refreshing: boolean,
) {
  if (!enabled || !entry.platform || !entry.projectId) return null;
  if (entry.updateCheck === "unavailable") return "Update check unavailable";
  if (entry.updateCheck === "pending")
    return refreshing ? "Checking updates…" : "Update check unavailable";
  if (entry.updateCheck === "checked" && !entry.update) return "Up to date";
  return null;
}
const modLoaders = ["fabric", "forge", "neoforge", "quilt"];
const pluginLoaders = [
  "paper",
  "purpur",
  "spigot",
  "bukkit",
  "folia",
  "velocity",
  "waterfall",
  "bungeecord",
];
const loadersFor = (type: ContentType) =>
  type === "datapack"
    ? ["datapack"]
    : type === "plugin"
      ? pluginLoaders
      : modLoaders;
const loaderNames: Record<string, string> = {
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
  quilt: "Quilt",
  paper: "Paper",
  purpur: "Purpur",
  spigot: "Spigot",
  bukkit: "Bukkit",
  folia: "Folia",
  velocity: "Velocity",
  waterfall: "Waterfall",
  bungeecord: "BungeeCord",
  sponge: "Sponge",
  datapack: "Datapack",
};
const loaderName = (value: string) => loaderNames[value] ?? value;
const queryString = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
};
export function ProjectIcon({ url }: { url?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  const safe = url && /^https:\/\//i.test(url) ? url : null;
  return (
    <span className="launchpad-project-icon">
      {safe && failed !== safe ? (
        <img
          src={safe}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(safe)}
        />
      ) : (
        <Package size={29} aria-hidden="true" />
      )}
    </span>
  );
}

export default function Launchpad({
  notify,
  permissions,
}: PageProps & { permissions?: string[] }) {
  const allowChanges = canChangeContent(permissions);
  const { api, post } = useServerApi();
  const serverId = useContext(ServerScope);
  const viewKey = `mc-panel.launchpad.view.${serverId ?? "default"}`;
  const [viewReady, setViewReady] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState("");
  const [configLoading, setConfigLoading] = useState(true);
  const [platform, setPlatform] = useState("modrinth");
  const [type, setType] = useState<ContentType>("modpack");
  const [gameVersion, setGameVersion] = useState("");
  const [loader, setLoader] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [statusStale, setStatusStale] = useState(false);
  const [query, setQuery] = useState("");
  const filteredQuery = useDebouncedValue(query);
  const [sort, setSort] = useState("downloads");
  const [installedSort, setInstalledSort] = useState<InstalledSort>("updates");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(() => {
    try {
      const saved = Number(readPreference("mc-panel.launchpad.rows"));
      return rowsOptions.includes(saved) ? saved : 10;
    } catch {
      return 10;
    }
  });
  const [results, setResults] = useState<SearchResult | null>(null);
  const resultsScope = useRef("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const loaders = loadersFor(type).filter(
    (value) => !config?.loaders || config.loaders.includes(value),
  );
  // Installed updates and individual content installs target this server, even
  // when catalog filters are set to another Minecraft version or loader.
  const contentGameVersion =
    config?.gameVersion && /^\d+(?:\.\d+)+$/.test(config.gameVersion)
      ? config.gameVersion
      : gameVersion.trim();
  const contentLoader =
    config?.loader && loaders.includes(config.loader)
      ? config.loader
      : type === "datapack"
        ? "datapack"
        : loader;
  const inventoryScope = JSON.stringify([
    type,
    contentGameVersion,
    contentLoader,
  ]);
  const [inventory, setInventory] = useState<{
    api: typeof api;
    scope: string;
    type: ContentType;
    result: InstalledResult;
  } | null>(null);
  const inventoryRef = useRef<typeof inventory>(null);
  const inventoryCache = useRef(
    new Map<ContentType, NonNullable<typeof inventory>>(),
  );
  const visibleInventory =
    inventory?.api === api && inventory.type === type
      ? inventory
      : inventoryCache.current.get(type);
  const installed =
    visibleInventory?.api === api
      ? visibleInventory.scope === inventoryScope
        ? visibleInventory.result
        : pendingInventory(visibleInventory.result)
      : null;
  const [scanLoading, setScanLoading] = useState(false);
  const [scanRefreshing, setScanRefreshing] = useState(false);
  const [scanError, setScanError] = useState("");
  const [reload, setReload] = useState(0);
  const scanEpoch = useRef(0);
  const forceScan = useRef<{ api: typeof api; token: number } | null>(null);
  const refreshSequence = useRef(0);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const manualCompletion = useRef<((success: boolean) => void) | null>(null);
  const [pendingPaths, setPendingPaths] = useState<Set<string>>(new Set());
  const reloadContent = useCallback(() => {
    setReload((value) => value + 1);
  }, []);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [versionId, setVersionId] = useState("");
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState("");
  const [versionReload, setVersionReload] = useState(0);
  const [targetVersion, setTargetVersion] = useState("");
  const [targetLoader, setTargetLoader] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const consumedPlans = useRef(new Set<string>());
  const [cleanAccepted, setCleanAccepted] = useState(false);
  const [backupFirst, setBackupFirst] = useState(false);
  const [dialogError, setDialogError] = useState("");
  const [removal, setRemoval] = useState<InstalledItem | null>(null);
  const [removalPlan, setRemovalPlan] = useState<RemovalPlan | null>(null);
  const [removalError, setRemovalError] = useState("");
  const [removalAcknowledged, setRemovalAcknowledged] = useState(false);
  const [busy, setBusy] = useState<
    "preview" | "install" | "settings" | "removal-preview" | "remove" | null
  >(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState("");
  const [jobReload, setJobReload] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const session = useRef(0);
  const operation = useRef(0);
  const pending = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const removalDialog = useRef<HTMLDialogElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const source = config?.platforms.find((item) => item.id === platform);
  const inventoryReady = Boolean(config);
  const sortOptions = source?.sortOptions ?? [];
  const catalogSort = sortOptions.some((item) => item.id === sort)
    ? sort
    : (sortOptions[0]?.id ?? "");
  const supported = Boolean(source?.types.includes(type));
  const working = Boolean(job && ["queued", "running"].includes(job.status));
  const availableUpdates = (installed?.items ?? []).filter(
    (item) =>
      item.update &&
      item.platform &&
      item.projectId &&
      !pendingPaths.has(item.path),
  );
  const canInstall = allowChanges && status === "offline" && !working;
  const contentName =
    type === "plugin" ? "plugin" : type === "datapack" ? "datapack" : "mod";
  const minecraftVersions = [
    ...new Set(
      [
        ...(config?.gameVersions ?? []),
        config?.gameVersion,
        gameVersion,
        targetVersion,
      ].filter(
        (value): value is string =>
          typeof value === "string" && /^\d+(?:\.\d+)+$/.test(value),
      ),
    ),
  ];

  const loadConfig = useCallback(
    async (initial = false, fresh = false) => {
      const current = session.current;
      setConfigLoading(true);
      setConfigError("");
      try {
        const next = await api<Config>(
          `/launchpad${fresh ? "?refresh=1" : ""}`,
        );
        if (current !== session.current) return false;
        setConfig(next);
        setStatus(next.status);
        setStatusStale(false);
        if (initial) {
          const saved = readSavedView(viewKey);
          const first =
            next.platforms.find((item) => item.id === saved.platform) ??
            next.platforms.find(
              (item) => item.id === "modrinth" && item.available,
            ) ??
            next.platforms.find((item) => item.available) ??
            next.platforms[0];
          setPlatform(first?.id ?? "modrinth");
          const initialType =
            saved.type &&
            (saved.installedOnly || first?.types.includes(saved.type))
              ? saved.type
              : pluginLoaders.includes(next.loader ?? "") &&
                  first?.types.includes("plugin")
                ? "plugin"
                : first?.types.includes("modpack")
                  ? "modpack"
                  : (first?.types[0] ?? "modpack");
          setType(initialType);
          setGameVersion(
            saved.gameVersion !== undefined
              ? saved.gameVersion
              : next.gameVersion && /^\d+(?:\.\d+)+$/.test(next.gameVersion)
                ? next.gameVersion
                : "",
          );
          const validLoaders = loadersFor(initialType).filter(
            (value) => !next.loaders || next.loaders.includes(value),
          );
          setLoader(
            saved.loader === "" || validLoaders.includes(saved.loader ?? "")
              ? saved.loader!
              : validLoaders.includes(next.loader ?? "")
                ? next.loader!
                : initialType === "datapack"
                  ? "datapack"
                  : "",
          );
          setInstalledOnly(saved.installedOnly ?? false);
          setSort(
            first?.sortOptions?.some((item) => item.id === saved.sort)
              ? saved.sort!
              : (first?.sortOptions?.[0]?.id ?? "downloads"),
          );
          setInstalledSort(saved.installedSort ?? "updates");
          setViewReady(viewKey);
          setJob(next.job ?? null);
        }
        return true;
      } catch (cause) {
        if (current === session.current) setConfigError(messageOf(cause));
        return false;
      } finally {
        if (current === session.current) setConfigLoading(false);
      }
    },
    [api, viewKey],
  );

  const refreshInstalled = useCallback(async () => {
    const currentSession = session.current;
    manualCompletion.current?.(false);
    setManualRefreshing(true);
    const configured = await loadConfig(false, true);
    if (currentSession !== session.current) return false;
    if (!configured) {
      setManualRefreshing(false);
      return false;
    }
    forceScan.current = { api, token: ++refreshSequence.current };
    const completion = new Promise<boolean>((resolve) => {
      manualCompletion.current = resolve;
    });
    setReload((value) => value + 1);
    return completion;
  }, [api, loadConfig]);

  const reconcileJob = useCallback(async () => {
    const currentSession = session.current;
    await loadConfig();
    if (currentSession === session.current) reloadContent();
  }, [loadConfig, reloadContent]);

  // Reviews reserve staged files. Release them on Back, close, server change,
  // or unmount; an accepted job owns its staging until it finishes.
  useEffect(() => {
    const id = plan?.planId;
    return () => {
      if (id && !consumedPlans.current.delete(id))
        void api(`/launchpad/preview/${encodeURIComponent(id)}/cancel`, {
          method: "POST",
          keepalive: true,
        }).catch(() => {});
    };
  }, [api, plan?.planId]);
  useEffect(() => {
    const id = removalPlan?.planId;
    return () => {
      if (id && !consumedPlans.current.delete(id))
        void api(
          `/launchpad/removal-preview/${encodeURIComponent(id)}/cancel`,
          {
            method: "POST",
            keepalive: true,
          },
        ).catch(() => {});
    };
  }, [api, removalPlan?.planId]);

  useEffect(() => {
    session.current++;
    setViewReady(null);
    setConfig(null);
    setResults(null);
    setInventory(null);
    inventoryRef.current = null;
    inventoryCache.current.clear();
    forceScan.current = null;
    manualCompletion.current?.(false);
    manualCompletion.current = null;
    setManualRefreshing(false);
    setPendingPaths(new Set());
    setStatusStale(false);
    setJob(null);
    setSelection(null);
    setPlan(null);
    setRemoval(null);
    setRemovalPlan(null);
    setRemovalError("");
    setSettingsOpen(false);
    setApiKey("");
    setQuery("");
    setSort("downloads");
    setInstalledSort("updates");
    setOffset(0);
    setInstalledOnly(false);
    setBusy(null);
    pending.current = false;
    void loadConfig(true);
    let statusFailures = 0;
    const timer = window.setInterval(() => {
      const current = session.current;
      void api<{ status: string }>("/server")
        .then((next) => {
          if (current === session.current) {
            statusFailures = 0;
            setStatus(next.status);
            setStatusStale(false);
          }
        })
        .catch(() => {
          if (current === session.current) {
            statusFailures++;
            setStatusStale(true);
            if (statusFailures > 1) setStatus(null);
          }
        });
    }, 5000);
    return () => {
      session.current++;
      operation.current++;
      manualCompletion.current?.(false);
      manualCompletion.current = null;
      window.clearInterval(timer);
    };
  }, [api, loadConfig]);

  useEffect(() => {
    if (!config || viewReady !== viewKey) return;
    try {
      writePreference(
        viewKey,
        JSON.stringify({
          platform,
          type,
          gameVersion,
          loader,
          installedOnly,
          sort,
          installedSort,
        }),
        "session",
      );
    } catch {
      // Navigation still works when browser storage is unavailable.
    }
  }, [
    config,
    viewReady,
    viewKey,
    platform,
    type,
    gameVersion,
    loader,
    installedOnly,
    sort,
    installedSort,
  ]);

  useEffect(() => {
    if (!config || installedOnly || !source?.available || !supported) {
      setSearchLoading(false);
      setSearchError("");
      setResults(null);
      return;
    }
    const controller = new AbortController();
    const scope = JSON.stringify([
      platform,
      type,
      query.trim(),
      gameVersion.trim(),
      loader,
      catalogSort,
      offset,
      limit,
    ]);
    if (resultsScope.current !== scope) {
      resultsScope.current = scope;
      setResults(null);
    }
    setSearchLoading(true);
    setSearchError("");
    const timer = window.setTimeout(() => {
      void api<SearchResult>(
        `/launchpad/search?${queryString({ platform, type, query: query.trim(), gameVersion: gameVersion.trim(), loader, sort: catalogSort, offset, limit })}`,
        { signal: controller.signal },
      )
        .then((next) => {
          if (controller.signal.aborted) return;
          if (offset > 0 && offset >= next.total)
            setOffset(Math.max(0, Math.ceil(next.total / limit) - 1) * limit);
          else setResults(next);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setSearchError(messageOf(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearchLoading(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    api,
    config,
    source?.available,
    supported,
    installedOnly,
    platform,
    type,
    query,
    catalogSort,
    gameVersion,
    loader,
    offset,
    limit,
    reload,
  ]);

  useEffect(() => {
    if (!inventoryReady) return;
    const epoch = ++scanEpoch.current;
    const currentSession = session.current;
    const controller = new AbortController();
    const current = () =>
      !controller.signal.aborted &&
      epoch === scanEpoch.current &&
      currentSession === session.current;
    const cached = inventoryCache.current.get(type);
    inventoryRef.current = cached?.api === api ? cached : null;
    let hasSnapshot =
      inventoryRef.current?.api === api && inventoryRef.current.type === type;
    setScanLoading(!hasSnapshot);
    setScanRefreshing(true);
    setScanError("");
    if (!hasSnapshot) {
      inventoryRef.current = null;
      setInventory(null);
    } else if (inventoryRef.current!.scope !== inventoryScope) {
      const next = {
        api,
        scope: inventoryScope,
        type,
        result: pendingInventory(inventoryRef.current!.result),
      };
      inventoryRef.current = next;
      inventoryCache.current.set(type, next);
      setInventory(next);
    }
    const publish = (result: InstalledResult, local = false) => {
      if (!current()) return;
      const next = {
        api,
        scope: inventoryScope,
        type,
        result: local
          ? mergeLocalInventory(result, inventoryRef.current?.result)
          : result,
      };
      inventoryRef.current = next;
      inventoryCache.current.set(type, next);
      setInventory(next);
      hasSnapshot = true;
      if (local) setPendingPaths(new Set());
    };
    async function readStage(
      local: boolean,
      force: boolean,
      remaining = 45_000,
    ) {
      const stage = new AbortController();
      let timer: number;
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => {
          stage.abort();
          reject(new DOMException("Installed refresh cancelled", "AbortError"));
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        timer = window.setTimeout(
          () => {
            stage.abort();
            reject(
              new Error(
                local
                  ? "Reading installed files took too long. Please try again."
                  : "The online check took too long. Please try again shortly.",
              ),
            );
          },
          local ? 30_000 : Math.max(1, Math.min(45_000, remaining)),
        );
      });
      try {
        return await Promise.race([
          api<InstalledResult>(
            `/launchpad/installed?${queryString({
              type,
              gameVersion: contentGameVersion,
              loader: contentLoader,
              local: local ? "true" : undefined,
              quick: local ? "true" : undefined,
              refresh: !local && force ? "true" : undefined,
              background: !local ? "true" : undefined,
            })}`,
            { signal: stage.signal },
          ),
          cancelled,
        ]);
      } finally {
        window.clearTimeout(timer!);
        controller.signal.removeEventListener("abort", abort);
      }
    }
    const timer = window.setTimeout(() => {
      const forcedRequest =
        forceScan.current?.api === api ? forceScan.current : null;
      const force = Boolean(forcedRequest);
      void (async () => {
        let success = false;
        try {
          publish(await readStage(true, false), true);
        } catch (cause) {
          if (!current()) return;
          setScanError(
            `Unable to read local installed files. ${messageOf(cause)}`,
          );
        } finally {
          if (current()) setScanLoading(false);
        }
        if (!current()) return;
        let receivedOnline = false;
        try {
          const deadline = Date.now() + 120_000;
          let result = await readStage(false, force);
          publish(result);
          receivedOnline = true;
          while (current() && result.checkingUpdates) {
            await new Promise<void>((resolve) => {
              const done = () => {
                window.clearTimeout(wait);
                controller.signal.removeEventListener("abort", done);
                resolve();
              };
              const wait = window.setTimeout(done, 3000);
              controller.signal.addEventListener("abort", done, { once: true });
            });
            if (!current()) return;
            if (Date.now() >= deadline)
              throw new Error(
                "The update check is taking longer than expected. Try again to see its latest results.",
              );
            result = await readStage(false, false, deadline - Date.now());
            publish(result);
          }
          if (current()) {
            setScanError("");
            setPendingPaths(new Set());
            success = true;
          }
        } catch (cause) {
          if (current()) {
            const snapshot = inventoryRef.current;
            if (
              contentGameVersion &&
              contentLoader &&
              snapshot?.api === api &&
              snapshot.scope === inventoryScope
            ) {
              publish({
                ...snapshot.result,
                items: snapshot.result.items.map((item) =>
                  item.platform &&
                  item.projectId &&
                  (!receivedOnline ||
                    !item.updateCheck ||
                    item.updateCheck === "pending")
                    ? {
                        ...item,
                        updateCheck: "unavailable",
                        updateIssue: messageOf(cause),
                      }
                    : item,
                ),
              });
            }
            setScanError(
              `${
                hasSnapshot
                  ? "Installed files are available, but online details could not be refreshed."
                  : "Unable to refresh installed content."
              } ${messageOf(cause)}`,
            );
          }
        } finally {
          if (current()) {
            setScanLoading(false);
            setScanRefreshing(false);
            if (
              forcedRequest &&
              forceScan.current?.token === forcedRequest.token
            ) {
              forceScan.current = null;
              setManualRefreshing(false);
              manualCompletion.current?.(success);
              manualCompletion.current = null;
            }
          }
        }
      })();
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      scanEpoch.current++;
    };
  }, [
    api,
    inventoryReady,
    inventoryScope,
    type,
    contentGameVersion,
    contentLoader,
    reload,
  ]);

  useEffect(() => {
    if (selection) dialog.current?.showModal();
    else dialog.current?.close();
  }, [selection]);
  useEffect(() => {
    if (settingsOpen) settingsDialog.current?.showModal();
    else settingsDialog.current?.close();
  }, [settingsOpen]);
  useEffect(() => {
    if (removal) removalDialog.current?.showModal();
    else removalDialog.current?.close();
  }, [removal]);
  useEffect(() => {
    if (!selection || selection.bulk) return;
    const controller = new AbortController();
    setVersionsLoading(true);
    setVersionsError("");
    setVersions([]);
    setVersionId("");
    const timer = window.setTimeout(() => {
      void api<{ versions: Version[] }>(
        `/launchpad/versions?${queryString({ platform: selection.project.platform, projectId: selection.project.id, type, gameVersion: targetVersion.trim(), loader: targetLoader })}`,
        { signal: controller.signal },
      )
        .then((next) => {
          if (controller.signal.aborted) return;
          setVersions(next.versions);
          const preferred =
            next.versions.find(
              (version) =>
                version.downloadable &&
                version.id === selection.installed?.update?.id,
            ) ?? next.versions.find((version) => version.downloadable);
          setVersionId(preferred?.id ?? "");
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setVersionsError(messageOf(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setVersionsLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, selection, type, targetVersion, targetLoader, versionReload]);

  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const controller = new AbortController();
    let timer: number;
    const poll = async () => {
      try {
        const next = await api<{ job: Job }>(
          `/launchpad/jobs/${encodeURIComponent(job.id)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setJob(next.job);
        setJobError("");
        if (next.job.status === "completed") {
          void reconcileJob();
          notify(next.job.message || "Installation completed.");
        }
        if (next.job.status === "failed") {
          void reconcileJob();
          notify(next.job.error || next.job.message, true);
        }
        if (["queued", "running"].includes(next.job.status))
          timer = window.setTimeout(poll, 1000);
      } catch (cause) {
        if (!controller.signal.aborted) {
          if ((cause as { status?: number }).status === 404) {
            setJob(null);
            setJobError(
              "This installation is no longer being tracked. Check the installed list for its result.",
            );
            void reconcileJob();
            return;
          }
          setJobError(messageOf(cause));
          timer = window.setTimeout(poll, 3000);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [api, job?.id, job?.status, jobReload, notify, reconcileJob]);

  function chooseProject(project: Project, entry?: InstalledItem) {
    if (!allowChanges) return;
    operation.current++;
    setDialogError("");
    setPlan(null);
    setCleanAccepted(false);
    setBackupFirst(false);
    // Modpacks replace the server runtime, so catalog installs start with the
    // chosen filters. Installed-only updates keep the current server target.
    const browsingModpack = type === "modpack" && !installedOnly;
    setTargetVersion(
      browsingModpack
        ? gameVersion.trim() || contentGameVersion
        : contentGameVersion,
    );
    setTargetLoader(browsingModpack ? loader || contentLoader : contentLoader);
    setSelection({ project, installed: entry });
  }
  function closeSelection() {
    if (busy === "install") return;
    operation.current++;
    setSelection(null);
    setPlan(null);
    setCleanAccepted(false);
    setDialogError("");
    pending.current = false;
    setBusy(null);
  }
  function closeRemoval() {
    if (busy === "remove") return;
    operation.current++;
    setRemoval(null);
    setRemovalPlan(null);
    setRemovalError("");
    pending.current = false;
    setBusy(null);
  }
  async function reviewRemoval(entry: InstalledItem) {
    if (pending.current || !canInstall) return;
    const currentSession = session.current,
      currentOperation = ++operation.current;
    setRemoval(entry);
    setRemovalPlan(null);
    setRemovalError("");
    pending.current = true;
    setRemovalAcknowledged(false);
    setBusy("removal-preview");
    try {
      const next = await post<RemovalPlan>("/launchpad/removal-preview", {
        path: entry.path,
        type,
      });
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      ) {
        setRemovalPlan(next);
      } else if (next.planId) {
        void post(
          `/launchpad/removal-preview/${encodeURIComponent(next.planId)}/cancel`,
        ).catch(() => {});
      }
    } catch (cause) {
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      )
        setRemovalError(messageOf(cause));
    } finally {
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      ) {
        pending.current = false;
        setBusy(null);
      }
    }
  }
  async function removeMod() {
    if (
      pending.current ||
      !removal ||
      !removalPlan?.planId ||
      removalPlan.blocked ||
      (removalPlan.requiresAcknowledgement && !removalAcknowledged) ||
      !canInstall
    )
      return;
    const currentSession = session.current,
      currentOperation = operation.current;
    pending.current = true;
    setBusy("remove");
    setRemovalError("");
    try {
      await post("/launchpad/remove", {
        planId: removalPlan.planId,
        confirmed: true,
        ...(removalAcknowledged
          ? { acknowledgedUnreadableDependencies: true }
          : {}),
      });
      consumedPlans.current.add(removalPlan.planId);
      if (
        currentSession !== session.current ||
        currentOperation !== operation.current
      )
        return;
      setRemoval(null);
      setRemovalPlan(null);
      const removedPaths = new Set(removalPlan.files.map((file) => file.path));
      if (inventoryRef.current?.api === api) {
        const next = {
          ...inventoryRef.current,
          result: {
            ...inventoryRef.current.result,
            items: inventoryRef.current.result.items.filter(
              (item) => !removedPaths.has(item.path),
            ),
          },
        };
        inventoryRef.current = next;
        inventoryCache.current.set(next.type, next);
        setInventory(next);
      }
      reloadContent();
      notify(`${removal.title || removal.name} moved to Recycle Bin.`);
    } catch (cause) {
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      ) {
        setRemovalError(messageOf(cause));
        // A failed or stale confirmation needs a fresh dependency/file review.
        setRemovalPlan(null);
      }
    } finally {
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      ) {
        pending.current = false;
        setBusy(null);
      }
    }
  }
  async function preview(event: FormEvent) {
    event.preventDefault();
    if (selection?.bulk) {
      await reviewAllUpdates();
      return;
    }
    if (plan || !selection || !versionId || pending.current) return;
    if (!targetVersion.trim()) {
      setDialogError(
        "Choose your server’s Minecraft version before reviewing this installation.",
      );
      return;
    }
    if (!targetLoader) {
      setDialogError(
        "Choose your server’s loader before reviewing this installation.",
      );
      return;
    }
    if (!canInstall) {
      setDialogError(
        "Stop the server in Console before reviewing file changes.",
      );
      return;
    }
    const currentSession = session.current,
      currentOperation = operation.current;
    setCleanAccepted(false);
    pending.current = true;
    setBusy("preview");
    setDialogError("");
    try {
      const next = await post<Plan>("/launchpad/preview", {
        platform: selection.project.platform,
        projectId: selection.project.id,
        versionId,
        type,
        gameVersion: targetVersion.trim(),
        loader: targetLoader,
        ...(selection.installed
          ? { replacePath: selection.installed.path }
          : {}),
      });
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      ) {
        setPlan(next);
      } else if (next.planId) {
        void post(
          `/launchpad/preview/${encodeURIComponent(next.planId)}/cancel`,
        ).catch(() => {});
      }
    } catch (cause) {
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      )
        setDialogError(messageOf(cause));
    } finally {
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      ) {
        pending.current = false;
        setBusy(null);
      }
    }
  }
  async function install() {
    if (!plan || pending.current) return;
    if ((type === "modpack" || plan.cleanInstall) && !cleanAccepted) return;
    if (!canInstall) {
      setDialogError("Stop the server in Console before installing.");
      return;
    }
    const currentSession = session.current,
      currentOperation = operation.current;
    pending.current = true;
    setBusy("install");
    setDialogError("");
    try {
      if (backupFirst && (type === "modpack" || plan.cleanInstall)) {
        await post("/backups", { name: "Before modpack installation" });
        if (
          currentSession !== session.current ||
          currentOperation !== operation.current
        )
          return;
      }
      const next = await post<{ job: Job }>("/launchpad/install", {
        planId: plan.planId,
        confirmed: true,
        ...(type === "modpack" || plan.cleanInstall
          ? { cleanInstall: true }
          : {}),
        ...(plan.unavailableDependencies?.length
          ? { acknowledgedUnavailableDependencies: true }
          : {}),
      });
      consumedPlans.current.add(plan.planId);
      if (
        currentSession !== session.current ||
        currentOperation !== operation.current
      )
        return;
      setJob(next.job);
      setPendingPaths(
        new Set(
          plan.cleanInstall || type === "modpack"
            ? inventoryRef.current?.result.items.map((item) => item.path)
            : plan.files.flatMap((file) => [
                file.path,
                ...(file.previousPath ? [file.previousPath] : []),
              ]),
        ),
      );
      setJobError("");
      setSelection(null);
      setPlan(null);
      if (next.job.status === "completed") {
        void reconcileJob();
        notify(next.job.message);
      }
      if (next.job.status === "failed") void reconcileJob();
    } catch (cause) {
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      )
        setDialogError(messageOf(cause));
    } finally {
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      ) {
        pending.current = false;
        setBusy(null);
      }
    }
  }
  async function reviewAllUpdates() {
    if (pending.current || !canInstall || type === "modpack") return;
    const updates = availableUpdates.slice(0, 50);
    if (!updates.length) return;
    const currentSession = session.current,
      currentOperation = ++operation.current;
    setSelection({
      project: {
        id: "updates",
        platform: "",
        title: `Update ${updates.length} installed items`,
        description: "",
      },
      bulk: true,
    });
    setTargetVersion(contentGameVersion);
    setTargetLoader(contentLoader);
    setPlan(null);
    setDialogError("");
    setBusy("preview");
    pending.current = true;
    try {
      const next = await post<Plan>("/launchpad/updates/preview", {
        type,
        gameVersion: contentGameVersion,
        loader: contentLoader,
        updates: updates.map((item) => ({
          platform: item.platform,
          projectId: item.projectId,
          versionId: item.update!.id,
          replacePath: item.path,
        })),
      });
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      )
        setPlan(next);
      else
        void post(
          `/launchpad/preview/${encodeURIComponent(next.planId)}/cancel`,
        ).catch(() => {});
    } catch (cause) {
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      )
        setDialogError(messageOf(cause));
    } finally {
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      ) {
        pending.current = false;
        setBusy(null);
      }
    }
  }
  async function retryDownload() {
    if (pending.current || !canInstall || !job?.retryable || !job.retryInput)
      return;
    const currentSession = session.current;
    pending.current = true;
    setBusy("install");
    setJobError("");
    try {
      const result = await post<{ job: Job }>(
        "/launchpad/install",
        job.retryInput,
      );
      if (currentSession === session.current) {
        setJob(result.job);
        if (["completed", "failed"].includes(result.job.status))
          void reconcileJob();
        if (result.job.status === "completed")
          notify(result.job.message || "Installation completed.");
      }
    } catch (cause) {
      if (currentSession === session.current) setJobError(messageOf(cause));
    } finally {
      if (currentSession === session.current) {
        pending.current = false;
        setBusy(null);
      }
    }
  }
  async function saveKey(value: string) {
    if (permissions !== undefined || pending.current) return;
    const currentSession = session.current;
    pending.current = true;
    setBusy("settings");
    setSettingsError("");
    try {
      const next = await api<Config>("/launchpad/settings", {
        method: "PUT",
        body: JSON.stringify({ curseforgeApiKey: value.trim() }),
      });
      if (currentSession !== session.current) return;
      setConfig(next);
      setApiKey("");
      setSettingsOpen(false);
      reloadContent();
      notify(
        value.trim()
          ? "CurseForge API key saved."
          : "Saved CurseForge API key removed.",
      );
    } catch (cause) {
      if (currentSession === session.current)
        setSettingsError(messageOf(cause));
    } finally {
      if (currentSession === session.current) {
        pending.current = false;
        setBusy(null);
      }
    }
  }
  function changeType(next: ContentType) {
    setType(next);
    setLoader((current) =>
      loadersFor(next).includes(current)
        ? current
        : next === "datapack"
          ? "datapack"
          : "",
    );
    setQuery("");
    setOffset(0);
  }
  const entries = (installed?.items ?? [])
    .filter((entry) =>
      `${entry.title ?? ""} ${entry.name} ${entry.path} ${entry.author ?? ""}`
        .toLowerCase()
        .includes(filteredQuery.trim().toLowerCase()),
    )
    .sort((a, b) => compareInstalled(a, b, installedSort));
  const total = installedOnly ? entries.length : (results?.total ?? 0);
  const currentOffset = Math.min(
    offset,
    Math.max(0, Math.ceil(total / limit) - 1) * limit,
  );
  useEffect(() => {
    if (installedOnly && installed && offset !== currentOffset)
      setOffset(currentOffset);
  }, [installedOnly, installed, offset, currentOffset]);
  const selectedVersion = versions.find((version) => version.id === versionId);
  const loading = installedOnly
    ? !installed && scanLoading
    : !results && searchLoading;
  const failed = installedOnly ? !installed && scanError : searchError;
  const keySource = config?.platforms.find((item) => item.id === "curseforge");
  const updateFiltersReady = Boolean(contentGameVersion && contentLoader);
  const listedGameVersion = installedOnly ? contentGameVersion : gameVersion;
  const listedLoader = installedOnly ? contentLoader : loader;
  const unavailableUpdates = updateFiltersReady
    ? entries.filter(
        (item) =>
          item.platform &&
          item.projectId &&
          (item.updateCheck === "unavailable" ||
            (!scanRefreshing && item.updateCheck === "pending")),
      )
    : [];
  const visibleProjects: { project: Project; entry?: InstalledItem }[] =
    installedOnly
      ? entries.slice(currentOffset, currentOffset + limit).map((entry) => ({
          project: {
            id: entry.projectId ?? entry.path,
            platform: entry.platform ?? "",
            title: entry.title ?? entry.name,
            description: entry.path,
            iconUrl: entry.iconUrl,
            author: entry.author,
            url: projectPageUrl(entry),
          },
          entry,
        }))
      : (results?.projects ?? []).map((project) => ({
          project: {
            ...project,
            url: projectPageUrl({ ...project, projectId: project.id }),
          },
          entry: installed?.items.find(
            (entry) =>
              entry.platform === project.platform &&
              entry.projectId === project.id,
          ),
        }));
  const duplicateProjects = new Set<string>();
  const projectCounts = new Map<string, number>();
  for (const item of installed?.items ?? []) {
    if (!item.platform || !item.projectId) continue;
    const key = `${item.platform}:${item.projectId}`;
    const count = (projectCounts.get(key) ?? 0) + 1;
    projectCounts.set(key, count);
    if (count > 1) duplicateProjects.add(key);
  }
  const warnings = [
    ...new Set(
      [
        ...(config?.warnings ?? []),
        ...(installedOnly ? (installed?.warnings ?? []) : []),
        ...(!installedOnly ? (results?.warnings ?? []) : []),
      ]
        .map((warning) => warning.trim())
        .filter(Boolean),
    ),
  ];

  if (!config)
    return (
      <div className="management-page launchpad-page">
        <div className="page-heading">
          <h1>Launchpad</h1>
        </div>
        <StatePanel
          variant={configLoading ? "loading" : "error"}
          title={
            configLoading ? "Loading Launchpad…" : "Unable to load Launchpad"
          }
          message={configError}
          onRetry={() => void loadConfig(true)}
        />
      </div>
    );

  return (
    <div className="management-page launchpad-page">
      <div className="page-heading management-heading">
        <div>
          <h1>Launchpad</h1>
        </div>
        {permissions === undefined && (
          <button
            className="btn"
            onClick={() => {
              setApiKey("");
              setSettingsError("");
              setSettingsOpen(true);
            }}
          >
            <KeyRound size={15} /> Platform settings
          </button>
        )}
      </div>
      <div className="panel launchpad-filters">
        <label>
          Platform
          <select
            aria-label="Platform"
            value={installedOnly ? "all" : platform}
            disabled={installedOnly}
            title={
              installedOnly
                ? "Installed content includes every platform."
                : undefined
            }
            onChange={(event) => {
              const next = config.platforms.find(
                (item) => item.id === event.target.value,
              );
              setPlatform(event.target.value);
              setQuery("");
              setOffset(0);
              if (next && !next.types.includes(type))
                changeType(next.types[0] ?? "modpack");
            }}
          >
            {installedOnly && <option value="all">All platforms</option>}
            {config.platforms.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Minecraft version
          <select
            aria-label="Minecraft version"
            disabled={installedOnly && Boolean(config.gameVersion)}
            aria-describedby={
              installedOnly && !updateFiltersReady && type !== "modpack"
                ? "launchpad-update-target"
                : undefined
            }
            aria-invalid={
              installedOnly && type !== "modpack" && !contentGameVersion
            }
            value={installedOnly ? contentGameVersion : gameVersion}
            onChange={(event) => {
              setGameVersion(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">All versions</option>
            {minecraftVersions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          Loader
          <select
            aria-label="Loader"
            disabled={
              installedOnly &&
              Boolean(config.loader && loaders.includes(config.loader))
            }
            aria-describedby={
              installedOnly && !updateFiltersReady && type !== "modpack"
                ? "launchpad-update-target"
                : undefined
            }
            aria-invalid={installedOnly && type !== "modpack" && !contentLoader}
            value={installedOnly ? contentLoader : loader}
            onChange={(event) => {
              setLoader(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">All loaders</option>
            {loaders.map((value) => (
              <option key={value} value={value}>
                {loaderName(value)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div
        className="launchpad-tabs"
        role="tablist"
        aria-label="Content type"
        ref={tabs}
      >
        {kinds.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            id={`launchpad-tab-${id}`}
            aria-selected={type === id}
            aria-controls="launchpad-results"
            tabIndex={type === id ? 0 : -1}
            disabled={!installedOnly && !source?.types.includes(id)}
            title={
              !installedOnly && !source?.types.includes(id)
                ? `${source?.name ?? "This platform"} does not offer ${label.toLowerCase()}.`
                : undefined
            }
            onClick={() => changeType(id)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const supportedKinds = kinds.filter(
                (item) => installedOnly || source?.types.includes(item.id),
              );
              const current = supportedKinds.findIndex(
                (item) => item.id === type,
              );
              const index =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? supportedKinds.length - 1
                    : (current +
                        (event.key === "ArrowRight" ? 1 : -1) +
                        supportedKinds.length) %
                      supportedKinds.length;
              const next = supportedKinds[index];
              if (next) {
                changeType(next.id);
                tabs.current
                  ?.querySelector<HTMLButtonElement>(
                    `#launchpad-tab-${next.id}`,
                  )
                  ?.focus();
              }
            }}
          >
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
      {statusStale && status && (
        <div className="launchpad-inline-notice" role="status">
          <Info size={17} />
          <span>
            Reconnecting to the server. Last known status: {status}. File
            changes are checked again before they run.
          </span>
        </div>
      )}
      {installedOnly && !updateFiltersReady && type !== "modpack" && (
        <div
          className="launchpad-inline-notice"
          id="launchpad-update-target"
          role="status"
        >
          <Info size={17} />
          <span>
            Choose this server’s Minecraft version and loader above to check for
            updates.
          </span>
        </div>
      )}
      {status !== "offline" && (
        <div className="launchpad-inline-notice">
          <Info size={17} />
          <div>
            {status
              ? "You can browse while the server is running. Stop it in Console before installing or updating files."
              : "Server status is unavailable. Installation will be available once the panel reconnects."}{" "}
            <a href="#console">Open Console</a>
          </div>
        </div>
      )}
      <div className="panel launchpad-toolbar">
        <Pagination
          label="Launchpad"
          page={Math.floor(currentOffset / limit) + 1}
          pageSize={limit}
          total={total}
          pageSizes={rowsOptions}
          disabled={loading}
          onPageChange={(page) => setOffset((page - 1) * limit)}
          onPageSizeChange={(value) => {
            setLimit(value);
            setOffset(0);
            try {
              writePreference("mc-panel.launchpad.rows", String(value));
            } catch {
              /* session only */
            }
          }}
        />
        <SearchField
          className="launchpad-search"
          grow
          aria-label="Search Launchpad"
          placeholder={`Search ${kinds.find((item) => item.id === type)?.label.toLowerCase()}…`}
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            setOffset(0);
          }}
        />
        {installedOnly ? (
          <label className="launchpad-sort">
            Sort by
            <select
              aria-label="Sort installed content"
              value={installedSort}
              onChange={(event) => {
                setInstalledSort(event.target.value as InstalledSort);
                setOffset(0);
              }}
            >
              {installedSortOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ) : sortOptions.length > 0 ? (
          <label className="launchpad-sort">
            Sort by
            <select
              aria-label="Sort Launchpad"
              value={catalogSort}
              onChange={(event) => {
                setSort(event.target.value);
                setOffset(0);
              }}
            >
              {sortOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="launchpad-toolbar-actions">
          {installedOnly && type !== "modpack" && allowChanges && (
            <button
              className="btn primary"
              disabled={
                !canInstall ||
                Boolean(busy) ||
                !updateFiltersReady ||
                !installed?.items.some((item) => item.update)
              }
              onClick={() => void reviewAllUpdates()}
            >
              <RefreshCw size={15} />{" "}
              {availableUpdates.length > 50
                ? `Update first 50 (${availableUpdates.length} available)`
                : "Update all"}
            </button>
          )}
          <Switch
            label="Installed only"
            aria-label="Show installed content"
            checked={installedOnly}
            onCheckedChange={(checked) => {
              setInstalledOnly(checked);
              setOffset(0);
              setQuery("");
              if (!checked && !source?.types.includes(type))
                changeType(source?.types[0] ?? "modpack");
            }}
          />
          <RefreshButton
            label="Refresh Launchpad and check updates"
            refreshing={manualRefreshing}
            onRefresh={refreshInstalled}
            notify={notify}
            successMessage="Launchpad refreshed."
          />
        </div>
      </div>
      {job && (
        <div
          className="panel launchpad-job"
          role="status"
          aria-label="Installation status"
        >
          <div className="launchpad-job-heading">
            {working ? (
              <LoaderCircle size={20} className="spin" />
            ) : job.status === "completed" ? (
              <Check size={20} />
            ) : (
              <AlertCircle size={20} />
            )}
            <div>
              <strong>
                {working
                  ? "Installing server content"
                  : job.status === "completed"
                    ? "Installation completed"
                    : "Installation failed"}
              </strong>
              <p>{job.error || job.message}</p>
              {job.status === "completed" &&
                Boolean(job.recoveryEntries?.length) &&
                (permissions === undefined ||
                  permissions.includes("backup.read")) && (
                  <a href="#files?recycle=1">
                    View replaced files in Recycle Bin
                  </a>
                )}
            </div>
            {job.status === "failed" && job.retryable && job.retryInput && (
              <button
                className="btn"
                disabled={!canInstall || Boolean(busy)}
                onClick={() => void retryDownload()}
              >
                Retry download
              </button>
            )}
            {!working &&
              (permissions === undefined ||
                permissions.includes("file.update")) && (
                <button
                  className="btn icon"
                  aria-label="Dismiss installation status"
                  onClick={() => {
                    const currentSession = session.current;
                    void post(
                      `/launchpad/jobs/${encodeURIComponent(job.id)}/dismiss`,
                    )
                      .then(() => {
                        if (currentSession === session.current)
                          setJob((current) =>
                            current?.id === job.id ? null : current,
                          );
                      })
                      .catch((cause) => notify(messageOf(cause), true));
                  }}
                >
                  <X size={16} />
                </button>
              )}
          </div>
          {working && (
            <progress
              aria-label="Installation progress"
              max={Math.max(1, job.total)}
              value={job.total > 0 ? job.completed : undefined}
            />
          )}
          {jobError && (
            <div className="launchpad-error" role="alert">
              <span>{jobError} The installation may still be running.</span>
              <button
                className="btn"
                onClick={() => setJobReload((value) => value + 1)}
              >
                Try again
              </button>
            </div>
          )}
        </div>
      )}
      {!job && jobError && (
        <StatePanel
          variant="error"
          title="Installation status unavailable"
          message={jobError}
          onRetry={() => {
            setJobError("");
            void refreshInstalled();
          }}
        />
      )}
      {configError && (
        <div className="launchpad-error" role="alert">
          <AlertCircle size={16} />
          <span>{configError}</span>
          <button className="btn" onClick={() => void loadConfig()}>
            Try again
          </button>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="launchpad-inline-notice launchpad-notices">
          <Info size={16} />
          {warnings.length === 1 && warnings[0].length <= 240 ? (
            <div>{warnings[0]}</div>
          ) : (
            <details className="launchpad-update-issues">
              <summary>
                {warnings.length} provider or file{" "}
                {warnings.length === 1 ? "notice" : "notices"}
                {installedOnly ? " — installed files remain available" : ""}
              </summary>
              <ul aria-label="Provider and file notices" tabIndex={0}>
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {scanRefreshing && (!installedOnly || installed) && (
        <div
          className="launchpad-scan-status"
          role="status"
          aria-label="Installed content refresh"
        >
          <LoaderCircle size={14} className="spin" />
          <span>
            {scanLoading
              ? "Reading installed files…"
              : installed?.checkingUpdates && installed.progress
                ? `Checking updates for ${Math.max(0, installed.progress.total - installed.progress.completed)} of ${installed.progress.total}…`
                : "Refreshing installed details and checking updates…"}
          </span>
        </div>
      )}
      {scanError && installedOnly && installed && (
        <div className="launchpad-error" role="alert">
          <AlertCircle size={16} />
          <span>{scanError}</span>
          <button
            className="btn"
            disabled={manualRefreshing}
            onClick={() => void refreshInstalled()}
          >
            Try again
          </button>
        </div>
      )}
      {installedOnly && !scanError && unavailableUpdates.length > 0 && (
        <div className="launchpad-error launchpad-update-warning" role="alert">
          <AlertCircle size={16} />
          <div className="launchpad-update-warning-body">
            <span>
              Could not check updates for {unavailableUpdates.length} installed{" "}
              {unavailableUpdates.length === 1 ? "item" : "items"}.
            </span>
            <details className="launchpad-update-issues">
              <summary>View affected files</summary>
              <ul
                aria-label="Files with unavailable update checks"
                tabIndex={0}
              >
                {unavailableUpdates.map((item) => (
                  <li key={item.path}>
                    <strong>{item.title?.trim() || item.name}</strong>
                    <code>{item.path}</code>
                    <p>
                      {item.updateIssue ||
                        "No verified update result is available for this file. Retry the check."}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          </div>
          <button
            className="btn"
            disabled={manualRefreshing}
            onClick={() => void refreshInstalled()}
          >
            Try again
          </button>
        </div>
      )}
      <section
        id="launchpad-results"
        className="launchpad-results"
        role="tabpanel"
        aria-labelledby={`launchpad-tab-${type}`}
        aria-busy={loading}
      >
        {!installedOnly && (!source?.available || !supported) ? (
          <StatePanel
            variant="empty"
            icon={<SlidersHorizontal size={25} />}
            title={`${source?.name ?? "Platform"} ${supported ? "is unavailable" : "does not offer this content"}`}
            message={
              source?.reason || "Choose another platform or content type."
            }
            action={
              permissions === undefined &&
              source?.requiresKey && (
                <button
                  className="btn primary"
                  onClick={() => {
                    setSettingsError("");
                    setApiKey("");
                    setSettingsOpen(true);
                  }}
                >
                  <KeyRound size={15} /> Configure API key
                </button>
              )
            }
          />
        ) : loading ? (
          <StatePanel
            variant="loading"
            title={
              installedOnly ? "Reading installed files…" : "Loading projects…"
            }
          />
        ) : failed && !visibleProjects.length ? (
          <StatePanel
            variant="error"
            title={`Unable to load ${installedOnly ? "installed content" : "projects"}`}
            message={failed}
            onRetry={() => {
              if (installedOnly) void refreshInstalled();
              else reloadContent();
            }}
          />
        ) : visibleProjects.length === 0 ? (
          <StatePanel
            variant="empty"
            icon={<Package size={27} />}
            title={
              installedOnly
                ? "No installed content matches"
                : "No projects found"
            }
            message={
              installedOnly
                ? "Installed files appear here after a scan. Try another content type or search."
                : "Try another search, Minecraft version, or loader."
            }
          />
        ) : (
          <>
            {failed && (
              <StatePanel
                variant="error"
                title="Projects could not be refreshed"
                message={failed}
                onRetry={reloadContent}
              />
            )}
            <div className="launchpad-result-count">
              {total.toLocaleString()}{" "}
              {installedOnly ? "installed items" : "projects"}
              {listedGameVersion ? ` · Minecraft ${listedGameVersion}` : ""}
              {listedLoader ? ` · ${loaderName(listedLoader)}` : ""}
            </div>
            {visibleProjects.map(({ project, entry }) => (
              <article
                className="panel launchpad-project"
                key={entry?.path ?? `${project.platform}:${project.id}`}
                aria-label={project.title}
              >
                <ProjectIcon url={project.iconUrl} />
                <div className="launchpad-project-body">
                  <div className="launchpad-project-title">
                    <h3>{project.title}</h3>
                    {project.url && /^https:\/\//i.test(project.url) && (
                      <a
                        className="launchpad-project-link"
                        href={project.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${project.title} project page`}
                        title="Open project page"
                      >
                        <ExternalLink size={14} />
                      </a>
                    )}
                    {entry && (
                      <span className="launchpad-badge">
                        {entry.platform && entry.projectId
                          ? "Installed"
                          : "Unidentified file"}
                      </span>
                    )}
                    {entry?.update && (
                      <span className="launchpad-badge update">
                        Update available
                      </span>
                    )}
                    {installedOnly && entry?.platform && (
                      <span className="launchpad-badge">
                        {config.platforms.find(
                          (item) => item.id === entry.platform,
                        )?.name ?? entry.platform}
                      </span>
                    )}
                    {entry &&
                      duplicateProjects.has(
                        `${entry.platform}:${entry.projectId}`,
                      ) && (
                        <span className="launchpad-badge update">
                          Duplicate — remove one
                        </span>
                      )}
                    {entry && pendingPaths.has(entry.path) && (
                      <span className="launchpad-badge">Refreshing file…</span>
                    )}
                  </div>
                  <p>{project.description || "No description provided."}</p>
                  <div className="launchpad-project-meta">
                    {typeof project.downloads === "number" && (
                      <span>
                        <Download size={13} />
                        {new Intl.NumberFormat(undefined, {
                          notation: "compact",
                          maximumFractionDigits: 1,
                        }).format(project.downloads)}{" "}
                        downloads
                      </span>
                    )}
                    {project.author && <span>By {project.author}</span>}
                    {entry?.versionName && (
                      <span>Installed: {entry.versionName}</span>
                    )}
                    {entry?.update && (
                      <span>
                        Available: {entry.update.version || entry.update.name}
                      </span>
                    )}
                    {entry && <span>{formatBytes(entry.size)}</span>}
                    {entry &&
                      updateCheckLabel(
                        entry,
                        updateFiltersReady,
                        scanRefreshing,
                      ) && (
                        <span>
                          {updateCheckLabel(
                            entry,
                            updateFiltersReady,
                            scanRefreshing,
                          )}
                        </span>
                      )}
                    {!entry?.platform && entry && (
                      <span>
                        {scanRefreshing
                          ? "Checking this file’s project details..."
                          : "Could not identify this file for automatic updates."}
                      </span>
                    )}
                  </div>
                  {entry?.updateIssue &&
                    entry.platform &&
                    entry.projectId &&
                    entry.updateCheck === "unavailable" &&
                    updateFiltersReady && (
                      <div className="launchpad-project-issue">
                        {entry.updateIssue}
                      </div>
                    )}
                </div>
                <div className="launchpad-project-action">
                  {(!entry || (entry.platform && entry.projectId)) && (
                    <button
                      className={`btn ${entry && !entry.update ? "" : "primary"}`}
                      aria-label={`${entry?.update ? "Update" : entry ? "Choose version for" : "Install"} ${project.title}`}
                      disabled={
                        !allowChanges ||
                        working ||
                        Boolean(busy) ||
                        Boolean(entry && pendingPaths.has(entry.path)) ||
                        !config.platforms.find(
                          (item) => item.id === project.platform,
                        )?.available
                      }
                      onClick={() => chooseProject(project, entry)}
                    >
                      {entry?.update ? (
                        <RefreshCw size={15} />
                      ) : (
                        <Download size={15} />
                      )}
                      {entry?.update
                        ? "Update"
                        : entry
                          ? "Versions"
                          : "Install"}
                    </button>
                  )}
                  {entry && type !== "modpack" && (
                    <button
                      type="button"
                      className="btn launchpad-remove"
                      aria-label={`Remove ${project.title}`}
                      title={
                        status !== "offline"
                          ? `Stop the server before removing ${contentName}s.`
                          : `Review ${contentName} removal`
                      }
                      disabled={
                        !canInstall ||
                        Boolean(busy) ||
                        pendingPaths.has(entry.path)
                      }
                      onClick={() => void reviewRemoval(entry)}
                    >
                      <Trash2 size={14} /> Remove
                    </button>
                  )}
                </div>
              </article>
            ))}
          </>
        )}
      </section>

      <dialog
        className="modal management-dialog launchpad-dialog"
        ref={dialog}
        aria-labelledby="launchpad-install-title"
        onCancel={(event) => {
          event.preventDefault();
          closeSelection();
        }}
      >
        <form onSubmit={preview}>
          <div className="management-dialog-heading">
            <span className="management-icon">
              <Package size={22} />
            </span>
            <button
              type="button"
              className="btn icon"
              aria-label="Close installation dialog"
              disabled={busy === "install"}
              onClick={closeSelection}
            >
              <X size={18} />
            </button>
          </div>
          <h2 id="launchpad-install-title">
            {plan
              ? "Review installation"
              : selection?.installed?.update
                ? "Update content"
                : "Install content"}
          </h2>
          <div className="launchpad-step">
            <span>Step {plan ? "2" : "1"} of 2</span>
            <span>
              {plan
                ? type === "modpack"
                  ? "Review modpack"
                  : "Review file changes"
                : "Select a version"}
            </span>
          </div>
          <p className="management-dialog-description">
            {selection?.project.title}
          </p>
          {selection?.project.url &&
            /^https:\/\//i.test(selection.project.url) && (
              <a
                href={selection.project.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open project page <ExternalLink size={14} />
              </a>
            )}
          {!plan && selection?.bulk ? (
            <p role="status">
              {busy
                ? "Preparing all updates for one installation…"
                : "Review all available updates together."}
            </p>
          ) : !plan ? (
            <>
              <div className="form-field">
                <label htmlFor="launchpad-target-loader">Target loader</label>
                <select
                  id="launchpad-target-loader"
                  value={targetLoader}
                  required
                  aria-invalid={!targetLoader}
                  aria-describedby={
                    !targetLoader ? "launchpad-loader-notice" : undefined
                  }
                  disabled={Boolean(busy)}
                  onChange={(event) => setTargetLoader(event.target.value)}
                >
                  <option value="">Not selected</option>
                  {loaders.map((value) => (
                    <option key={value} value={value}>
                      {loaderName(value)}
                    </option>
                  ))}
                </select>
                {!targetLoader && (
                  <p
                    id="launchpad-loader-notice"
                    className="management-warning"
                  >
                    Choose a loader to filter compatible versions.
                  </p>
                )}
              </div>
              <div className="form-field">
                <label htmlFor="launchpad-target-minecraft">
                  Target Minecraft version
                </label>
                <select
                  id="launchpad-target-minecraft"
                  value={targetVersion}
                  required
                  disabled={Boolean(busy)}
                  onChange={(event) => setTargetVersion(event.target.value)}
                >
                  <option value="">Select Minecraft version</option>
                  {minecraftVersions.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              {versionsLoading ? (
                <p role="status">Loading compatible versions...</p>
              ) : versionsError ? (
                <div className="launchpad-error" role="alert">
                  <span>{versionsError}</span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setVersionReload((value) => value + 1)}
                  >
                    Try again
                  </button>
                </div>
              ) : (
                <div className="form-field">
                  <label htmlFor="launchpad-target-version">
                    Project version
                  </label>
                  <select
                    id="launchpad-target-version"
                    value={versionId}
                    disabled={Boolean(busy)}
                    required
                    onChange={(event) => setVersionId(event.target.value)}
                  >
                    <option value="">
                      {versions.length
                        ? "Select a version"
                        : "No compatible versions available"}
                    </option>
                    {versions.map((version) => (
                      <option
                        key={version.id}
                        value={version.id}
                        disabled={!version.downloadable}
                      >
                        {version.name || version.version}
                        {!version.downloadable
                          ? " · Manual download required"
                          : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {selectedVersion && (
                <div className="launchpad-version-details">
                  <span>{selectedVersion.gameVersions.join(", ")}</span>
                  <span>
                    {selectedVersion.loaders.map(loaderName).join(", ")}
                  </span>
                  {selectedVersion.publishedAt && (
                    <span>
                      Published{" "}
                      {new Date(
                        selectedVersion.publishedAt,
                      ).toLocaleDateString()}
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            <>
              <p className="management-dialog-description">
                {type === "modpack" ? (
                  <>
                    <strong>{plan.versionName}</strong> will be installed into a
                    clean server folder. The server will remain stopped.
                  </>
                ) : plan.files.length ? (
                  <>
                    <strong>{plan.versionName}</strong> will make these changes
                    to this server. The server will remain stopped.
                  </>
                ) : (
                  <>
                    No file changes are needed for{" "}
                    <strong>{plan.versionName}</strong>.
                  </>
                )}
              </p>
              {type === "modpack" && (
                <div
                  className="launchpad-pack-summary"
                  role="group"
                  aria-label="Modpack installation summary"
                >
                  <span>
                    <strong>
                      {plan.summary?.fileCount ?? plan.files.length}
                    </strong>{" "}
                    files
                  </span>
                  <span>
                    <strong>
                      {formatBytes(
                        plan.summary?.totalBytes ??
                          plan.files.reduce(
                            (total, file) => total + file.size,
                            0,
                          ),
                      )}
                    </strong>{" "}
                    download
                  </span>
                  {plan.runtime && (
                    <span className="launchpad-pack-runtime">
                      <strong>
                        {plan.runtime.software ||
                          loaderName(plan.runtime.provider)}
                      </strong>{" "}
                      {plan.runtime.version} · Build {plan.runtime.build}
                    </span>
                  )}
                </div>
              )}
              {type !== "modpack" &&
                (plan.files.length > 0 ||
                  Boolean(plan.bundledDependencies?.length)) && (
                  <ul
                    className="launchpad-review-files"
                    aria-label="Installation files"
                    tabIndex={0}
                  >
                    {plan.files.map((file) => (
                      <li key={file.path}>
                        <span>
                          {file.path}
                          {file.previousPath &&
                            file.previousPath !== file.path && (
                              <small className="launchpad-previous-path">
                                Replaces {file.previousPath}
                              </small>
                            )}
                        </span>
                        <span
                          className={`launchpad-badge ${file.action === "replace" ? "update" : ""}`}
                        >
                          {file.action === "replace" ? "Replace" : "Install"}
                        </span>
                        <span>{formatBytes(file.size)}</span>
                      </li>
                    ))}
                    {plan.bundledDependencies?.map((dependency, index) => (
                      <li
                        key={`bundled:${dependency.bundledWith}:${dependency.path}:${index}`}
                      >
                        <span>
                          {dependency.title}
                          {dependency.version ? ` ${dependency.version}` : ""}
                          <small className="launchpad-previous-path">
                            Included in{" "}
                            {dependency.bundledWith.split(/[\\/]/).pop()}
                            {dependency.serverCompatible === false
                              ? " · Not active on the server"
                              : ""}
                          </small>
                        </span>
                        <span className="launchpad-badge">Included</span>
                      </li>
                    ))}
                  </ul>
                )}
              {plan.warnings
                .filter(
                  (warning) =>
                    type !== "modpack" ||
                    !/^(?:Skipped |Preserved server data:)/i.test(warning),
                )
                .map((warning) => (
                  <p className="launchpad-review-warning" key={warning}>
                    {warning}
                  </p>
                ))}
              {Boolean(plan.unavailableDependencies?.length) && (
                <div className="launchpad-inline-notice launchpad-dependency-notice">
                  <AlertCircle size={17} />
                  <div>
                    <strong>Some requirements couldn’t be checked</strong>
                    <p>
                      We couldn’t verify every required mod for this
                      installation. Check whether another download is needed
                      before continuing.
                    </p>
                    {plan.unavailableDependencies!.map(
                      (dependency, index) =>
                        dependency.issue && (
                          <p
                            key={`issue:${dependency.platform}:${dependency.projectId ?? ""}:${dependency.versionId ?? ""}:${index}`}
                          >
                            {dependency.issue}
                          </p>
                        ),
                    )}
                    {type !== "modpack" &&
                      Boolean(plan.bundledDependencies?.length) && (
                        <p>
                          The libraries marked Included are packaged in the
                          download, but we couldn’t match them to the missing
                          catalog entry.
                        </p>
                      )}
                    <p>
                      Choose Install anyway to{" "}
                      {type === "modpack"
                        ? "install this modpack"
                        : "install the files listed above"}
                      , or Cancel to check the mod author’s requirements first.
                    </p>
                    <details className="launchpad-dependency-details">
                      <summary>Technical details</summary>
                      <ul aria-label="Unavailable required dependencies">
                        {plan.unavailableDependencies!.map(
                          (dependency, index) => (
                            <li
                              key={`${dependency.platform}:${dependency.projectId ?? ""}:${dependency.versionId ?? ""}:${index}`}
                            >
                              {config.platforms.find(
                                (item) => item.id === dependency.platform,
                              )?.name ?? dependency.platform}
                              {dependency.projectId
                                ? ` project ${dependency.projectId}`
                                : ""}
                              {dependency.versionId
                                ? ` · version ${dependency.versionId}`
                                : ""}
                              {` · required by ${dependency.requiredBy}`}
                            </li>
                          ),
                        )}
                      </ul>
                    </details>
                  </div>
                </div>
              )}
              {type !== "modpack" && plan.files.length > 0 && (
                <p className="management-dialog-description">
                  Review {plan.files.length} file
                  {plan.files.length === 1 ? "" : "s"}
                  {plan.bundledDependencies?.length
                    ? ` and ${plan.bundledDependencies.length} included ${plan.bundledDependencies.length === 1 ? "library" : "libraries"}`
                    : ""}{" "}
                  before continuing.
                </p>
              )}
              {(type === "modpack" || plan.cleanInstall) && (
                <>
                  <div className="launchpad-inline-notice launchpad-clean-warning">
                    <AlertCircle size={17} />
                    <div>
                      <strong>
                        This replaces the server folder’s contents
                      </strong>
                      <p>
                        Existing files, including worlds, mods, plugins and
                        settings, will move to Recycle Bin for recovery. The
                        modpack and its required server software will be
                        installed into a clean folder.
                      </p>
                    </div>
                  </div>
                  <label className="launchpad-clean-confirm">
                    <input
                      type="checkbox"
                      checked={cleanAccepted}
                      disabled={Boolean(busy)}
                      onChange={(event) =>
                        setCleanAccepted(event.target.checked)
                      }
                    />
                    I understand this replaces all files in this server’s
                    folder.
                  </label>
                  {plan.hasExistingContent &&
                    (permissions === undefined ||
                      permissions.includes("backup.create")) && (
                      <label className="launchpad-clean-confirm">
                        <input
                          type="checkbox"
                          checked={backupFirst}
                          disabled={Boolean(busy)}
                          onChange={(event) =>
                            setBackupFirst(event.target.checked)
                          }
                        />
                        Create a backup first
                      </label>
                    )}
                </>
              )}
            </>
          )}
          {!canInstall && (
            <p className="management-form-error" role="alert">
              {!allowChanges
                ? "Your account does not have permission to change server content."
                : working
                  ? "Another installation is still running."
                  : "Stop the server in Console before installing or updating content."}
            </p>
          )}
          {dialogError && (
            <p className="management-form-error" role="alert">
              <AlertCircle size={16} />
              {dialogError}
            </p>
          )}
          <div className="management-dialog-actions">
            <button
              type="button"
              className="btn"
              disabled={busy === "install"}
              onClick={closeSelection}
            >
              Cancel
            </button>
            {plan ? (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={Boolean(busy)}
                  onClick={() => {
                    if (selection?.bulk) {
                      closeSelection();
                      return;
                    }
                    setPlan(null);
                    setCleanAccepted(false);
                    setDialogError("");
                  }}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={
                    Boolean(busy) ||
                    !canInstall ||
                    (type !== "modpack" && plan.files.length === 0) ||
                    ((type === "modpack" || plan.cleanInstall) &&
                      !cleanAccepted)
                  }
                  onClick={() => void install()}
                >
                  {busy === "install" ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Download size={15} />
                  )}
                  {busy === "install"
                    ? "Starting installation..."
                    : type !== "modpack" && plan.files.length === 0
                      ? "Already up to date"
                      : plan.unavailableDependencies?.length
                        ? "Install anyway"
                        : "Confirm installation"}
                </button>
              </>
            ) : (
              <button
                type="submit"
                className="btn primary"
                disabled={
                  Boolean(busy) ||
                  !canInstall ||
                  !targetVersion.trim() ||
                  !targetLoader ||
                  (!selection?.bulk &&
                    (!selectedVersion?.downloadable || versionsLoading))
                }
              >
                {busy === "preview" ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <ArrowRight size={15} />
                )}
                {busy === "preview"
                  ? "Preparing review..."
                  : selection?.bulk
                    ? "Review updates"
                    : "Review installation"}
              </button>
            )}
          </div>
        </form>
      </dialog>
      <dialog
        className="modal management-dialog launchpad-dialog launchpad-removal-dialog"
        ref={removalDialog}
        aria-labelledby="launchpad-removal-title"
        onCancel={(event) => {
          event.preventDefault();
          closeRemoval();
        }}
      >
        <div className="management-dialog-heading">
          <span className="management-icon">
            <Trash2 size={22} />
          </span>
          <button
            type="button"
            className="btn icon"
            aria-label={`Close ${contentName} removal`}
            disabled={busy === "remove"}
            onClick={closeRemoval}
          >
            <X size={18} />
          </button>
        </div>
        <h2 id="launchpad-removal-title">
          {removalPlan?.blocked
            ? removalPlan.dependents.length
              ? "Mod removal blocked"
              : "Dependency check incomplete"
            : `Remove ${contentName}`}
        </h2>
        <p className="management-dialog-description">
          <strong>
            {removalPlan?.title || removal?.title || removal?.name}
          </strong>
        </p>
        {busy === "removal-preview" && (
          <p className="management-dialog-description" role="status">
            {type === "mod"
              ? "Checking installed dependencies…"
              : "Checking the installed file…"}
          </p>
        )}
        {removalPlan && (
          <>
            <ul className="launchpad-review-files" aria-label="Files to remove">
              {removalPlan.files.map((file) => (
                <li key={file.path}>
                  <span>{file.path}</span>
                  <span>{formatBytes(file.size)}</span>
                </li>
              ))}
            </ul>
            {removalPlan.dependents.length > 0 && (
              <div className="launchpad-removal-dependencies">
                <p>Remove these dependent mods first:</p>
                <ul aria-label="Mods requiring this mod" tabIndex={0}>
                  {removalPlan.dependents.map((item) => (
                    <li key={item.path}>
                      <strong>{item.title}</strong>
                      <span>{item.path}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {removalPlan.warnings.length > 0 && (
              <div className="launchpad-inline-notice">
                <AlertCircle size={18} />
                <div>
                  <strong>Some dependencies could not be checked</strong>
                  <p>
                    Dependency information could not be read from{" "}
                    {removalPlan.warnings.length} installed{" "}
                    {removalPlan.warnings.length === 1 ? "file" : "files"}.
                    Their requirements are still unknown.
                  </p>
                  <details className="launchpad-update-issues">
                    <summary>View affected files</summary>
                    <ul
                      aria-label="Files with unreadable dependencies"
                      tabIndex={0}
                    >
                      {removalPlan.warnings.map((warning, index) => (
                        <li key={`${index}:${warning}`}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                </div>
              </div>
            )}
            {!removalPlan.blocked && (
              <p className="management-dialog-description">
                This file will move to Recycle Bin, where you can restore it.
                Other files will stay installed.
              </p>
            )}
            {removalPlan.requiresAcknowledgement && !removalPlan.blocked && (
              <label className="launchpad-clean-confirm">
                <input
                  type="checkbox"
                  checked={removalAcknowledged}
                  onChange={(event) =>
                    setRemovalAcknowledged(event.target.checked)
                  }
                  disabled={Boolean(busy)}
                />
                I understand that unreadable dependencies may require this file.
              </label>
            )}
            {removalPlan.blocked && (
              <p className="management-dialog-description">
                Inspect or repair the listed files in{" "}
                <a href="#files" onClick={closeRemoval}>
                  File Manager
                </a>
                , then review removal again.
              </p>
            )}
          </>
        )}
        {!canInstall && (
          <p className="management-form-error" role="alert">
            {!allowChanges
              ? "Your account does not have permission to change server content."
              : working
                ? `Wait for the installation to finish before removing ${contentName}s.`
                : `Stop the server in Console before removing ${contentName}s.`}
          </p>
        )}
        {removalError && (
          <p className="management-form-error" role="alert">
            {removalError}
          </p>
        )}
        <div className="management-dialog-actions">
          <button
            type="button"
            className="btn"
            disabled={busy === "remove"}
            onClick={closeRemoval}
          >
            {removalPlan?.blocked ? "Close" : "Cancel"}
          </button>
          {removalPlan && !removalPlan.blocked ? (
            <button
              type="button"
              className="btn danger"
              disabled={
                Boolean(busy) ||
                !canInstall ||
                !removalPlan.planId ||
                Boolean(
                  removalPlan.requiresAcknowledgement && !removalAcknowledged,
                )
              }
              onClick={() => void removeMod()}
            >
              {busy === "remove" ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Trash2 size={15} />
              )}
              {busy === "remove" ? "Removing…" : `Remove ${contentName}`}
            </button>
          ) : removalError && removal ? (
            <button
              type="button"
              className="btn"
              disabled={Boolean(busy) || !canInstall}
              onClick={() => void reviewRemoval(removal)}
            >
              Try again
            </button>
          ) : null}
        </div>
      </dialog>
      <dialog
        className="modal management-dialog launchpad-dialog"
        ref={settingsDialog}
        aria-labelledby="launchpad-settings-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) {
            setSettingsOpen(false);
            setApiKey("");
          }
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (apiKey.trim()) void saveKey(apiKey);
          }}
        >
          <div className="management-dialog-heading">
            <span className="management-icon">
              <KeyRound size={22} />
            </span>
            <button
              type="button"
              className="btn icon"
              aria-label="Close platform settings"
              disabled={Boolean(busy)}
              onClick={() => {
                setSettingsOpen(false);
                setApiKey("");
              }}
            >
              <X size={18} />
            </button>
          </div>
          <h2 id="launchpad-settings-title">Platform settings</h2>
          <p className="management-dialog-description">
            CurseForge requires an API key. It is stored privately on the
            computer running this panel.
          </p>
          <div className="form-field">
            <label htmlFor="launchpad-api-key">CurseForge API key</label>
            <input
              id="launchpad-api-key"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={apiKey}
              disabled={Boolean(busy)}
              placeholder={
                keySource?.keyConfigured
                  ? "Enter a replacement key"
                  : "Enter your API key"
              }
              onChange={(event) => setApiKey(event.target.value)}
            />
            <small>
              {keySource?.keyConfigured
                ? "An API key is configured. Its value is never sent back to the browser."
                : "No API key is configured."}
            </small>
          </div>
          {settingsError && (
            <p role="alert" className="management-form-error">
              {settingsError}
            </p>
          )}
          <div className="management-dialog-actions">
            <button
              type="button"
              className="btn"
              disabled={Boolean(busy)}
              onClick={() => {
                setSettingsOpen(false);
                setApiKey("");
              }}
            >
              Cancel
            </button>
            {keySource?.keyConfigured && (
              <button
                type="button"
                className="btn"
                disabled={Boolean(busy)}
                onClick={() => void saveKey("")}
              >
                Remove saved key
              </button>
            )}
            <button
              type="submit"
              className="btn primary"
              disabled={Boolean(busy) || !apiKey.trim()}
            >
              {busy === "settings" ? "Saving..." : "Save API key"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
