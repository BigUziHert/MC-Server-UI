import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  Info,
  KeyRound,
  Layers3,
  LoaderCircle,
  Package,
  Puzzle,
  RefreshCw,
  Search,
  SlidersHorizontal,
  ExternalLink,
  X,
} from "lucide-react";
import { formatBytes, useServerApi, type PageProps } from "../api";
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
};
type Job = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  message: string;
  completed: number;
  total: number;
  error?: string;
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
type InstalledResult = { items: InstalledItem[]; warnings: string[] };
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
};
type Selection = { project: Project; installed?: InstalledItem };
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
  "sponge",
];
const loadersFor = (type: ContentType) =>
  type === "datapack"
    ? ["datapack"]
    : type === "plugin"
      ? pluginLoaders
      : modLoaders;
const messageOf = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "Unable to complete this request. Please try again.";
const queryString = (values: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.toString();
};
function ProjectIcon({ url }: { url?: string | null }) {
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

export default function Launchpad({ notify }: PageProps) {
  const { api, post } = useServerApi();
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState("");
  const [configLoading, setConfigLoading] = useState(true);
  const [platform, setPlatform] = useState("modrinth");
  const [type, setType] = useState<ContentType>("modpack");
  const [gameVersion, setGameVersion] = useState("");
  const [loader, setLoader] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("downloads");
  const [installedSort, setInstalledSort] = useState<InstalledSort>("updates");
  const [installedOnly, setInstalledOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("mc-panel.launchpad.rows"));
      return rowsOptions.includes(saved) ? saved : 10;
    } catch {
      return 10;
    }
  });
  const [results, setResults] = useState<SearchResult | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [installed, setInstalled] = useState<InstalledResult | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [scanError, setScanError] = useState("");
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [versionId, setVersionId] = useState("");
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsError, setVersionsError] = useState("");
  const [versionReload, setVersionReload] = useState(0);
  const [targetVersion, setTargetVersion] = useState("");
  const [targetLoader, setTargetLoader] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [dialogError, setDialogError] = useState("");
  const [busy, setBusy] = useState<"preview" | "install" | "settings" | null>(
    null,
  );
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
  const tabs = useRef<HTMLDivElement>(null);
  const source = config?.platforms.find((item) => item.id === platform);
  const sortOptions = source?.sortOptions ?? [];
  const catalogSort = sortOptions.some((item) => item.id === sort)
    ? sort
    : (sortOptions[0]?.id ?? "");
  const supported = Boolean(source?.types.includes(type));
  const working = Boolean(job && ["queued", "running"].includes(job.status));
  const canInstall = status === "offline" && !working;
  const loaders = loadersFor(type).filter(
    (value) => !config?.loaders || config.loaders.includes(value),
  );
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
    async (initial = false) => {
      const current = session.current;
      setConfigLoading(true);
      setConfigError("");
      try {
        const next = await api<Config>("/launchpad");
        if (current !== session.current) return;
        setConfig(next);
        setStatus(next.status);
        if (initial) {
          const first =
            next.platforms.find(
              (item) => item.id === "modrinth" && item.available,
            ) ??
            next.platforms.find((item) => item.available) ??
            next.platforms[0];
          setPlatform(first?.id ?? "modrinth");
          const initialType =
            pluginLoaders.includes(next.loader ?? "") &&
            first?.types.includes("plugin")
              ? "plugin"
              : first?.types.includes("modpack")
                ? "modpack"
                : (first?.types[0] ?? "modpack");
          setType(initialType);
          setGameVersion(
            next.gameVersion && /^\d+(?:\.\d+)+$/.test(next.gameVersion)
              ? next.gameVersion
              : "",
          );
          setLoader(
            loadersFor(initialType).includes(next.loader ?? "")
              ? next.loader!
              : initialType === "datapack"
                ? "datapack"
                : "",
          );
          setJob(next.job ?? null);
        }
      } catch (cause) {
        if (current === session.current) setConfigError(messageOf(cause));
      } finally {
        if (current === session.current) setConfigLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    session.current++;
    setConfig(null);
    setResults(null);
    setInstalled(null);
    setJob(null);
    setSelection(null);
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
    const timer = window.setInterval(() => {
      const current = session.current;
      void api<{ status: string }>("/server")
        .then((next) => {
          if (current === session.current) setStatus(next.status);
        })
        .catch(() => {
          if (current === session.current) setStatus(null);
        });
    }, 5000);
    return () => {
      session.current++;
      operation.current++;
      window.clearInterval(timer);
    };
  }, [api, loadConfig]);

  useEffect(() => {
    if (!config || installedOnly || !source?.available || !supported) {
      setSearchLoading(false);
      setSearchError("");
      setResults(null);
      return;
    }
    const controller = new AbortController();
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
    if (!config) return;
    const controller = new AbortController();
    setScanLoading(true);
    setScanError("");
    setInstalled(null);
    const timer = window.setTimeout(() => {
      void api<InstalledResult>(
        `/launchpad/installed?${queryString({ type, gameVersion: gameVersion.trim(), loader })}`,
        { signal: controller.signal },
      )
        .then((next) => {
          if (!controller.signal.aborted) setInstalled(next);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setScanError(messageOf(cause));
        })
        .finally(() => {
          if (!controller.signal.aborted) setScanLoading(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, config, type, gameVersion, loader, reload]);

  useEffect(() => {
    if (selection) dialog.current?.showModal();
    else dialog.current?.close();
  }, [selection]);
  useEffect(() => {
    if (settingsOpen) settingsDialog.current?.showModal();
    else settingsDialog.current?.close();
  }, [settingsOpen]);
  useEffect(() => {
    if (!selection) return;
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
          setReload((value) => value + 1);
          notify(next.job.message || "Installation completed.");
        }
        if (next.job.status === "failed")
          notify(next.job.error || next.job.message, true);
        if (["queued", "running"].includes(next.job.status))
          timer = window.setTimeout(poll, 1000);
      } catch (cause) {
        if (!controller.signal.aborted) {
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
  }, [api, job?.id, job?.status, jobReload, notify]);

  function chooseProject(project: Project, entry?: InstalledItem) {
    operation.current++;
    setDialogError("");
    setPlan(null);
    setTargetVersion(gameVersion);
    setTargetLoader(loader);
    setSelection({ project, installed: entry });
  }
  function closeSelection() {
    if (busy === "install") return;
    operation.current++;
    setSelection(null);
    setPlan(null);
    setDialogError("");
    pending.current = false;
    setBusy(null);
  }
  async function preview(event: FormEvent) {
    event.preventDefault();
    if (!selection || !versionId || pending.current) return;
    if (!targetVersion.trim()) {
      setDialogError(
        "Choose your server’s Minecraft version before reviewing this installation.",
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
      )
        setPlan(next);
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
      const next = await post<{ job: Job }>("/launchpad/install", {
        planId: plan.planId,
        confirmed: true,
      });
      if (
        currentSession !== session.current ||
        currentOperation !== operation.current
      )
        return;
      setJob(next.job);
      setJobError("");
      setSelection(null);
      setPlan(null);
      if (next.job.status === "completed") {
        setReload((value) => value + 1);
        notify(next.job.message);
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
  async function saveKey(value: string) {
    if (pending.current) return;
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
      setReload((value) => value + 1);
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
    .filter(
      (entry) =>
        (!entry.platform || entry.platform === platform) &&
        `${entry.title ?? ""} ${entry.name} ${entry.path} ${entry.author ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
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
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const selectedVersion = versions.find((version) => version.id === versionId);
  const loading = installedOnly ? scanLoading : searchLoading;
  const failed = installedOnly ? scanError : searchError;
  const keySource = config?.platforms.find((item) => item.id === "curseforge");
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
          },
          entry,
        }))
      : (results?.projects ?? []).map((project) => ({
          project,
          entry: installed?.items.find(
            (entry) =>
              entry.platform === project.platform &&
              entry.projectId === project.id,
          ),
        }));
  const warnings = [
    ...new Set([
      ...(config?.warnings ?? []),
      ...(installed?.warnings ?? []),
      ...(!installedOnly ? (results?.warnings ?? []) : []),
    ]),
  ];

  if (!config)
    return (
      <div className="management-page launchpad-page">
        <div className="page-heading">
          <h1>Launchpad</h1>
        </div>
        <div className="panel launchpad-empty">
          {configLoading ? (
            <>
              <LoaderCircle className="spin" size={24} />
              <p role="status">Loading Launchpad...</p>
            </>
          ) : (
            <>
              <AlertCircle size={24} />
              <h2>Unable to load Launchpad</h2>
              <p role="alert">{configError}</p>
              <button className="btn" onClick={() => void loadConfig(true)}>
                Try again
              </button>
            </>
          )}
        </div>
      </div>
    );

  return (
    <div className="management-page launchpad-page">
      <div className="page-heading management-heading">
        <div>
          <div className="management-eyebrow">MINECRAFT</div>
          <h1>Launchpad</h1>
        </div>
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
      </div>
      <div className="panel launchpad-filters">
        <label>
          Platform
          <select
            aria-label="Platform"
            value={platform}
            onChange={(event) => {
              const next = config.platforms.find(
                (item) => item.id === event.target.value,
              );
              setPlatform(event.target.value);
              setOffset(0);
              if (next && !next.types.includes(type))
                changeType(next.types[0] ?? "modpack");
            }}
          >
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
            value={gameVersion}
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
            value={loader}
            onChange={(event) => {
              setLoader(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">All loaders</option>
            {loaders.map((value) => (
              <option key={value} value={value}>
                {value}
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
            disabled={!source?.types.includes(id)}
            title={
              !source?.types.includes(id)
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
              const supportedKinds = kinds.filter((item) =>
                source?.types.includes(item.id),
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
        <div className="launchpad-pagination">
          <button
            className="btn icon"
            aria-label="Previous Launchpad page"
            disabled={loading || currentOffset === 0}
            onClick={() => setOffset(Math.max(0, currentOffset - limit))}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            className="btn icon"
            aria-label="Next Launchpad page"
            disabled={loading || currentOffset + limit >= total}
            onClick={() => setOffset(currentOffset + limit)}
          >
            <ChevronRight size={16} />
          </button>
          <label>
            Rows
            <select
              aria-label="Launchpad rows per page"
              value={limit}
              onChange={(event) => {
                const value = Number(event.target.value);
                setLimit(value);
                setOffset(0);
                try {
                  localStorage.setItem(
                    "mc-panel.launchpad.rows",
                    String(value),
                  );
                } catch {
                  /* Keep session pagination available. */
                }
              }}
            >
              {rowsOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <span role="status" aria-label="Launchpad page">
            Page {Math.floor(currentOffset / limit) + 1} of {pageCount}
          </span>
        </div>
        <label className="launchpad-search">
          <Search size={17} />
          <input
            aria-label="Search Launchpad"
            placeholder={`Search ${kinds.find((item) => item.id === type)?.label.toLowerCase()}...`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(0);
            }}
          />
        </label>
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
        <label className="launchpad-installed-toggle">
          <input
            type="checkbox"
            role="switch"
            aria-label="Show installed content"
            checked={installedOnly}
            onChange={(event) => {
              setInstalledOnly(event.target.checked);
              setOffset(0);
            }}
          />
          Installed only
        </label>
        <button
          className="btn icon"
          aria-label="Refresh Launchpad and check updates"
          disabled={configLoading || searchLoading || scanLoading}
          onClick={() => {
            void loadConfig();
            setReload((value) => value + 1);
          }}
        >
          <RefreshCw size={16} className={scanLoading ? "spin" : ""} />
        </button>
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
            </div>
            {!working && (
              <button
                className="btn icon"
                aria-label="Dismiss installation status"
                onClick={() => setJob(null)}
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
                Retry progress
              </button>
            </div>
          )}
        </div>
      )}
      {configError && (
        <div className="launchpad-error" role="alert">
          <AlertCircle size={16} />
          <span>{configError}</span>
          <button className="btn" onClick={() => void loadConfig()}>
            Retry settings
          </button>
        </div>
      )}
      {warnings.map((warning) => (
        <div className="launchpad-inline-notice" key={warning}>
          <Info size={16} />
          <div>{warning}</div>
        </div>
      ))}
      {!installedOnly && scanLoading && (
        <div className="launchpad-result-count" role="status">
          <LoaderCircle size={14} className="spin" /> Identifying installed
          files and checking for updates...
        </div>
      )}
      {!installedOnly && scanError && (
        <div className="launchpad-error" role="alert">
          <AlertCircle size={16} />
          <span>Installed content could not be checked. {scanError}</span>
          <button
            className="btn"
            onClick={() => setReload((value) => value + 1)}
          >
            Retry scan
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
          <div className="panel launchpad-empty">
            <SlidersHorizontal size={25} />
            <h2>
              {source?.name ?? "Platform"}{" "}
              {supported ? "is unavailable" : "does not offer this content"}
            </h2>
            <p>
              {source?.reason || "Choose another platform or content type."}
            </p>
            {source?.requiresKey && (
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
            )}
          </div>
        ) : loading ? (
          <div className="panel launchpad-empty">
            <LoaderCircle className="spin" size={25} />
            <p role="status">
              {installedOnly
                ? "Identifying installed files and checking updates..."
                : "Loading projects..."}
            </p>
          </div>
        ) : failed ? (
          <div className="panel launchpad-empty">
            <AlertCircle size={25} />
            <h2>
              Unable to load {installedOnly ? "installed content" : "projects"}
            </h2>
            <p role="alert">{failed}</p>
            <button
              className="btn"
              onClick={() => setReload((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : visibleProjects.length === 0 ? (
          <div className="panel launchpad-empty">
            <Package size={27} />
            <h2>
              {installedOnly
                ? "No installed content matches"
                : "No projects found"}
            </h2>
            <p>
              {installedOnly
                ? "Installed files appear here after a scan. Try another platform, content type, or search."
                : "Try another search, Minecraft version, or loader."}
            </p>
          </div>
        ) : (
          <>
            <div className="launchpad-result-count">
              {total.toLocaleString()}{" "}
              {installedOnly ? "installed items" : "projects"}
              {gameVersion ? ` · Minecraft ${gameVersion}` : ""}
              {loader ? ` · ${loader}` : ""}
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
                    {!entry?.platform && entry && (
                      <span>
                        Could not identify this file for automatic updates.
                      </span>
                    )}
                  </div>
                </div>
                <div className="launchpad-project-action">
                  {(!entry || (entry.platform && entry.projectId)) && (
                    <button
                      className={`btn ${entry && !entry.update ? "" : "primary"}`}
                      aria-label={`${entry?.update ? "Update" : entry ? "Choose version for" : "Install"} ${project.title}`}
                      disabled={
                        working ||
                        Boolean(busy) ||
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
            <span>{plan ? "Review file changes" : "Select a version"}</span>
          </div>
          <p className="management-dialog-description">
            {selection?.project.title}
          </p>
          {!plan ? (
            <>
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
                    Retry versions
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
                  <span>{selectedVersion.loaders.join(", ")}</span>
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
              <div className="form-field">
                <label htmlFor="launchpad-target-loader">Target loader</label>
                <select
                  id="launchpad-target-loader"
                  value={targetLoader}
                  disabled={Boolean(busy)}
                  onChange={(event) => setTargetLoader(event.target.value)}
                >
                  <option value="">Not selected</option>
                  {loaders.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <>
              <p className="management-dialog-description">
                <strong>{plan.versionName}</strong> will make these changes to
                this server. The server will remain stopped.
              </p>
              <ul
                className="launchpad-review-files"
                aria-label="Files to install"
                tabIndex={0}
              >
                {plan.files.map((file) => (
                  <li key={file.path}>
                    <span>
                      {file.path}
                      {file.previousPath && file.previousPath !== file.path && (
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
              </ul>
              {plan.warnings.map((warning) => (
                <p className="launchpad-review-warning" key={warning}>
                  {warning}
                </p>
              ))}
              <p className="management-dialog-description">
                Review {plan.files.length} file
                {plan.files.length === 1 ? "" : "s"} before continuing.
              </p>
            </>
          )}
          {!canInstall && (
            <p className="management-form-error" role="alert">
              {working
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
                    setPlan(null);
                    setDialogError("");
                  }}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={
                    Boolean(busy) || !canInstall || plan.files.length === 0
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
                  !selectedVersion?.downloadable ||
                  versionsLoading
                }
              >
                {busy === "preview" ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <ArrowRight size={15} />
                )}
                {busy === "preview"
                  ? "Preparing review..."
                  : "Review installation"}
              </button>
            )}
          </div>
        </form>
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
