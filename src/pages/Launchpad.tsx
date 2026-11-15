import {
  Fragment,
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
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
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
  Trash2,
  X,
} from "lucide-react";
import {
  formatBytes,
  messageOf,
  ServerScope,
  PanelScope,
  useServerApi,
  type PageProps,
} from "../api";
import { canChangeContent } from "../page-permissions";
import SearchField, { useDebouncedValue } from "../SearchField";
import RefreshButton from "../RefreshButton";
import StatePanel from "../StatePanel";
import Pagination, { defaultPageSizes } from "../Pagination";
import { setSetupModpack } from "../setup-handoff";
import DownloadButton from "../DownloadButton";
import Switch from "../Switch";
import {
  readPreference,
  writePreference,
  remoteLaunchpadViewKey,
} from "../preferences";
import {
  projectPageUrl,
  safeProjectUrl,
} from "../../shared/launchpad-project.mjs";
import {
  allModCategories,
  matchesCategories,
  supportsCategory,
} from "../../shared/launchpad-categories.mjs";
import LaunchpadCategoryFilters from "./LaunchpadCategoryFilters";
import "./management.css";
import "./launchpad.css";

type UpdateChannel = "installed" | "release" | "beta" | "alpha";
const channelLabel = (value?: string) =>
  value === "beta" ? "Beta" : value === "alpha" ? "Alpha" : "";
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
  channel?: string;
  versionType?: string;
  serverCompatible?: boolean;
  unavailableReason?: string;
  reason?: string;
};
type Project = {
  id: string;
  platform: string;
  title: string;
  description: string;
  iconUrl?: string | null;
  downloads?: number;
  author?: string;
  authorLinks?: { name: string; url?: string }[];
  url?: string;
  releasedAt?: string;
  updatedAt?: string;
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
  channel?: string;
  updateHeld?: boolean;
  previousVersionId?: string;
  previousVersionName?: string;
  title?: string;
  iconUrl?: string;
  author?: string;
  authorLinks?: Project["authorLinks"];
  update?: Version | null;
  url?: string;
  updateCheck?: "checked" | "unavailable" | "pending";
  updateIssue?: string;
  active?: boolean;
  modifiedAt?: string;
  addedAt?: string;
  categories?: string[];
  mainCategory?: string;
  downloads?: number;
  follows?: number;
  featured?: boolean;
  updatedAt?: string;
  releasedAt?: string;
  gameVersions?: string[];
};
type Job = {
  id: string;
  planId?: string;
  status: "queued" | "running" | "completed" | "failed";
  message: string;
  completed: number;
  total: number;
  error?: string;
  retryable?: boolean;
  cancellable?: boolean;
  cancelled?: boolean;
  recoveryRequired?: boolean;
  retainedRecoveryPath?: string;
  retryInput?: {
    planId: string;
    confirmed: true;
    cleanInstall?: true;
    acknowledgedUnavailableDependencies?: true;
  };
  recoveryEntries?: unknown[];
  undoAvailable?: boolean;
};
type ContentOperation = {
  jobId: string;
  kind: string;
  title: string;
  createdAt: string;
  undoAvailable: boolean;
  undoneAt?: string;
};
type Config = {
  updateChannel?: UpdateChannel;
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
        channel: item.channel ?? old.channel,
        updateHeld: item.updateHeld ?? old.updateHeld,
        previousVersionId: item.previousVersionId ?? old.previousVersionId,
        previousVersionName:
          item.previousVersionName ?? old.previousVersionName,
        title: old.title ?? item.title,
        iconUrl: old.iconUrl ?? item.iconUrl,
        author: old.author ?? item.author,
        authorLinks: old.authorLinks ?? item.authorLinks,
        url: old.url ?? item.url,
        update: old.update !== undefined ? old.update : item.update,
        updateCheck: old.updateCheck ?? item.updateCheck,
        updateIssue: old.updateIssue ?? item.updateIssue,
        categories: old.categories ?? item.categories,
        mainCategory: old.mainCategory ?? item.mainCategory,
        downloads: old.downloads ?? item.downloads,
        follows: old.follows ?? item.follows,
        featured: old.featured ?? item.featured,
        updatedAt: old.updatedAt ?? item.updatedAt,
        releasedAt: old.releasedAt ?? item.releasedAt,
        gameVersions: old.gameVersions ?? item.gameVersions,
      };
    }),
  };
}
type DependencyDecision = {
  key: string;
  title: string;
  installedVersion?: string;
  proposedVersion?: string;
  installedPath?: string;
  requiredBy?: string[];
  choice: string;
  allowedChoices: string[];
  status: string;
  direction?: string;
  warning?: string;
};
type RuntimeRequirement = {
  mod: string;
  path: string;
  id: string;
  range: unknown;
  installed?: string;
  status: string;
};
type Plan = {
  planId: string;
  title: string;
  versionName: string;
  channel?: string;
  expiresAt: string;
  dependencyDecisions?: DependencyDecision[];
  runtimeRequirements?: RuntimeRequirement[];
  skippedUpdates?: { title?: string; projectId: string; reason: string }[];
  files: {
    path: string;
    title?: string;
    size: number;
    action: "install" | "replace";
    previousPath?: string;
    installedVersion?: string;
    proposedVersion?: string;
    channel?: string;
    direction?: string;
    installReason?: string;
    requiredBy?: string[];
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
  includesDependents?: boolean;
  orphanCandidates?: { path: string; title?: string }[];
};
const kinds = [
  { id: "modpack", label: "Modpacks", icon: Layers3 },
  { id: "mod", label: "Mods", icon: Puzzle },
  { id: "datapack", label: "Datapacks", icon: FileCode2 },
  { id: "plugin", label: "Plugins", icon: Package },
] as const;
const rowsOptions = defaultPageSizes;
const installedSortOptions = [
  { id: "active", label: "Active" },
  { id: "added", label: "Date added" },
  { id: "modified", label: "Date modified" },
  { id: "name", label: "Name" },
  { id: "author", label: "Author" },
  { id: "featured", label: "Featured" },
  { id: "relevance", label: "Relevancy" },
  { id: "popular", label: "Popularity" },
  { id: "updated", label: "Latest Update" },
  { id: "newest", label: "Release Date" },
  { id: "downloads", label: "Total Downloads" },
  { id: "category", label: "Main Category" },
  { id: "gameVersion", label: "Game Version" },
] as const;
const installedColumnSorts = ["active", "added", "modified"] as const;
type InstalledSort =
  | (typeof installedSortOptions)[number]["id"]
  | (typeof installedColumnSorts)[number];
type SortDirection = "asc" | "desc";
const defaultInstalledDirection = (sort: InstalledSort): SortDirection =>
  ["name", "author", "category"].includes(sort) ? "asc" : "desc";

// Retain dismissals across page navigation, including a slow or offline remote
// panel. Scope them to the server/account rather than hiding another panel's job.
const dismissedJobs = new Map<string, Set<string>>();
function rememberDismissedJob(scope: string, id: string) {
  const ids = dismissedJobs.get(scope) ?? new Set<string>();
  ids.add(id);
  while (ids.size > 50) ids.delete(ids.values().next().value!);
  dismissedJobs.set(scope, ids);
  while (dismissedJobs.size > 100)
    dismissedJobs.delete(dismissedJobs.keys().next().value!);
}
type SavedView = {
  platform?: string;
  type?: ContentType;
  gameVersion?: string;
  loader?: string;
  installedOnly?: boolean;
  sort?: string;
  installedSort?: InstalledSort;
  installedDirection?: SortDirection;
  categories?: string[];
  runtime?: string;
};
function readSavedView(key: string): SavedView {
  try {
    const raw = readPreference(key, "session");
    if (!raw || raw.length > 4096) return {};
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    const values = saved as Record<string, unknown>;
    return {
      runtime: typeof values.runtime === "string" ? values.runtime : undefined,
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
      installedSort: [
        ...installedSortOptions.map((item) => item.id),
        ...installedColumnSorts,
      ].some((id) => id === values.installedSort)
        ? (values.installedSort as InstalledSort)
        : undefined,
      installedDirection:
        values.installedDirection === "asc" ||
        values.installedDirection === "desc"
          ? values.installedDirection
          : undefined,
      categories: Array.isArray(values.categories)
        ? values.categories
            .filter(
              (value): value is string =>
                typeof value === "string" &&
                allModCategories.some((item) => item.id === value),
            )
            .slice(0, 10)
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
  direction: SortDirection,
  query = "",
) {
  const alphabetical = (left: string, right: string) =>
    left.localeCompare(right, undefined, {
      sensitivity: "base",
      numeric: true,
    });
  // Updates are a permanent first group. Direction only changes order inside
  // each group, across the entire inventory before pagination.
  const updates = Number(Boolean(b.update)) - Number(Boolean(a.update));
  if (updates) return updates;
  let order = 0;
  const sign = direction === "asc" ? 1 : -1;
  const date = (value?: string) =>
    Number.isFinite(Date.parse(value ?? "")) ? Date.parse(value!) : undefined;
  const text = (left = "", right = "") =>
    Number(!left) - Number(!right) || sign * alphabetical(left, right);
  const number = (left?: number, right?: number) => {
    const missingLeft = !Number.isFinite(left),
      missingRight = !Number.isFinite(right);
    return (
      Number(missingLeft) - Number(missingRight) ||
      (missingLeft ? 0 : sign * (left! - right!))
    );
  };
  if (sort === "name") {
    order = text(a.title?.trim() || a.name, b.title?.trim() || b.name);
  } else if (sort === "active") {
    order = number(Number(a.active !== false), Number(b.active !== false));
  } else if (sort === "featured") {
    order = number(Number(Boolean(a.featured)), Number(Boolean(b.featured)));
  } else if (sort === "relevance" && query) {
    const score = (item: InstalledItem) => {
      const title = (item.title || item.name).toLowerCase();
      return title === query
        ? 3
        : title.startsWith(query)
          ? 2
          : title.includes(query)
            ? 1
            : 0;
    };
    order = number(score(a), score(b));
  } else if (sort === "downloads" || sort === "popular") {
    const score = (item: InstalledItem) =>
      sort === "popular" ? (item.follows ?? item.downloads) : item.downloads;
    order = number(score(a), score(b));
  } else if (
    sort === "updated" ||
    sort === "newest" ||
    sort === "modified" ||
    sort === "added"
  ) {
    const key =
      sort === "updated"
        ? "updatedAt"
        : sort === "newest"
          ? "releasedAt"
          : sort === "added"
            ? "addedAt"
            : "modifiedAt";
    order = number(date(a[key]), date(b[key]));
  } else if (sort === "category") {
    const category = (item: InstalledItem) =>
      allModCategories.find((category) => category.id === item.mainCategory)
        ?.label ?? item.mainCategory;
    order = text(category(a), category(b));
  } else if (sort === "gameVersion") {
    const latest = (item: InstalledItem) =>
      [...(item.gameVersions ?? [])].sort(alphabetical).at(-1) ?? "";
    const left = latest(a),
      right = latest(b);
    order = text(left, right);
  } else if (sort === "author") {
    const left = a.author?.trim() ?? "";
    const right = b.author?.trim() ?? "";
    order = text(left, right);
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
function ProjectAuthors({ project }: { project: Project }) {
  if (project.authorLinks?.length)
    return (
      <span>
        By{" "}
        {project.authorLinks.map((author, index) => {
          const url = safeProjectUrl(author.url);
          return (
            <Fragment key={`${author.name}:${index}`}>
              {index > 0 && ", "}
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {author.name}
                </a>
              ) : (
                author.name
              )}
            </Fragment>
          );
        })}
      </span>
    );
  return project.author ? (
    <span>By {project.author}</span>
  ) : (
    <span className="launchpad-unknown-author">Unknown</span>
  );
}
function InstalledDate({
  value,
  kind,
}: {
  value?: string;
  kind: "added" | "modified";
}) {
  const date = value ? new Date(value) : null;
  return (
    <div className={`launchpad-installed-date launchpad-date-${kind}`}>
      <span className="launchpad-sr-only">
        {kind === "added" ? "Date added: " : "Date modified: "}
      </span>
      {date && Number.isFinite(date.getTime()) ? (
        <time dateTime={value} title={date.toLocaleString()}>
          <span>
            {date.toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })}
          </span>
          <small>
            {date.toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            })}
          </small>
        </time>
      ) : (
        <span>Unavailable</span>
      )}
    </div>
  );
}

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
  onCreateServer,
}: PageProps & { permissions?: string[]; onCreateServer?: () => void }) {
  const allowChanges = canChangeContent(permissions);
  const canChangeUpdateChannel =
    permissions === undefined || permissions.includes("server.update");
  const { api, post, downloadUrl } = useServerApi();
  const serverId = useContext(ServerScope);
  const panel = useContext(PanelScope);
  const viewKey =
    panel && panel.panelId !== "local"
      ? remoteLaunchpadViewKey(
          panel.panelId,
          panel.accountId ?? panel.sessionEpoch,
          serverId ?? "default",
        )
      : `mc-panel.launchpad.view.${serverId ?? "default"}`;
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
  const filteredQuery = useDebouncedValue(query, 150);
  const [sort, setSort] = useState("downloads");
  const [installedSort, setInstalledSort] = useState<InstalledSort>("name");
  const [installedDirection, setInstalledDirection] =
    useState<SortDirection>("asc");
  const [installedOnly, setInstalledOnly] = useState(false);
  const modeQueries = useRef({ browse: "", installed: "" });
  const [selectedPaths, setSelectedPaths] = useState(new Set<string>());
  const [selectionBatch, setSelectionBatch] = useState<{
    action: "remove" | "disable";
    items: InstalledItem[];
    total: number;
  } | null>(null);
  const selectionStarted = useRef<string | null>(null);
  const [selectionOutcome, setSelectionOutcome] = useState<{
    action: "remove" | "disable";
    total: number;
    remaining: string[];
    status: "running" | "cancelled" | "failed" | "complete";
  } | null>(null);
  const [dependencySummary, setDependencySummary] = useState<{
    dependencies: {
      title: string;
      relation: string;
      installedVersion?: string;
      proposedVersion?: string;
      status: string;
      installedPath?: string;
    }[];
    warnings: string[];
    declarationsAvailable?: boolean;
  } | null>(null);
  const [dependencySummaryLoading, setDependencySummaryLoading] =
    useState(false);
  const [dependencySummaryError, setDependencySummaryError] = useState("");

  const [categories, setCategories] = useState<string[]>([]);
  const categoryKey =
    type === "mod"
      ? categories
          .filter((id) => installedOnly || supportsCategory(id, platform))
          .join(",")
      : "";
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
  const resultsElement = useRef<HTMLElement>(null);
  const resultsScope = useRef("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const loaders = loadersFor(type).filter(
    (value) => !config?.loaders || config.loaders.includes(value),
  );
  // Installed updates and individual content installs target this server, even
  // when catalog filters are set to another Minecraft version or loader.
  const contentGameVersion = config?.gameVersion
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
    config?.updateChannel ?? "installed",
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
  const catalogRefresh = useRef(false);
  const scanEpoch = useRef(0);
  const forceScan = useRef<{ api: typeof api; token: number } | null>(null);
  const refreshSequence = useRef(0);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const manualCompletion = useRef<((success: boolean) => void) | null>(null);
  const [pendingPaths, setPendingPaths] = useState<Set<string>>(new Set());
  const reloadContent = useCallback(() => {
    catalogRefresh.current = true;
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
  const [manualRuntimeAcknowledged, setManualRuntimeAcknowledged] =
    useState(false);
  const [backupFirst, setBackupFirst] = useState(false);
  const [preserveWorld, setPreserveWorld] = useState(true);
  const backupForSelection = useRef(false);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [dependencyProblems, setDependencyProblems] = useState<
    DependencyDecision[]
  >([]);
  const [runtimeProblems, setRuntimeProblems] = useState<RuntimeRequirement[]>(
    [],
  );
  const [selectedUpdatePaths, setSelectedUpdatePaths] =
    useState<Set<string> | null>(null);
  const [activation, setActivation] = useState<{
    entry: InstalledItem;
    active: boolean;
    warnings: string[];
  } | null>(null);
  const [keepCurrentReview, setKeepCurrentReview] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contentHistory, setContentHistory] = useState<ContentOperation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [undoReview, setUndoReview] = useState<{
    jobId: string;
    title: string;
  } | null>(null);
  const [undoNotice, setUndoNotice] = useState<{
    jobId: string;
    title: string;
  } | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const [undoError, setUndoError] = useState("");
  const historyDialog = useRef<HTMLDialogElement>(null);
  const undoDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (historyOpen) historyDialog.current?.showModal();
    else historyDialog.current?.close();
  }, [historyOpen]);
  useEffect(() => {
    if (undoReview) undoDialog.current?.showModal();
    else undoDialog.current?.close();
  }, [undoReview]);
  const [clientPack, setClientPack] = useState<{
    filename: string;
    files: number;
    warnings: string[];
  } | null>(null);
  const [clientPackBusy, setClientPackBusy] = useState(false);
  const clientPackDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (clientPack) clientPackDialog.current?.showModal();
    else clientPackDialog.current?.close();
  }, [clientPack]);
  async function reviewClientPack() {
    if (clientPackBusy) return;
    const currentSession = session.current;
    setClientPackBusy(true);
    try {
      const result = await api<{
        filename: string;
        files: number;
        warnings: string[];
      }>("/launchpad/client-pack/preview");
      if (currentSession === session.current) setClientPack(result);
    } catch (cause) {
      if (currentSession === session.current) notify(messageOf(cause), true);
    } finally {
      if (currentSession === session.current) setClientPackBusy(false);
    }
  }
  const activationDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (activation) activationDialog.current?.showModal();
    else activationDialog.current?.close();
  }, [activation]);
  const [dialogError, setDialogError] = useState("");
  const [removal, setRemoval] = useState<InstalledItem | null>(null);
  const [removalPlan, setRemovalPlan] = useState<RemovalPlan | null>(null);
  const [removalError, setRemovalError] = useState("");
  const [removalAcknowledged, setRemovalAcknowledged] = useState(false);
  const [removalDependentsAccepted, setRemovalDependentsAccepted] =
    useState(false);
  const [busy, setBusy] = useState<
    | "preview"
    | "install"
    | "settings"
    | "removal-preview"
    | "remove"
    | "active"
    | null
  >(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState("");
  const [jobReload, setJobReload] = useState(0);
  const [jobAction, setJobAction] = useState(false);
  const jobActionPending = useRef(false);
  const jobEpoch = useRef(0);
  const unavailableJobs = useRef(new Set<string>());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const session = useRef(0);
  const operation = useRef(0);
  const pending = useRef(false);
  const previewRequest = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const removalDialog = useRef<HTMLDialogElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const completedJob = useRef<{ scope: string; id: string } | null>(null);
  const source = config?.platforms.find((item) => item.id === platform);
  const inventoryReady = Boolean(config);
  const sortOptions = source?.sortOptions ?? [];
  const catalogSort = sortOptions.some((item) => item.id === sort)
    ? sort
    : (sortOptions[0]?.id ?? "");
  const supported = Boolean(source?.types.includes(type));
  const working = Boolean(job && ["queued", "running"].includes(job.status));
  const updateProjectCounts = new Map<string, number>();
  for (const item of installed?.items ?? [])
    if (item.projectId && item.platform) {
      const key = `${item.platform}:${item.projectId}`;
      updateProjectCounts.set(key, (updateProjectCounts.get(key) || 0) + 1);
    }
  const duplicateUpdateCount = (installed?.items ?? []).filter(
    (item) =>
      item.update &&
      !item.updateHeld &&
      (updateProjectCounts.get(`${item.platform}:${item.projectId}`) || 0) > 1,
  ).length;
  const availableUpdates = (installed?.items ?? []).filter(
    (item) =>
      item.update &&
      !item.updateHeld &&
      (updateProjectCounts.get(`${item.platform}:${item.projectId}`) || 0) <=
        1 &&
      item.platform &&
      item.projectId &&
      !pendingPaths.has(item.path),
  );
  const canRecover = allowChanges && status === "offline" && !working;
  const canInstall = canRecover && !job?.recoveryRequired;
  const changeDisabledReason = !allowChanges
    ? "Your account cannot change server content."
    : working
      ? "An installation is running."
      : job?.recoveryRequired
        ? "Resolve the interrupted installation before changing files."
        : status !== "offline"
          ? "Stop the server in Console before changing content."
          : busy
            ? "Another action is in progress."
            : "";
  const canDismissJob =
    permissions === undefined || permissions.includes("file.update");
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
          typeof value === "string" &&
          Boolean(value) &&
          (value === config?.gameVersion || /^\d+(?:\.\d+)+$/.test(value)),
      ),
    ),
  ];

  const loadConfig = useCallback(
    async (initial = false, fresh = false) => {
      const current = session.current;
      const currentOperation = operation.current;
      const epoch = jobEpoch.current;
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
        // Refresh can discover an accepted installation whose POST response was
        // lost. Older reads must not replace a newer submission, poll or action.
        if (
          epoch === jobEpoch.current &&
          currentOperation === operation.current &&
          !jobActionPending.current &&
          !pending.current &&
          (!next.job || !unavailableJobs.current.has(next.job.id)) &&
          (next.job || initial)
        ) {
          jobEpoch.current++;
          setJob(
            next.job && !dismissedJobs.get(viewKey)?.has(next.job.id)
              ? next.job
              : null,
          );
          setJobError("");
        }
        if (initial) {
          const saved = readSavedView(viewKey);
          if (
            saved.runtime &&
            saved.runtime !== `${next.gameVersion}:${next.loader}`
          ) {
            delete saved.gameVersion;
            delete saved.loader;
          }
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
              : next.gameVersion
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
          setInstalledSort(saved.installedSort ?? "name");
          setInstalledDirection(
            saved.installedDirection ??
              defaultInstalledDirection(saved.installedSort ?? "name"),
          );
          setCategories(saved.categories ?? []);
          setViewReady(viewKey);
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
    catalogRefresh.current = true;
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

  const dismissCompletedJob = useCallback(
    (id: string) => {
      rememberDismissedJob(viewKey, id);
      if (canDismissJob) {
        void api(`/launchpad/jobs/${encodeURIComponent(id)}/dismiss`, {
          method: "POST",
          keepalive: true,
        }).catch(() => {});
      }
    },
    [api, canDismissJob, viewKey],
  );

  useEffect(() => {
    completedJob.current =
      job?.status === "completed" && !job.recoveryRequired
        ? { scope: viewKey, id: job.id }
        : null;
    if (!completedJob.current) return;
    const id = completedJob.current.id;
    const timer = window.setTimeout(() => {
      dismissCompletedJob(id);
      jobEpoch.current++;
      setJob((current) => (current?.id === id ? null : current));
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [
    job?.id,
    job?.status,
    job?.recoveryRequired,
    viewKey,
    dismissCompletedJob,
  ]);

  useEffect(
    () => () => {
      const last = completedJob.current;
      if (last?.scope === viewKey) dismissCompletedJob(last.id);
    },
    [viewKey, dismissCompletedJob],
  );

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
    jobActionPending.current = false;
    jobEpoch.current++;
    unavailableJobs.current.clear();
    setHistoryOpen(false);
    setContentHistory([]);
    setUndoReview(null);
    setUndoNotice(null);
    setUndoBusy(false);
    setHistoryLoading(false);
    setClientPack(null);
    setClientPackBusy(false);
    setActivation(null);
    setKeepCurrentReview(false);
    setJobAction(false);
    setViewReady(null);
    setConfig(null);
    setResults(null);
    setInventory(null);
    inventoryRef.current = null;
    inventoryCache.current.clear();
    cancelSelectionBatch();
    setSelectedPaths(new Set());
    modeQueries.current = { browse: "", installed: "" };
    setSelectionOutcome(null);
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
    setInstalledSort("name");
    setInstalledDirection("asc");
    setOffset(0);
    setInstalledOnly(false);
    setCategories([]);
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
      previewRequest.current?.abort();
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
          installedDirection,
          categories,
          runtime: `${config.gameVersion}:${config.loader}`,
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
    installedDirection,
    categories,
  ]);

  useEffect(() => {
    if (!config || installedOnly || !source?.available || !supported) {
      setSearchLoading(false);
      setSearchError("");
      setResults(null);
      return;
    }
    // Only typing waits for a pause. Paging, filter changes and refreshes can
    // start immediately, without the former unconditional 300 ms timer.
    if (query.trim() !== filteredQuery.trim()) {
      setSearchLoading(true);
      setSearchError("");
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
      categoryKey,
      offset,
      limit,
    ]);
    if (resultsScope.current !== scope) {
      resultsScope.current = scope;
    }
    setSearchLoading(true);
    setSearchError("");
    const refresh = catalogRefresh.current;
    catalogRefresh.current = false;
    void api<SearchResult>(
      `/launchpad/search?${queryString({ platform, type, query: query.trim(), gameVersion: gameVersion.trim(), loader, sort: catalogSort, ...(categoryKey ? { categories: categoryKey } : {}), offset, limit, ...(refresh ? { refresh: "true" } : {}) })}`,
      { signal: controller.signal },
    )
      .then((next) => {
        if (controller.signal.aborted) return;
        if (next.offset !== offset) setOffset(next.offset);
        else if (offset > 0 && offset >= next.total)
          setOffset(Math.max(0, Math.ceil(next.total / limit) - 1) * limit);
        else setResults(next);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setSearchError(messageOf(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setSearchLoading(false);
      });
    return () => {
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
    filteredQuery,
    catalogSort,
    categoryKey,
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
            ) ??
            next.versions.find(
              (version) =>
                version.downloadable &&
                !["alpha", "beta", "snapshot"].includes(
                  version.channel || version.versionType || "",
                ),
            ) ??
            next.versions.find((version) => version.downloadable);
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
      if (jobActionPending.current) {
        timer = window.setTimeout(poll, 1000);
        return;
      }
      const epoch = jobEpoch.current;
      try {
        const next = await api<{ job: Job }>(
          `/launchpad/jobs/${encodeURIComponent(job.id)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (epoch !== jobEpoch.current) {
          timer = window.setTimeout(poll, 1000);
          return;
        }
        jobEpoch.current++;
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
          if (epoch !== jobEpoch.current) {
            timer = window.setTimeout(poll, 1000);
            return;
          }
          if ((cause as { status?: number }).status === 404) {
            unavailableJobs.current.add(job.id);
            jobEpoch.current++;
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

  useEffect(() => {
    let pendingRead = false,
      active = true;
    const timer = window.setInterval(async () => {
      if (
        pendingRead ||
        document.visibilityState === "hidden" ||
        pending.current
      )
        return;
      pendingRead = true;
      try {
        if (active) await loadConfig(false);
      } finally {
        pendingRead = false;
      }
    }, 10000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadConfig]);

  async function actOnJob(action: "cancel" | "recover" | "keep") {
    if (
      !job ||
      !allowChanges ||
      (action !== "cancel" && !canRecover) ||
      jobActionPending.current
    )
      return;
    const currentSession = session.current;
    const id = job.id;
    jobActionPending.current = true;
    jobEpoch.current++;
    setJobAction(true);
    try {
      const result = await post<{ job?: Job }>(
        action === "cancel"
          ? `/launchpad/jobs/${encodeURIComponent(id)}/cancel`
          : "/launchpad/recovery/resolve",
        action === "keep" ? { keepCurrent: true, confirmed: true } : {},
      );
      setKeepCurrentReview(false);
      if (session.current === currentSession && result.job)
        setJob((current) =>
          current?.id === id && result.job?.id === id ? result.job : current,
        );
    } catch (cause) {
      if (session.current === currentSession) notify(messageOf(cause), true);
    } finally {
      if (session.current === currentSession) {
        jobActionPending.current = false;
        jobEpoch.current++;
        setJobAction(false);
        setJobReload((value) => value + 1);
      }
    }
  }

  async function openContentHistory() {
    const currentSession = session.current;
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const result = await api<{ operations: ContentOperation[] }>(
        "/launchpad/history",
      );
      if (currentSession === session.current)
        setContentHistory(result.operations);
    } catch (cause) {
      if (currentSession === session.current) setHistoryError(messageOf(cause));
    } finally {
      if (currentSession === session.current) setHistoryLoading(false);
    }
  }
  function reviewUndo(jobId: string, title: string) {
    setHistoryOpen(false);
    setUndoError("");
    setUndoReview({ jobId, title });
  }
  async function undoContent() {
    if (!undoReview || undoBusy || !canInstall) return;
    const currentSession = session.current;
    setUndoBusy(true);
    setUndoError("");
    try {
      await api(
        `/launchpad/jobs/${encodeURIComponent(undoReview.jobId)}/undo`,
        { method: "POST", body: JSON.stringify({ confirmed: true }) },
      );
      if (currentSession === session.current) {
        setUndoReview(null);
        setUndoNotice(null);
        setJob(null);
        await refreshInstalled();
        notify(
          "Previous files and version records restored. Restored versions are held from automatic updates.",
        );
      }
    } catch (cause) {
      if (currentSession === session.current) setUndoError(messageOf(cause));
    } finally {
      if (currentSession === session.current) setUndoBusy(false);
    }
  }
  async function saveUpdateChannel(updateChannel: UpdateChannel) {
    if (pending.current || !canChangeUpdateChannel) return;
    const currentSession = session.current;
    pending.current = true;
    setBusy("active");
    try {
      const saved = await api<{ updateChannel: UpdateChannel }>(
        "/launchpad/update-policy",
        {
          method: "PATCH",
          body: JSON.stringify({ updateChannel }),
        },
      );
      if (currentSession !== session.current) return;
      // Invalidate before publishing the policy. A prior scan must not repopulate
      // cached Alpha offers after the user switches back to stable releases.
      scanEpoch.current++;
      inventoryCache.current.clear();
      inventoryRef.current = null;
      setInventory(null);
      setConfig((current) =>
        current ? { ...current, updateChannel: saved.updateChannel } : current,
      );
      setSelectedPaths(new Set());
      setReload((value) => value + 1);
      notify(
        "Update channel saved for this server. Checking installed content again.",
      );
    } catch (cause) {
      if (currentSession === session.current) notify(messageOf(cause), true);
    } finally {
      if (currentSession === session.current) {
        pending.current = false;
        setBusy(null);
      }
    }
  }
  async function holdVersion(entry: InstalledItem) {
    if (pending.current || !allowChanges) return;
    const currentSession = session.current;
    pending.current = true;
    setBusy("active");
    try {
      await api("/launchpad/update-policy", {
        method: "PATCH",
        body: JSON.stringify({ path: entry.path, hold: !entry.updateHeld }),
      });
      if (currentSession === session.current) {
        await refreshInstalled();
        notify(
          entry.updateHeld
            ? "Automatic updates enabled for this file."
            : "This version is held. Update all will leave it unchanged.",
        );
      }
    } catch (cause) {
      if (currentSession === session.current) notify(messageOf(cause), true);
    } finally {
      if (currentSession === session.current) {
        pending.current = false;
        setBusy(null);
      }
    }
  }
  function changeInventoryMode(next: boolean) {
    if (next !== installedOnly && selectionBatch) cancelSelectionBatch();
    modeQueries.current[installedOnly ? "installed" : "browse"] = query;
    setInstalledOnly(next);
    setQuery(modeQueries.current[next ? "installed" : "browse"]);
    setOffset(0);
  }
  function endSelectionItem(paths: Set<string>) {
    setSelectionOutcome((current) => {
      if (!current) return null;
      const remaining = current.remaining.filter((path) => !paths.has(path));
      return {
        ...current,
        remaining,
        status: remaining.length ? current.status : "complete",
      };
    });
    setSelectedPaths(
      (current) => new Set([...current].filter((path) => !paths.has(path))),
    );
    selectionStarted.current = null;
    setSelectionBatch((current) => {
      if (!current) return null;
      const items = current.items.filter((item) => !paths.has(item.path));
      return items.length ? { ...current, items } : null;
    });
  }
  function cancelSelectionBatch() {
    setSelectionOutcome((current) =>
      current?.status === "running" || current?.status === "failed"
        ? { ...current, status: "cancelled" }
        : current,
    );
    selectionStarted.current = null;
    setSelectionBatch(null);
  }
  function startSelectedAction(action: "remove" | "disable") {
    const items = (installed?.items || []).filter(
      (item) =>
        selectedPaths.has(item.path) &&
        (action !== "disable" || item.active !== false),
    );
    if (!items.length || !canInstall || busy) return;
    selectionStarted.current = null;
    setSelectionOutcome({
      action,
      total: items.length,
      remaining: items.map((item) => item.path),
      status: "running",
    });
    setSelectionBatch({ action, items, total: items.length });
  }
  function chooseProject(project: Project, entry?: InstalledItem) {
    if (!allowChanges) return;
    operation.current++;
    previewRequest.current?.abort();
    setDialogError("");
    setPlan(null);
    setCleanAccepted(false);
    setBackupFirst(
      type === "modpack" &&
        (permissions === undefined || permissions.includes("backup.create")),
    );
    setManualRuntimeAcknowledged(false);
    setPreserveWorld(true);
    backupForSelection.current = false;
    setResolutions({});
    setDependencyProblems([]);
    setRuntimeProblems([]);
    setSelectedUpdatePaths(null);
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
    previewRequest.current?.abort();
    setSelection(null);
    setPlan(null);
    setCleanAccepted(false);
    setDialogError("");
    pending.current = false;
    setBusy(null);
  }
  function closeRemoval() {
    if (busy === "remove") return;
    cancelSelectionBatch();
    operation.current++;
    setRemoval(null);
    setRemovalPlan(null);
    setRemovalError("");
    pending.current = false;
    setBusy(null);
  }
  async function reviewRemoval(
    entry: InstalledItem,
    includeDependents = false,
    cleanupPaths: string[] = [],
  ) {
    if (pending.current || !canInstall) return;
    const currentSession = session.current,
      currentOperation = ++operation.current;
    setRemoval(entry);
    setRemovalPlan(null);
    setRemovalError("");
    pending.current = true;
    setRemovalAcknowledged(false);
    setRemovalDependentsAccepted(false);
    setBusy("removal-preview");
    try {
      const next = await post<RemovalPlan>("/launchpad/removal-preview", {
        path: entry.path,
        type,
        ...(includeDependents ? { includeDependents: true } : {}),
        ...(cleanupPaths.length ? { cleanupPaths } : {}),
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
      (removalPlan.blocked && !removalDependentsAccepted) ||
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
      const result = await post<{ undoJobId?: string }>("/launchpad/remove", {
        planId: removalPlan.planId,
        confirmed: true,
        ...(removalPlan.includesDependents || removalDependentsAccepted
          ? { acknowledgedDependents: true }
          : {}),
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
      endSelectionItem(removedPaths);
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
      if (result.undoJobId)
        setUndoNotice({
          jobId: result.undoJobId,
          title: removal.title || removal.name,
        });
      notify(`${removal.title || removal.name} moved to Recycle Bin.`);
    } catch (cause) {
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      ) {
        setRemovalError(messageOf(cause));
        setSelectionOutcome((current) =>
          current?.status === "running"
            ? { ...current, status: "failed" }
            : current,
        );
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
  function prepareReview(route: string, body: unknown) {
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    return api<Plan>(route, {
      method: "POST",
      body: JSON.stringify(body),
      signal: controller.signal,
    }).finally(() => {
      if (previewRequest.current === controller) previewRequest.current = null;
    });
  }
  async function preview(
    event?: FormEvent,
    changedResolutions?: Record<string, string>,
  ) {
    event?.preventDefault();
    if (selection?.bulk) {
      await reviewAllUpdates(true, changedResolutions);
      return;
    }
    if (
      (plan && !changedResolutions) ||
      !selection ||
      !versionId ||
      pending.current
    )
      return;
    if (
      type !== "modpack" &&
      (!config?.gameVersion || !config.loader) &&
      !manualRuntimeAcknowledged
    ) {
      setDialogError(
        "Verify the Minecraft version and loader from server logs before reviewing this installation.",
      );
      return;
    }
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
    setDependencyProblems([]);
    setRuntimeProblems([]);
    try {
      if (plan) {
        await post(
          `/launchpad/preview/${encodeURIComponent(plan.planId)}/cancel`,
        );
        setPlan(null);
      }
      const next = await prepareReview("/launchpad/preview", {
        platform: selection.project.platform,
        projectId: selection.project.id,
        versionId,
        type,
        gameVersion: targetVersion.trim(),
        loader: targetLoader,
        ...(Object.keys(changedResolutions || resolutions).length
          ? { resolutions: changedResolutions || resolutions }
          : {}),
        ...(type === "modpack" && !preserveWorld
          ? { preserveWorld: false }
          : {}),
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
      ) {
        setDialogError(messageOf(cause));
        const problem = cause as {
          dependencyDecisions?: DependencyDecision[];
          runtimeRequirements?: RuntimeRequirement[];
        };
        setDependencyProblems(problem.dependencyDecisions || []);
        setRuntimeProblems(problem.runtimeRequirements || []);
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
  async function install() {
    if (!plan || pending.current) return;
    if ((type === "modpack" || plan.cleanInstall) && !cleanAccepted) return;
    if (!canInstall) {
      setDialogError("Stop the server in Console before installing.");
      return;
    }
    const currentSession = session.current,
      currentOperation = operation.current;
    jobEpoch.current++;
    const accept = (next: Job) => {
      consumedPlans.current.add(plan.planId);
      jobEpoch.current++;
      setJob(next);
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
      if (["completed", "failed"].includes(next.status)) void reconcileJob();
      if (next.status === "completed") notify(next.message);
    };
    pending.current = true;
    setBusy("install");
    setDialogError("");
    let submitted = false;
    try {
      if (
        backupFirst &&
        !backupForSelection.current &&
        (type === "modpack" || plan.cleanInstall)
      ) {
        await post("/backups", { name: "Before modpack installation" });
        backupForSelection.current = true;
        if (
          currentSession !== session.current ||
          currentOperation !== operation.current
        )
          return;
      }
      submitted = true;
      const next = await post<{ job: Job }>("/launchpad/install", {
        planId: plan.planId,
        confirmed: true,
        ...(type === "modpack" || plan.cleanInstall
          ? { cleanInstall: true }
          : {}),
        ...(plan.unavailableDependencies?.length
          ? { acknowledgedUnavailableDependencies: true }
          : {}),
        ...(plan.runtimeRequirements?.length
          ? { acknowledgedRuntimeRequirements: true }
          : {}),
      });
      if (
        currentSession !== session.current ||
        currentOperation !== operation.current
      )
        return;
      accept(next.job);
    } catch (cause) {
      // The host owns accepted work even when the transport loses its response.
      // Correlate by review, never by whichever unrelated job is retained last.
      const accepted = submitted
        ? await recoverAcceptedJob(
            plan.planId,
            job?.id,
            currentSession,
            currentOperation,
          )
        : null;
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      ) {
        if (accepted) accept(accepted);
        else {
          setDialogError(messageOf(cause));
          if (
            submitted &&
            [404, 409, 410].includes((cause as { status?: number }).status || 0)
          )
            setPlan(null);
        }
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
  async function recoverAcceptedJob(
    planId: string,
    previousJobId: string | undefined,
    currentSession: number,
    currentOperation: number,
  ) {
    if (
      currentSession !== session.current ||
      currentOperation !== operation.current
    )
      return null;
    try {
      const next = await api<Config>("/launchpad");
      if (
        currentSession === session.current &&
        currentOperation === operation.current &&
        next.job?.planId === planId &&
        next.job.id !== previousJobId
      )
        return next.job;
    } catch {
      // Keep the original submission error. Refresh can recover when the host
      // becomes reachable again without repeating the installation request.
    }
    return null;
  }
  async function reviewAllUpdates(
    reuseSelection = false,
    changedResolutions?: Record<string, string>,
    rootPaths?: Set<string>,
  ) {
    if (pending.current || !canInstall || type === "modpack") return;
    const updates = availableUpdates
      .filter(
        (item) =>
          !reuseSelection ||
          !(rootPaths || selectedUpdatePaths) ||
          (rootPaths || selectedUpdatePaths)!.has(item.path),
      )
      .slice(0, 50);
    if (!reuseSelection) {
      setSelectedUpdatePaths(new Set(updates.map((item) => item.path)));
      setResolutions({});
      setDependencyProblems([]);
      setRuntimeProblems([]);
    }
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
      if (plan)
        await post(
          `/launchpad/preview/${encodeURIComponent(plan.planId)}/cancel`,
        );
      const next = await prepareReview("/launchpad/updates/preview", {
        type,
        gameVersion: contentGameVersion,
        loader: contentLoader,
        ...(Object.keys(changedResolutions || resolutions).length
          ? { resolutions: changedResolutions || resolutions }
          : {}),
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
    const currentSession = session.current,
      currentOperation = ++operation.current;
    jobEpoch.current++;
    const accept = (next: Job) => {
      jobEpoch.current++;
      setJob(next);
      setJobError("");
      if (["completed", "failed"].includes(next.status)) void reconcileJob();
      if (next.status === "completed")
        notify(next.message || "Installation completed.");
    };
    pending.current = true;
    setBusy("install");
    setJobError("");
    try {
      const result = await post<{ job: Job }>(
        "/launchpad/install",
        job.retryInput,
      );
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      )
        accept(result.job);
    } catch (cause) {
      const accepted = await recoverAcceptedJob(
        job.retryInput.planId,
        job.id,
        currentSession,
        currentOperation,
      );
      if (
        currentSession === session.current &&
        currentOperation === operation.current
      ) {
        if (accepted) accept(accepted);
        else setJobError(messageOf(cause));
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
  async function setContentActive(
    entry: InstalledItem,
    active: boolean,
    acknowledgedDependencies = false,
  ) {
    if (pending.current || !canInstall || (type !== "mod" && type !== "plugin"))
      return;
    const currentSession = session.current;
    pending.current = true;
    setBusy("active");
    try {
      const result = await post<{
        path: string;
        active: boolean;
        requiresAcknowledgement?: boolean;
        warnings?: string[];
        modifiedAt: string;
        addedAt: string;
      }>("/launchpad/active", {
        type,
        path: entry.path,
        active,
        ...(acknowledgedDependencies ? { acknowledgedDependencies: true } : {}),
      });
      if (currentSession !== session.current) return;
      if (result.requiresAcknowledgement) {
        setActivation({ entry, active, warnings: result.warnings || [] });
        return;
      }
      setActivation(null);
      endSelectionItem(new Set([entry.path]));
      const previous = inventoryCache.current.get(type);
      if (previous?.api === api) {
        const next = {
          ...previous,
          result: {
            ...previous.result,
            items: previous.result.items.map((item) =>
              item.path === entry.path
                ? {
                    ...item,
                    ...result,
                    name: result.path.split("/").at(-1) || item.name,
                  }
                : item,
            ),
          },
        };
        inventoryCache.current.set(type, next);
        if (inventoryRef.current?.type === type) {
          scanEpoch.current++;
          inventoryRef.current = next;
          setInventory(next);
        }
      }
      reloadContent();
      notify(
        `${entry.title || entry.name} ${active ? "enabled" : "disabled"}.`,
      );
    } catch (cause) {
      if (currentSession === session.current) {
        notify(messageOf(cause), true);
        setSelectionOutcome((current) =>
          current?.status === "running"
            ? { ...current, status: "failed" }
            : current,
        );
      }
    } finally {
      if (currentSession === session.current) {
        pending.current = false;
        setBusy(null);
      }
    }
  }
  function changeType(next: ContentType) {
    if (pending.current || busy) return;
    cancelSelectionBatch();
    setSelectedPaths(new Set());
    setType(next);
    setCategories([]);
    setLoader((current) =>
      loadersFor(next).includes(current)
        ? current
        : loadersFor(next).includes(config?.loader || "")
          ? config!.loader!
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
    .filter(
      (entry) =>
        !categoryKey ||
        matchesCategories(entry.categories, categoryKey.split(",")),
    )
    .sort((a, b) =>
      compareInstalled(
        a,
        b,
        installedSort,
        installedDirection,
        filteredQuery.trim().toLowerCase(),
      ),
    );
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
  useEffect(() => {
    if (!selectionBatch || busy || removal || activation || !canInstall) return;
    const entry = selectionBatch.items[0];
    if (!entry || selectionStarted.current === entry.path) return;
    selectionStarted.current = entry.path;
    if (selectionBatch.action === "remove") void reviewRemoval(entry);
    else void setContentActive(entry, false);
  }, [selectionBatch, busy, removal, activation, canInstall]);
  useEffect(() => {
    setDependencySummary(null);
    setDependencySummaryError("");
    if (
      !selection ||
      selection.bulk ||
      plan ||
      !versionId ||
      !targetVersion ||
      !targetLoader
    ) {
      setDependencySummaryLoading(false);
      return;
    }
    const controller = new AbortController();
    setDependencySummaryLoading(true);
    const params = new URLSearchParams({
      platform: selection.project.platform,
      projectId: selection.project.id,
      versionId,
      type,
      gameVersion: targetVersion,
      loader: targetLoader,
    });
    void api<NonNullable<typeof dependencySummary>>(
      `/launchpad/dependencies?${params}`,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted) setDependencySummary(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setDependencySummaryError(messageOf(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDependencySummaryLoading(false);
      });
    return () => controller.abort();
  }, [
    api,
    selection?.project.platform,
    selection?.project.id,
    selection?.bulk,
    versionId,
    targetVersion,
    targetLoader,
    type,
    Boolean(plan),
  ]);

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
            authorLinks: entry.authorLinks,
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

  function pagination(bottom = false) {
    return (
      <Pagination
        label={bottom ? "Launchpad bottom" : "Launchpad"}
        page={Math.floor(currentOffset / limit) + 1}
        pageSize={limit}
        total={total}
        pageSizes={rowsOptions}
        disabled={loading}
        onPageChange={(page) => {
          setOffset((page - 1) * limit);
          if (bottom)
            resultsElement.current?.scrollIntoView({ block: "start" });
        }}
        onPageSizeChange={(value) => {
          setLimit(value);
          setOffset(0);
          if (bottom)
            resultsElement.current?.scrollIntoView({ block: "start" });
          try {
            writePreference("mc-panel.launchpad.rows", String(value));
          } catch {
            /* session only */
          }
        }}
      />
    );
  }

  function toolbar(bottom = false) {
    const sortId = bottom
      ? "launchpad-bottom-installed-sort"
      : "launchpad-installed-sort";
    const updateLabel =
      availableUpdates.length > 50
        ? `Update first 50 (${availableUpdates.length} available)`
        : "Update all";
    return (
      <div
        className={`panel launchpad-toolbar${bottom ? " launchpad-toolbar-bottom launchpad-pagination-footer" : ""}`}
        role="group"
        aria-label={
          bottom ? "Launchpad bottom controls" : "Launchpad top controls"
        }
      >
        {pagination(bottom)}
        <SearchField
          className="launchpad-search"
          grow
          aria-label={bottom ? "Search bottom Launchpad" : "Search Launchpad"}
          clearLabel={bottom ? "Clear bottom search" : "Clear search"}
          placeholder={`Search ${kinds.find((item) => item.id === type)?.label.toLowerCase()}…`}
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            setOffset(0);
          }}
        />
        {installedOnly ? (
          <div className="launchpad-sort">
            <label htmlFor={sortId}>Sort by</label>
            <select
              id={sortId}
              aria-label={
                bottom
                  ? "Sort bottom installed content"
                  : "Sort installed content"
              }
              value={
                installedSortOptions.some((item) => item.id === installedSort)
                  ? installedSort
                  : ""
              }
              onChange={(event) => {
                setInstalledSort(event.target.value as InstalledSort);
                setInstalledDirection(
                  defaultInstalledDirection(
                    event.target.value as InstalledSort,
                  ),
                );
                setOffset(0);
              }}
            >
              {!installedSortOptions.some(
                (item) => item.id === installedSort,
              ) && (
                <option value="" disabled>
                  Column order
                </option>
              )}
              {installedSortOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn icon"
              aria-label={
                bottom
                  ? "Reverse bottom installed sort order"
                  : "Reverse installed sort order"
              }
              title={
                installedDirection === "asc"
                  ? "Ascending — click for descending"
                  : "Descending — click for ascending"
              }
              onClick={() => {
                setInstalledDirection((current) =>
                  current === "asc" ? "desc" : "asc",
                );
                setOffset(0);
              }}
            >
              {installedDirection === "asc" ? (
                <ArrowUp size={14} />
              ) : (
                <ArrowDown size={14} />
              )}
            </button>
          </div>
        ) : sortOptions.length > 0 && source?.available && supported ? (
          <label className="launchpad-sort">
            Sort by
            <select
              aria-label={bottom ? "Sort bottom Launchpad" : "Sort Launchpad"}
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
          {type === "mod" &&
            (installedOnly ||
              (source?.available &&
                supported &&
                allModCategories.some((category) =>
                  supportsCategory(category.id, platform),
                ))) && (
              <LaunchpadCategoryFilters
                bottom={bottom}
                selected={categoryKey ? categoryKey.split(",") : []}
                platform={installedOnly ? undefined : platform}
                onChange={(next) => {
                  setCategories(next);
                  setOffset(0);
                }}
              />
            )}
          {installedOnly && type !== "modpack" && allowChanges && (
            <button
              className="btn primary"
              aria-label={
                bottom ? `${updateLabel} from bottom toolbar` : undefined
              }
              disabled={
                !canInstall ||
                Boolean(busy) ||
                !updateFiltersReady ||
                !availableUpdates.length ||
                scanRefreshing ||
                Boolean(installed?.checkingUpdates)
              }
              onClick={() => void reviewAllUpdates()}
            >
              <RefreshCw size={15} /> {updateLabel}
            </button>
          )}
          {(permissions === undefined || permissions.includes("file.read")) && (
            <button
              className="btn"
              disabled={clientPackBusy}
              onClick={() => void reviewClientPack()}
            >
              <Download size={15} />
              {clientPackBusy ? "Preparing export…" : "Export client pack"}
            </button>
          )}
          {allowChanges && (
            <button className="btn" onClick={() => void openContentHistory()}>
              Recent changes
            </button>
          )}
          <Switch
            label="Installed only"
            aria-label={
              bottom
                ? "Show bottom installed content"
                : "Show installed content"
            }
            checked={installedOnly}
            onCheckedChange={(checked) => {
              changeInventoryMode(checked);
              if (!checked && !source?.types.includes(type))
                changeType(source?.types[0] ?? "modpack");
            }}
          />
          <RefreshButton
            label={
              bottom
                ? "Refresh bottom Launchpad and check updates"
                : "Refresh Launchpad and check updates"
            }
            refreshing={manualRefreshing}
            onRefresh={refreshInstalled}
            notify={notify}
            successMessage="Launchpad refreshed."
          />
        </div>
      </div>
    );
  }

  function installedHeading(id: InstalledSort, label: string, column: string) {
    const selected = installedSort === id;
    const nextDirection = selected
      ? installedDirection === "asc"
        ? "desc"
        : "asc"
      : defaultInstalledDirection(id);
    return (
      <button
        type="button"
        className={`launchpad-column-heading launchpad-column-${column}`}
        aria-label={`Sort by ${label}`}
        aria-pressed={selected}
        aria-description={
          selected
            ? `${installedDirection === "asc" ? "Ascending" : "Descending"}. Updates always appear first.`
            : "Updates always appear first."
        }
        title={`Sort ${label.toLowerCase()} ${nextDirection === "asc" ? "ascending" : "descending"}`}
        onClick={() => {
          setInstalledSort(id);
          setInstalledDirection(nextDirection);
          setOffset(0);
        }}
      >
        {label}
        {selected ? (
          installedDirection === "asc" ? (
            <ArrowUp size={13} />
          ) : (
            <ArrowDown size={13} />
          )
        ) : (
          <ArrowUpDown size={13} />
        )}
      </button>
    );
  }

  function columnHeading(
    id: InstalledSort,
    label: string,
    column: string,
    catalogId = id as string,
  ) {
    if (installedOnly) return installedHeading(id, label, column);
    if (!sortOptions.some((option) => option.id === catalogId))
      return <span className={`launchpad-column-${column}`}>{label}</span>;
    const selected = catalogSort === catalogId;
    const ascending = ["name", "author", "category"].includes(catalogId);
    return (
      <button
        type="button"
        className={`launchpad-column-heading launchpad-column-${column}`}
        aria-label={`Sort by ${label}`}
        aria-pressed={selected}
        disabled={selected}
        title={
          selected
            ? `Sorted ${ascending ? "ascending" : "descending"}; this catalog provides a fixed order`
            : `Sort ${label.toLowerCase()} ${ascending ? "ascending" : "descending"}`
        }
        onClick={() => {
          setSort(catalogId);
          setOffset(0);
        }}
      >
        {label}
        {selected ? (
          ascending ? (
            <ArrowUp size={13} />
          ) : (
            <ArrowDown size={13} />
          )
        ) : (
          <ArrowUpDown size={13} />
        )}
      </button>
    );
  }

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
              const dropped = categories.filter(
                (id) => !supportsCategory(id, event.target.value),
              );
              if (dropped.length)
                notify(
                  `${dropped.length} category filters are unavailable on ${next?.name || "this platform"} and were cleared.`,
                );
              setCategories((current) =>
                current.filter((id) =>
                  supportsCategory(id, event.target.value),
                ),
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
            disabled={
              Boolean(busy) || (!installedOnly && !source?.types.includes(id))
            }
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
      <div
        className="launchpad-view-tabs"
        role="group"
        aria-label="Catalog view"
      >
        <button
          className={`btn ${!installedOnly ? "primary" : ""}`}
          aria-pressed={!installedOnly}
          onClick={() => {
            changeInventoryMode(false);
          }}
        >
          Browse catalog
        </button>
        <button
          className={`btn ${installedOnly ? "primary" : ""}`}
          aria-pressed={installedOnly}
          onClick={() => {
            changeInventoryMode(true);
          }}
        >
          Installed content{installed ? ` (${installed.items.length})` : ""}
          {availableUpdates.length
            ? ` · ${availableUpdates.length} updates`
            : ""}
        </button>
      </div>
      {installedOnly && (
        <div className="management-notice">
          <label className="launchpad-sort">
            Update channel
            <select
              aria-label="Update channel"
              value={config.updateChannel ?? "installed"}
              disabled={
                !canChangeUpdateChannel ||
                Boolean(busy) ||
                working ||
                !!selectionBatch ||
                configLoading
              }
              onChange={(event) =>
                void saveUpdateChannel(event.target.value as UpdateChannel)
              }
            >
              <option value="installed">Follow installed stability</option>
              <option value="release">Stable releases only</option>
              <option value="beta">Stable and beta</option>
              <option value="alpha">Stable, beta and alpha</option>
            </select>
          </label>
          <p>
            Applies to update checks on this server. By default, stable files
            stay stable; beta files accept stable or beta; alpha files accept
            all channels. Unknown channels use stable releases.
          </p>
          {!canChangeUpdateChannel && (
            <p>
              Changing this preference requires permission to edit server
              settings.
            </p>
          )}
        </div>
      )}
      {toolbar()}
      {installedOnly && type !== "modpack" && allowChanges && (
        <div
          className="launchpad-selection-bar"
          role="group"
          aria-label="Selected installed content"
        >
          <strong>{selectedPaths.size} selected</strong>
          <button
            className="btn"
            disabled={Boolean(busy) || !!selectionBatch}
            onClick={() =>
              setSelectedPaths(
                new Set(
                  visibleProjects.flatMap(({ entry }) =>
                    entry ? [entry.path] : [],
                  ),
                ),
              )
            }
          >
            Select this page
          </button>
          <button
            className="btn"
            disabled={!selectedPaths.size || Boolean(busy) || !!selectionBatch}
            onClick={() => setSelectedPaths(new Set())}
          >
            Clear selection
          </button>
          <button
            className="btn"
            disabled={
              !canInstall ||
              Boolean(busy) ||
              !!selectionBatch ||
              scanRefreshing ||
              !availableUpdates.some((item) => selectedPaths.has(item.path))
            }
            onClick={() => {
              setSelectedUpdatePaths(new Set(selectedPaths));
              setResolutions({});
              void reviewAllUpdates(true, {}, selectedPaths);
            }}
          >
            Update selected
          </button>
          {(type === "mod" || type === "plugin") && (
            <button
              className="btn"
              disabled={
                !canInstall ||
                Boolean(busy) ||
                !!selectionBatch ||
                !selectedPaths.size
              }
              onClick={() => startSelectedAction("disable")}
            >
              Disable selected
            </button>
          )}
          <button
            className="btn danger"
            disabled={
              !canInstall ||
              Boolean(busy) ||
              !!selectionBatch ||
              !selectedPaths.size
            }
            onClick={() => startSelectedAction("remove")}
          >
            Remove selected
          </button>
          {selectionBatch && (
            <span role="status">
              {selectionBatch.action === "remove"
                ? "Reviewing removal"
                : "Disabling"}
              : {selectionBatch.total - selectionBatch.items.length + 1} of{" "}
              {selectionBatch.total}. Each file is checked before changing it.{" "}
              <button
                className="btn"
                onClick={() => {
                  cancelSelectionBatch();
                  if (!busy) {
                    setActivation(null);
                    setRemoval(null);
                    setRemovalPlan(null);
                  }
                }}
              >
                Cancel remaining
              </button>
              {!busy && !removal && !activation && (
                <button
                  className="btn"
                  onClick={() => {
                    selectionStarted.current = null;
                    setSelectionOutcome((current) =>
                      current ? { ...current, status: "running" } : current,
                    );
                    setSelectionBatch({ ...selectionBatch });
                  }}
                >
                  Retry selected item
                </button>
              )}
            </span>
          )}
        </div>
      )}
      {selectionOutcome && (
        <p className="management-notice" role="status">
          Selected{" "}
          {selectionOutcome.action === "remove" ? "removal" : "disable"}:{" "}
          {selectionOutcome.total - selectionOutcome.remaining.length} of{" "}
          {selectionOutcome.total} completed.{" "}
          {selectionOutcome.status === "cancelled"
            ? "Remaining changes cancelled; an in-flight item may still finish."
            : selectionOutcome.status === "failed"
              ? "Paused after an error. The current item may have changed; refresh installed content before retrying. Unstarted items were not requested."
              : selectionOutcome.status === "complete"
                ? "All selected changes completed."
                : "Checking each file before changing it."}{" "}
          {!selectionBatch && !busy && (
            <button className="btn" onClick={() => setSelectionOutcome(null)}>
              Dismiss selection status
            </button>
          )}
        </p>
      )}
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
                    : job.cancelled
                      ? "Installation cancelled"
                      : "Installation failed"}
              </strong>
              <p>{job.error || job.message}</p>
              {job.retainedRecoveryPath && (
                <p>Recovery copies: {job.retainedRecoveryPath}</p>
              )}
              {job.status === "completed" &&
                Boolean(job.recoveryEntries?.length) &&
                (permissions === undefined ||
                  permissions.includes("backup.read")) && (
                  <a href="#files?recycle=1">
                    View replaced files in Recycle Bin
                  </a>
                )}
            </div>
            {job.undoAvailable && (
              <button
                className="btn"
                disabled={!canInstall || undoBusy}
                onClick={() => reviewUndo(job.id, job.message)}
              >
                Undo installation…
              </button>
            )}
            {job.status === "failed" && job.retryable && job.retryInput && (
              <button
                className="btn"
                disabled={!canInstall || Boolean(busy)}
                onClick={() => void retryDownload()}
              >
                Retry download
              </button>
            )}
            {working && job.cancellable && allowChanges && (
              <button
                className="btn"
                disabled={jobAction}
                onClick={() => void actOnJob("cancel")}
              >
                Cancel installation
              </button>
            )}
            {job.recoveryRequired && canRecover && (
              <button
                className="btn"
                disabled={jobAction}
                onClick={() => void actOnJob("recover")}
              >
                Retry recovery
              </button>
            )}
            {job.recoveryRequired && canRecover && (
              <div>
                {keepCurrentReview ? (
                  <>
                    <p>
                      Keep the current files and accept the interrupted
                      installation state? Retained originals stay available for
                      manual recovery.
                    </p>
                    <button
                      className="btn danger"
                      disabled={jobAction}
                      onClick={() => void actOnJob("keep")}
                    >
                      Confirm current files
                    </button>
                    <button
                      className="btn"
                      onClick={() => setKeepCurrentReview(false)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="btn"
                    disabled={jobAction}
                    onClick={() => setKeepCurrentReview(true)}
                  >
                    Keep current files…
                  </button>
                )}
              </div>
            )}
            {!working &&
              !job.recoveryRequired &&
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
                        if (currentSession === session.current) {
                          jobEpoch.current++;
                          rememberDismissedJob(viewKey, job.id);
                          setJob((current) =>
                            current?.id === job.id ? null : current,
                          );
                        }
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
      {undoNotice && (
        <div className="launchpad-inline-notice" role="status">
          <span>{undoNotice.title} was removed.</span>
          <button
            className="btn"
            onClick={() => reviewUndo(undoNotice.jobId, undoNotice.title)}
          >
            Review undo
          </button>
          <button
            className="btn icon"
            aria-label="Dismiss removal undo notice"
            onClick={() => setUndoNotice(null)}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {!installedOnly && searchLoading && results && (
        <p role="status">Updating projects…</p>
      )}
      {duplicateUpdateCount > 0 && installedOnly && (
        <p className="launchpad-inline-notice" role="status">
          {duplicateUpdateCount} duplicate copies are excluded from Update all.
          Review and remove the extra copies before updating those projects.
        </p>
      )}
      {changeDisabledReason && (
        <p className="launchpad-inline-notice" role="status">
          {changeDisabledReason}
        </p>
      )}
      <section
        ref={resultsElement}
        id="launchpad-results"
        className="launchpad-results"
        role="tabpanel"
        aria-labelledby={`launchpad-tab-${type}`}
        aria-busy={loading || searchLoading}
      >
        {!installedOnly && (!source?.available || !supported) ? (
          <StatePanel
            variant="empty"
            icon={<SlidersHorizontal size={25} />}
            title={`${source?.name ?? "Platform"} ${supported ? "is unavailable" : "does not offer this content"}`}
            message={
              permissions !== undefined && source?.requiresKey
                ? "Ask the computer owner to configure this platform’s API key in Launchpad settings, or choose another platform."
                : source?.reason || "Choose another platform or content type."
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
                ? query || categoryKey
                  ? "No installed content matches"
                  : "No content installed yet"
                : "No projects found"
            }
            message={
              installedOnly
                ? "Installed files appear here after a scan. Try another content type or search."
                : "Try another search, Minecraft version, or loader."
            }
            action={
              query || categoryKey ? (
                <button
                  className="btn"
                  onClick={() => {
                    setQuery("");
                    setCategories([]);
                    setOffset(0);
                  }}
                >
                  Clear filters
                </button>
              ) : undefined
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
              {installedOnly && <span> · Updates always appear first.</span>}
            </div>
            <div
              className={`launchpad-installed-list${type === "mod" || type === "plugin" ? " has-active" : ""}`}
              tabIndex={0}
              role="region"
              aria-label={
                installedOnly
                  ? "Installed content list"
                  : "Catalog content list"
              }
            >
              <div
                className="launchpad-installed-header"
                role="group"
                aria-label={
                  installedOnly
                    ? "Sort installed content columns"
                    : "Sort catalog content columns"
                }
              >
                {columnHeading("name", "Name", "name")}
                <span className="launchpad-column-action">Action</span>
                {columnHeading("author", "Author", "author")}
                {(type === "mod" || type === "plugin") &&
                  columnHeading("active", "Active", "active")}
                {columnHeading(
                  "added",
                  installedOnly ? "Date added" : "Published",
                  "added",
                  "newest",
                )}
                {columnHeading(
                  "modified",
                  installedOnly ? "Date modified" : "Updated",
                  "modified",
                  "updated",
                )}
              </div>
              {visibleProjects.map(({ project, entry }) => (
                <article
                  className="panel launchpad-project launchpad-installed-row"
                  key={entry?.path ?? `${project.platform}:${project.id}`}
                  aria-label={project.title}
                >
                  <div className="launchpad-project-main">
                    {installedOnly &&
                      entry &&
                      type !== "modpack" &&
                      allowChanges && (
                        <input
                          type="checkbox"
                          aria-label={`Select ${project.title}`}
                          checked={selectedPaths.has(entry.path)}
                          disabled={Boolean(busy) || !!selectionBatch}
                          onChange={(event) =>
                            setSelectedPaths((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(entry.path);
                              else next.delete(entry.path);
                              return next;
                            })
                          }
                        />
                      )}
                    <ProjectIcon url={project.iconUrl} />
                    <div className="launchpad-project-body">
                      <div className="launchpad-project-title">
                        <h3 aria-label={project.title}>
                          {project.url && /^https:\/\//i.test(project.url) ? (
                            <a
                              className="launchpad-project-link"
                              href={project.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Open ${project.title} project page`}
                            >
                              {project.title}
                            </a>
                          ) : (
                            project.title
                          )}
                        </h3>
                        {entry && (
                          <span className="launchpad-badge">
                            {entry.platform && entry.projectId
                              ? "Installed"
                              : "Unidentified file"}
                          </span>
                        )}
                        {channelLabel(entry?.channel) && (
                          <span className="launchpad-badge">
                            {channelLabel(entry?.channel)}
                          </span>
                        )}
                        {entry?.updateHeld && (
                          <span className="launchpad-badge">Version held</span>
                        )}
                        {entry?.update && !entry.updateHeld && (
                          <span className="launchpad-badge update">
                            Update available
                          </span>
                        )}
                        {entry?.active === false &&
                          (type === "mod" || type === "plugin") && (
                            <span className="launchpad-badge">Disabled</span>
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
                            <span className="launchpad-badge duplicate">
                              Duplicate — remove one
                            </span>
                          )}
                        {entry && pendingPaths.has(entry.path) && (
                          <span className="launchpad-badge">
                            Refreshing file…
                          </span>
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
                        {entry?.versionName && (
                          <span>Installed: {entry.versionName}</span>
                        )}
                        {entry?.previousVersionName && (
                          <span>
                            Previously installed: {entry.previousVersionName}
                          </span>
                        )}
                        {entry?.platform && entry.projectId && allowChanges && (
                          <button
                            className="btn small"
                            disabled={Boolean(busy) || working}
                            onClick={() => void holdVersion(entry)}
                          >
                            {entry.updateHeld
                              ? "Allow updates"
                              : "Hold this version"}
                          </button>
                        )}
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
                              ? "Checking this file’s project details…"
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
                  </div>
                  <div className="launchpad-installed-author">
                    <ProjectAuthors project={project} />
                  </div>
                  <div className="launchpad-project-action">
                    {(!entry || (entry.platform && entry.projectId)) && (
                      <div className="launchpad-version-action">
                        <button
                          className={`btn ${entry && !entry.update ? "" : "primary"}`}
                          aria-label={`${entry?.update ? "Update" : entry ? "Choose version for" : "Install"} ${project.title}`}
                          disabled={
                            !canInstall ||
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
                        {entry?.update && (
                          <div className="launchpad-available-version">
                            Available:{" "}
                            {entry.update.version || entry.update.name}
                            {channelLabel(entry.update.channel) &&
                              ` · ${channelLabel(entry.update.channel)}`}
                          </div>
                        )}
                      </div>
                    )}
                    {type === "modpack" && onCreateServer && (
                      <button
                        className="btn launchpad-create-server"
                        onClick={() => {
                          setSetupModpack(project);
                          onCreateServer();
                        }}
                      >
                        Create new server with this modpack
                      </button>
                    )}
                    {entry && type !== "modpack" && (
                      <>
                        {(type === "mod" || type === "plugin") && (
                          <Switch
                            className="launchpad-active"
                            aria-label={`Active: ${project.title}`}
                            label={null}
                            checked={entry.active !== false}
                            disabled={
                              !canInstall ||
                              Boolean(busy) ||
                              pendingPaths.has(entry.path)
                            }
                            title={
                              changeDisabledReason ||
                              (status !== "offline"
                                ? `Stop the server before enabling or disabling ${contentName}s.`
                                : `${entry.active === false ? "Enable" : "Disable"} ${project.title}`)
                            }
                            onCheckedChange={(active) =>
                              void setContentActive(entry, active)
                            }
                          />
                        )}
                        <button
                          type="button"
                          className="btn launchpad-remove"
                          aria-label={`Remove ${project.title}`}
                          title={
                            changeDisabledReason ||
                            (status !== "offline"
                              ? `Stop the server before removing ${contentName}s.`
                              : `Review ${contentName} removal`)
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
                      </>
                    )}
                    {(type === "mod" || type === "plugin") && !entry && (
                      <span
                        className="launchpad-active launchpad-empty-cell"
                        aria-label="Not installed"
                      >
                        —
                      </span>
                    )}
                    <InstalledDate
                      value={
                        installedOnly ? entry?.addedAt : project.releasedAt
                      }
                      kind="added"
                    />
                    <InstalledDate
                      value={
                        installedOnly ? entry?.modifiedAt : project.updatedAt
                      }
                      kind="modified"
                    />
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
      {toolbar(true)}

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
            {selection?.bulk
              ? "Review selected updates"
              : plan
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
                : selection?.bulk
                  ? "Select updates"
                  : "Select a version"}
            </span>
          </div>
          <p className="management-dialog-description">
            {selection?.project.url &&
            /^https:\/\//i.test(selection.project.url) ? (
              <a
                className="launchpad-project-link"
                href={selection.project.url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${selection.project.title} project page`}
              >
                {selection.project.title}
              </a>
            ) : (
              selection?.project.title
            )}
          </p>
          {selection?.bulk && (
            <fieldset
              disabled={Boolean(busy)}
              className="launchpad-update-selection"
            >
              <legend>Updates to include</legend>
              {availableUpdates.slice(0, 50).map((item) => (
                <label className="launchpad-clean-confirm" key={item.path}>
                  <input
                    type="checkbox"
                    checked={selectedUpdatePaths?.has(item.path) ?? true}
                    onChange={(event) => {
                      const next = new Set(
                        selectedUpdatePaths ||
                          availableUpdates.map((entry) => entry.path),
                      );
                      if (event.target.checked) next.add(item.path);
                      else next.delete(item.path);
                      setSelectedUpdatePaths(next);
                      setResolutions({});
                      setPlan(null);
                    }}
                  />
                  {item.title || item.name} ·{" "}
                  {item.versionName || "Unknown installed version"} →{" "}
                  {item.update?.version || item.update?.name}
                </label>
              ))}
            </fieldset>
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
                  disabled={
                    Boolean(busy) ||
                    (type !== "modpack" && Boolean(config.loader))
                  }
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
                  disabled={
                    Boolean(busy) ||
                    (type !== "modpack" && Boolean(config.gameVersion))
                  }
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
              {type !== "modpack" &&
                (!config.gameVersion || !config.loader) && (
                  <label className="launchpad-clean-confirm">
                    <input
                      type="checkbox"
                      checked={manualRuntimeAcknowledged}
                      onChange={(event) =>
                        setManualRuntimeAcknowledged(event.target.checked)
                      }
                    />
                    I verified this server’s Minecraft version and loader from
                    its logs or launch files. Automatic detection is
                    unavailable.
                  </label>
                )}
              {versionsLoading ? (
                <p role="status">Loading compatible versions…</p>
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
                    onChange={(event) => {
                      setVersionId(event.target.value);
                      setResolutions({});
                      setDependencyProblems([]);
                      setRuntimeProblems([]);
                    }}
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
                        {version.id === selection?.installed?.versionId
                          ? " · Installed"
                          : version.id ===
                              selection?.installed?.previousVersionId
                            ? " · Previously installed"
                            : ""}
                        {version.channel || version.versionType
                          ? ` · ${version.channel || version.versionType}`
                          : ""}
                        {!version.downloadable
                          ? ` · ${version.serverCompatible === false ? "Client only" : version.reason || version.unavailableReason || "No compatible server download"}`
                          : ""}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <section
                className="launchpad-dependency-summary"
                aria-label="Catalog dependency summary"
              >
                <strong>Declared dependencies</strong>
                <p>
                  Catalog information only. The full review checks downloaded
                  files, version conflicts, and runtime requirements before
                  installation.
                </p>
                {dependencySummaryLoading && (
                  <p role="status">Loading declared dependencies…</p>
                )}
                {dependencySummaryError && (
                  <p role="status">
                    Catalog dependency details are unavailable:{" "}
                    {dependencySummaryError}. Continue to the full review to
                    check requirements.
                  </p>
                )}
                {dependencySummary && (
                  <>
                    <ul>
                      {dependencySummary.dependencies.map((item, index) => (
                        <li key={`${item.title}:${index}`}>
                          <strong>{item.title}</strong> · {item.relation} ·{" "}
                          {item.status === "installed"
                            ? `Installed${item.installedVersion ? ` ${item.installedVersion}` : ""}`
                            : item.status === "disabled"
                              ? `Installed but disabled${item.installedVersion ? ` ${item.installedVersion}` : ""}`
                              : item.status === "not-identified"
                                ? "Not identified in installed inventory; full review required"
                                : "Catalog details unavailable"}
                          {item.proposedVersion
                            ? ` · Proposed ${item.proposedVersion}`
                            : ""}
                        </li>
                      ))}
                    </ul>
                    {!dependencySummary.dependencies.length && (
                      <p>
                        {dependencySummary.declarationsAvailable === false
                          ? "This catalog does not expose dependency declarations. Full review is required."
                          : "No dependencies declared by this catalog. Full review also checks the actual files."}
                      </p>
                    )}
                    {dependencySummary.warnings.map((warning) => (
                      <p className="management-warning" key={warning}>
                        {warning}
                      </p>
                    ))}
                  </>
                )}
              </section>
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
                    <strong>{plan.versionName}</strong> replaces the pack
                    runtime and content.{" "}
                    {preserveWorld
                      ? "Worlds and server settings are preserved."
                      : "The server folder will be replaced."}{" "}
                    The server will remain stopped.
                  </>
                ) : plan.files.length ? (
                  <>
                    <strong>
                      {selection?.bulk
                        ? "The selected updates"
                        : plan.versionName}
                    </strong>{" "}
                    will make these changes to this server. The server will
                    remain stopped.
                  </>
                ) : (
                  <>
                    No file changes are needed for{" "}
                    <strong>{plan.versionName}</strong>.
                  </>
                )}
              </p>
              {channelLabel(plan.channel) && (
                <p className="management-notice">
                  Selected version: {channelLabel(plan.channel)} prerelease.
                </p>
              )}
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
                          {file.title && <strong>{file.title}</strong>}
                          <span>{file.path}</span>
                          {channelLabel(file.channel) && (
                            <span className="launchpad-badge">
                              {channelLabel(file.channel)} prerelease
                            </span>
                          )}
                          {(file.installedVersion || file.proposedVersion) && (
                            <small className="launchpad-previous-path">
                              {file.installedVersion || "Not installed"} →{" "}
                              {file.proposedVersion || "Unknown version"}
                              {file.direction ? ` · ${file.direction}` : ""}
                            </small>
                          )}
                          {file.installReason && (
                            <small className="launchpad-previous-path">
                              {file.installReason}
                              {file.requiredBy?.length
                                ? ` · required by ${file.requiredBy.join(", ")}`
                                : ""}
                            </small>
                          )}
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
                          {file.direction === "downgrade"
                            ? "Downgrade"
                            : file.action === "replace"
                              ? "Replace"
                              : "Install"}
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
                  <label className="launchpad-clean-confirm">
                    <input
                      type="checkbox"
                      checked={preserveWorld}
                      disabled={Boolean(busy)}
                      onChange={(event) => {
                        setPreserveWorld(event.target.checked);
                        setPlan(null);
                        setCleanAccepted(false);
                      }}
                    />
                    Keep worlds and server settings
                  </label>
                  <div className="launchpad-inline-notice launchpad-clean-warning">
                    <AlertCircle size={17} />
                    <div>
                      <strong>
                        {preserveWorld
                          ? "This replaces the pack runtime and installed content"
                          : "This replaces the server folder’s contents"}
                      </strong>
                      <p>
                        {preserveWorld
                          ? "Worlds and server settings remain in place. Pack mods and configuration are replaced; replaced files move to Recycle Bin. Create a backup before updating a pack."
                          : "Existing files, including worlds, mods, plugins and settings, move to Recycle Bin. The modpack and runtime are installed into a clean folder."}{" "}
                        <a href="#backups">Open Backups</a>
                      </p>
                    </div>
                  </div>
                  {permissions &&
                    (!permissions.includes("file.read") ||
                      !permissions.includes("file.create")) && (
                      <p className="management-warning">
                        Your account cannot restore retained files from Recycle
                        Bin. Ask the server owner to keep a backup and help
                        recover files if needed.
                      </p>
                    )}
                  <label className="launchpad-clean-confirm">
                    <input
                      type="checkbox"
                      checked={cleanAccepted}
                      disabled={Boolean(busy)}
                      onChange={(event) =>
                        setCleanAccepted(event.target.checked)
                      }
                    />
                    {preserveWorld
                      ? "I understand this replaces pack software, mods, and configuration."
                      : "I understand this replaces all files in this server’s folder."}
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
          {(plan?.dependencyDecisions || dependencyProblems).length > 0 && (
            <section
              className="launchpad-dependency-decisions"
              aria-label="Dependency choices"
            >
              <h3>Dependency changes</h3>
              {(plan?.dependencyDecisions || dependencyProblems).map(
                (decision) => (
                  <label className="form-field" key={decision.key}>
                    <strong>{decision.title}</strong>
                    <span>
                      {decision.installedVersion || "Not installed"} →{" "}
                      {decision.proposedVersion || "No proposed version"}
                      {decision.direction ? ` · ${decision.direction}` : ""}
                    </span>
                    {decision.requiredBy?.length ? (
                      <small>
                        Required by {decision.requiredBy.join(", ")}
                      </small>
                    ) : null}
                    {decision.warning && (
                      <small className="management-warning">
                        {decision.warning}
                      </small>
                    )}
                    <select
                      aria-label={`Dependency choice for ${decision.title}`}
                      value={resolutions[decision.key] || decision.choice}
                      disabled={Boolean(busy)}
                      onChange={(event) => {
                        const next = {
                          ...resolutions,
                          [decision.key]: event.target.value,
                        };
                        setResolutions(next);
                        void preview(undefined, next);
                      }}
                    >
                      {decision.allowedChoices.map((choice) => (
                        <option key={choice} value={choice}>
                          {choice === "keep-installed"
                            ? "Keep installed version"
                            : choice === "skip"
                              ? "Skip this dependency (review risk)"
                              : "Use proposed version"}
                        </option>
                      ))}
                    </select>
                  </label>
                ),
              )}
            </section>
          )}
          {(plan?.runtimeRequirements || runtimeProblems).length > 0 && (
            <div className="launchpad-inline-notice launchpad-clean-warning">
              <div>
                <strong>Runtime requirements need review</strong>
                {(plan?.runtimeRequirements || runtimeProblems).map(
                  (requirement, index) => (
                    <p key={index}>
                      {requirement.mod || requirement.path} requires{" "}
                      {requirement.id}{" "}
                      {typeof requirement.range === "string"
                        ? requirement.range
                        : JSON.stringify(requirement.range)}
                      ; installed {requirement.installed || "unknown"}. Status:{" "}
                      {requirement.status}.
                    </p>
                  ),
                )}
                <a href="#versions">Review server runtime in Versions</a>
                <p>Install anyway accepts these compatibility risks.</p>
              </div>
            </div>
          )}
          {!!plan?.skippedUpdates?.length && (
            <div className="launchpad-inline-notice">
              <div>
                <strong>Updates excluded from this review</strong>
                {plan.skippedUpdates.map((item, index) => (
                  <p key={index}>
                    {item.title || item.projectId}: {item.reason}
                  </p>
                ))}
              </div>
            </div>
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
                  {selection?.bulk ? "Close review" : "Back"}
                </button>
                <button
                  type="button"
                  className={`btn ${type === "modpack" || plan.cleanInstall ? "danger" : "primary"}`}
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
                    ? "Starting installation…"
                    : type !== "modpack" && plan.files.length === 0
                      ? "Already up to date"
                      : plan.unavailableDependencies?.length ||
                          plan.runtimeRequirements?.length
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
                  (type !== "modpack" &&
                    (!config.gameVersion || !config.loader) &&
                    !manualRuntimeAcknowledged) ||
                  (!selection?.bulk &&
                    (!selectedVersion?.downloadable || versionsLoading)) ||
                  (selection?.bulk && selectedUpdatePaths?.size === 0)
                }
              >
                {busy === "preview" ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <ArrowRight size={15} />
                )}
                {busy === "preview"
                  ? "Preparing review…"
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
              ? `${contentName === "plugin" ? "Plugin" : "Mod"} removal blocked`
              : "Removal needs review"
            : `Remove ${contentName}`}
        </h2>
        <p className="management-dialog-description">
          <strong>
            {removalPlan?.title || removal?.title || removal?.name}
          </strong>
        </p>
        {busy === "removal-preview" && (
          <p className="management-dialog-description" role="status">
            {type === "mod" || type === "plugin"
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
                <p>
                  {removalPlan.includesDependents
                    ? `These dependent ${contentName}s are included in this removal:`
                    : `These installed ${contentName}s require this file:`}
                </p>
                <ul
                  aria-label={`${contentName === "plugin" ? "Plugins" : "Mods"} requiring this ${contentName}`}
                  tabIndex={0}
                >
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
                These installed {contentName}s require the selected file. Review
                removing them together below, or keep this file installed.
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
        {removalPlan?.blocked && (
          <label className="launchpad-clean-confirm">
            <input
              type="checkbox"
              checked={removalDependentsAccepted}
              disabled={Boolean(busy)}
              onChange={(event) =>
                setRemovalDependentsAccepted(event.target.checked)
              }
            />
            I understand that removing only this file can prevent dependent{" "}
            {contentName}s from loading.
          </label>
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
          {removalPlan?.blocked && removal && (
            <button
              className="btn danger"
              disabled={Boolean(busy)}
              onClick={() => void reviewRemoval(removal, true)}
            >
              Review removing dependents together
            </button>
          )}
          {removalPlan?.orphanCandidates?.length &&
          removal &&
          !removalPlan.blocked ? (
            <button
              className="btn"
              disabled={Boolean(busy)}
              onClick={() =>
                void reviewRemoval(
                  removal,
                  Boolean(removalPlan.includesDependents),
                  removalPlan.orphanCandidates!.map((item) => item.path),
                )
              }
            >
              Review optional unused dependencies (
              {removalPlan.orphanCandidates.length})
            </button>
          ) : null}
          {removalPlan &&
          (!removalPlan.blocked || removalDependentsAccepted) ? (
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
              {busy === "remove"
                ? "Removing…"
                : removalPlan.blocked
                  ? `Remove ${contentName} anyway`
                  : `Remove ${contentName}`}
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
        ref={historyDialog}
        className="modal management-dialog launchpad-dialog"
        aria-labelledby="content-history-title"
        onCancel={(event) => {
          event.preventDefault();
          setHistoryOpen(false);
        }}
      >
        <h2 id="content-history-title">Recent content changes</h2>
        {historyLoading ? (
          <p role="status">Loading changes…</p>
        ) : historyError ? (
          <p role="alert">{historyError}</p>
        ) : contentHistory.length ? (
          <ul className="launchpad-review-files">
            {contentHistory.map((item) => (
              <li key={item.jobId}>
                <span>
                  <strong>{item.title}</strong>
                  <small className="launchpad-previous-path">
                    {new Date(item.createdAt).toLocaleString()}
                    {item.undoneAt ? " · Undone" : ""}
                  </small>
                </span>
                {item.undoAvailable && (
                  <button
                    className="btn"
                    disabled={!canInstall}
                    onClick={() => reviewUndo(item.jobId, item.title)}
                  >
                    Review undo
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p>No retained content changes are available.</p>
        )}
        <div className="management-dialog-actions">
          <button className="btn" onClick={() => setHistoryOpen(false)}>
            Close
          </button>
          {historyError && (
            <button className="btn" onClick={() => void openContentHistory()}>
              Retry
            </button>
          )}
        </div>
      </dialog>
      <dialog
        ref={undoDialog}
        className="modal management-dialog launchpad-dialog"
        aria-labelledby="content-undo-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!undoBusy) setUndoReview(null);
        }}
      >
        <h2 id="content-undo-title">Undo content change</h2>
        <p>
          <strong>{undoReview?.title}</strong>
        </p>
        <p>
          The host will verify that affected files still match the recorded
          change, restore previous files and version records, and remove newly
          installed dependencies from that operation. Restored versions will be
          held from automatic updates.
        </p>
        {!canInstall && (
          <p className="management-warning">{changeDisabledReason}</p>
        )}
        {undoError && (
          <p role="alert" className="management-form-error">
            {undoError}
          </p>
        )}
        <div className="management-dialog-actions">
          <button
            className="btn"
            disabled={undoBusy}
            onClick={() => setUndoReview(null)}
          >
            Cancel
          </button>
          <button
            className="btn danger"
            disabled={undoBusy || !canInstall}
            onClick={() => void undoContent()}
          >
            {undoBusy ? "Restoring previous files…" : "Confirm undo"}
          </button>
        </div>
      </dialog>
      <dialog
        ref={clientPackDialog}
        className="modal management-dialog launchpad-dialog"
        aria-labelledby="client-pack-title"
        onCancel={(event) => {
          event.preventDefault();
          setClientPack(null);
        }}
      >
        <h2 id="client-pack-title">Export client pack</h2>
        <p>
          {clientPack?.filename} · {clientPack?.files || 0} files
        </p>
        <p>
          Share the reviewed client downloads with players. Check the export
          warnings for files that need manual installation.
        </p>
        {clientPack?.warnings.map((warning) => (
          <p className="management-warning" key={warning}>
            {warning}
          </p>
        ))}
        <div className="management-dialog-actions">
          <button className="btn" onClick={() => setClientPack(null)}>
            Cancel
          </button>
          <DownloadButton
            className="btn primary"
            href={downloadUrl("/launchpad/client-pack")}
            onError={(message) => notify(message, true)}
          >
            Download client pack
          </DownloadButton>
        </div>
      </dialog>
      <dialog
        ref={activationDialog}
        className="modal management-dialog launchpad-dialog"
        aria-labelledby="launchpad-activation-title"
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) {
            setActivation(null);
            cancelSelectionBatch();
          }
        }}
      >
        <h2 id="launchpad-activation-title">Review dependency risks</h2>
        {activation?.warnings.map((warning) => (
          <p key={warning} className="management-warning">
            {warning}
          </p>
        ))}
        <p>
          Changing this {contentName} can leave other installed {contentName}s
          without required dependencies.
        </p>
        <div className="management-dialog-actions">
          <button
            className="btn"
            disabled={Boolean(busy)}
            onClick={() => {
              setActivation(null);
              cancelSelectionBatch();
            }}
          >
            Cancel
          </button>
          <button
            className="btn danger"
            disabled={Boolean(busy)}
            onClick={() =>
              activation &&
              void setContentActive(activation.entry, activation.active, true)
            }
          >
            Change active state anyway
          </button>
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
              {busy === "settings" ? "Saving…" : "Save API key"}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
