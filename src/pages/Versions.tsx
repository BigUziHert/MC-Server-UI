import { useCallback, useContext, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  Download,
  Info,
  Layers,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { ServerScope, useServerApi, type PageProps } from "../api";
import { canChangeContent } from "../page-permissions";
import SearchField, { useDebouncedValue } from "../SearchField";
import RefreshButton, { refreshedTooltip } from "../RefreshButton";
import StatePanel from "../StatePanel";
import Switch from "../Switch";
import { safeProjectUrl } from "../../shared/launchpad-project.mjs";
import "./management.css";
import "./versions.css";

type Provider = {
  id: string;
  name: string;
  description: string;
  website: string;
  installable: boolean;
  kind: "server" | "proxy";
  badge?: string;
};
type Release = { id: string; label: string; stable: boolean; url?: string };
type Build = Release & {
  publishedAt?: string;
  javaVersion?: number;
  maxJavaVersion?: number;
  recommended?: boolean;
};
type Current = {
  software: string;
  version: string;
  url?: string;
  status: string;
  mode: "live";
};
type RuntimeUpdate = {
  available: boolean;
  reason?: string;
  provider: string | null;
  gameVersion: string | null;
  build: string | null;
};
type Catalog = {
  providers: Provider[];
  current?: Current;
  runtimeUpdate?: RuntimeUpdate;
  job?: Job | null;
};

function VersionLink({
  label,
  software,
  url,
  iconOnly,
}: {
  label: string;
  software?: string;
  url?: string;
  iconOnly?: boolean;
}) {
  const href = safeProjectUrl(url);
  if (!href) return iconOnly ? null : label;
  const description = `Open official page for ${software ? `${software} ` : ""}${label}`;
  return (
    <a
      className={iconOnly ? "versions-release-link" : "versions-version-link"}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={description}
      title={iconOnly ? description : undefined}
    >
      {!iconOnly && label}
      <ArrowUpRight size={iconOnly ? 16 : 13} aria-hidden="true" />
    </a>
  );
}

function installedRuntimeBuild(runtime?: RuntimeUpdate | null) {
  const build =
    runtime?.build ??
    (runtime?.provider === "vanilla" ? runtime.gameVersion : null);
  return build && /^\d[\w.+-]*$/.test(build) ? build : null;
}

function buildJava(build: Build) {
  if (!build.javaVersion) return "";
  if (!build.maxJavaVersion) return `Java ${build.javaVersion}+`;
  return build.maxJavaVersion === build.javaVersion
    ? `Java ${build.javaVersion}`
    : `Java ${build.javaVersion}–${build.maxJavaVersion}`;
}

function newerStableBuild(candidate: Build, installed: string) {
  const installedCore = installed.replace(
    /[-.]?(?:alpha|beta|snapshot|pre|rc).*$/i,
    "",
  );
  const comparison = candidate.id.localeCompare(installedCore, "en", {
    numeric: true,
  });
  return comparison > 0 || (comparison === 0 && installedCore !== installed);
}

type Job = {
  id: string;
  requestId?: string;
  status: "queued" | "running" | "completed" | "failed";
  state?: "queued" | "running" | "complete" | "failed";
  message?: string;
  error?: string;
  progress?: {
    phase?: string;
    message?: string;
    completed?: number;
    total?: number;
  };
};

function normalizeJob(value: Job | { job: Job }): Job {
  const job = "job" in value ? value.job : value;
  return {
    ...job,
    status:
      job.status ??
      (job.state === "complete" ? "completed" : (job.state ?? "failed")),
  };
}

const softwareIcons: Record<string, string> = {
  vanilla: "vanilla.png",
  paper: "paper.svg",
  pufferfish: "pufferfish.png",
  spigot: "spigot.png",
  purpur: "purpur.svg",
  waterfall: "waterfall.svg",
  velocity: "velocity.svg",
  fabric: "fabric.png",
  quilt: "quilt.svg",
  forge: "forge.png",
  neoforge: "neoforge.svg",
  mohist: "mohist.png",
  arclight: "arclight.png",
  sponge: "sponge.svg",
  leaves: "leaves.svg",
  canvas: "canvas.png",
  magma: "magma.png",
  folia: "folia.png",
};

export function SoftwareIcon({ software }: { software: string }) {
  const id = software.trim().toLowerCase();
  const source = Object.hasOwn(softwareIcons, id) ? softwareIcons[id] : null;
  const [failed, setFailed] = useState<string | null>(null);
  return source && failed !== source ? (
    <img
      className={`software-logo software-logo-${id}`}
      src={`/software-icons/${source}`}
      alt=""
      aria-hidden="true"
      draggable={false}
      onError={() => setFailed(source)}
    />
  ) : (
    <Layers className="software-logo-fallback" size={22} aria-hidden="true" />
  );
}

export default function Versions({
  notify,
  permissions,
}: PageProps & { permissions?: string[] }) {
  const allowChanges = canChangeContent(permissions);
  const { api, post } = useServerApi();
  const scope = useContext(ServerScope);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [current, setCurrent] = useState<Current | null>(null);
  const [runtimeUpdate, setRuntimeUpdate] = useState<RuntimeUpdate | null>(
    null,
  );
  const [selected, setSelected] = useState<Provider | null>(null);
  const [releases, setReleases] = useState<Release[]>([]);
  const [version, setVersion] = useState("");
  const [builds, setBuilds] = useState<Build[]>([]);
  const [search, setSearch] = useState("");
  const [releaseSearch, setReleaseSearch] = useState("");
  const softwareQuery = useDebouncedValue(search),
    releaseQuery = useDebouncedValue(releaseSearch);
  const loaded = useRef(false);
  const selectionRef = useRef({ selected, version });
  selectionRef.current = { selected, version };
  const [showExperimental, setShowExperimental] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingBuilds, setLoadingBuilds] = useState(false);
  const [error, setError] = useState("");
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<Build | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [installMode, setInstallMode] = useState<"update" | "clean">("clean");
  const [submitting, setSubmitting] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [dialogError, setDialogError] = useState("");
  const installRequest = useRef<{ id: string; signature: string } | null>(null);
  const uncertainInstall = useRef<string | null>(null);
  const generation = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const jobBusy = job?.status === "queued" || job?.status === "running";
  const currentProvider = providers.find(
    (provider) => provider.id === runtimeUpdate?.provider,
  );
  const proxy =
    selected?.kind === "proxy"
      ? selected.name
      : ["Velocity", "Waterfall"].find((name) => name === current?.software);
  const quickUpdateReason = !allowChanges
    ? "You do not have permission to update server software."
    : jobBusy || submitting
      ? "Wait for the current installation to finish."
      : current?.status !== "offline"
        ? "Stop this server before updating."
        : !runtimeUpdate?.available ||
            !runtimeUpdate.gameVersion ||
            !currentProvider?.installable
          ? runtimeUpdate?.reason ||
            "Quick updates are unavailable for this runtime."
          : !installedRuntimeBuild(runtimeUpdate)
            ? "Installed build could not be identified. Choose a version to review an update."
            : "";
  const canUpdate = Boolean(
    runtimeUpdate?.available &&
    runtimeUpdate.provider === selected?.id &&
    runtimeUpdate.gameVersion === version,
  );
  const updating = installMode === "update";
  const updateReason = canUpdate
    ? ""
    : runtimeUpdate?.reason ||
      (runtimeUpdate?.available && runtimeUpdate.provider !== selected?.id
        ? "Runtime updates require the same server software. Changing software requires a clean install."
        : runtimeUpdate?.available && runtimeUpdate.gameVersion !== version
          ? `Runtime updates are available for Minecraft ${runtimeUpdate.gameVersion}. Changing the Minecraft release requires a clean install.`
          : "");

  const refresh = useCallback(
    async (manual = false) => {
      const token = ++generation.current;
      if (!loaded.current) setLoading(true);
      setError("");
      const target = selectionRef.current;
      try {
        const [catalog, server, releaseResult, buildResult] = await Promise.all(
          [
            api<Catalog>(`/versions${manual ? "?refresh=1" : ""}`),
            api<Current>("/server"),
            manual && target.selected
              ? api<{ versions: Release[] }>(
                  `/versions/${encodeURIComponent(target.selected.id)}?refresh=1`,
                )
              : Promise.resolve(null),
            manual && target.selected && target.version
              ? api<{ builds: Build[] }>(
                  `/versions/${encodeURIComponent(target.selected.id)}/${encodeURIComponent(target.version)}?refresh=1`,
                )
              : Promise.resolve(null),
          ],
        );
        if (token !== generation.current) return false;
        loaded.current = true;
        if (releaseResult) setReleases(releaseResult.versions);
        if (buildResult) {
          setBuilds(buildResult.builds);
          setLoadingBuilds(false);
        }
        setProviders(catalog.providers);
        setJob(catalog.job ? normalizeJob(catalog.job) : null);
        setCurrent({ ...server, ...catalog.current, status: server.status });
        setRuntimeUpdate(catalog.runtimeUpdate ?? null);
        setLastRefreshedAt(Date.now());
        return true;
      } catch (cause) {
        if (token === generation.current)
          setError(
            cause instanceof Error ? cause.message : "Unable to load versions.",
          );
        return false;
      } finally {
        if (token === generation.current) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    loaded.current = false;
    setProviders([]);
    setCurrent(null);
    setRuntimeUpdate(null);
    setLastRefreshedAt(null);
    setReleases([]);
    setBuilds([]);
    setReleaseSearch("");
    setSelected(null);
    setVersion("");
    setJob(null);
    setConfirming(null);
    installRequest.current = null;
    uncertainInstall.current = null;
    setCheckingUpdate(false);
    setSearch("");
    void refresh();
    return () => {
      generation.current++;
    };
  }, [scope, refresh]);
  useEffect(() => {
    let cancelled = false;
    const timer = setInterval(() => {
      void Promise.all([api<Current>("/server"), api<Catalog>("/versions")])
        .then(([server, catalog]) => {
          if (!cancelled) {
            setCurrent({
              ...server,
              ...catalog.current,
              status: server.status,
            });
            setRuntimeUpdate(catalog.runtimeUpdate ?? null);
            const acceptedJob = catalog.job ? normalizeJob(catalog.job) : null;
            if (
              uncertainInstall.current &&
              acceptedJob?.requestId === uncertainInstall.current
            ) {
              uncertainInstall.current = null;
              setJob(acceptedJob);
              setConfirming(null);
              setDialogError("");
            }
          }
        })
        .catch(() => {});
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api]);
  useEffect(() => {
    if (confirming) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirming]);
  useEffect(() => {
    if (!jobBusy || !job) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = normalizeJob(
          await api<Job | { job: Job }>(
            `/versions/jobs/${encodeURIComponent(job!.id)}`,
          ),
        );
        if (cancelled) return;
        setJob(result);
        if (result.status === "completed") {
          const [server, catalog] = await Promise.all([
            api<Current>("/server"),
            api<Catalog>("/versions"),
          ]);
          if (!cancelled) {
            setCurrent({
              ...server,
              ...catalog.current,
              status: server.status,
            });
            setRuntimeUpdate(catalog.runtimeUpdate ?? null);
          }
        } else if (result.status !== "failed") timer = setTimeout(poll, 1000);
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to check installation progress.",
          );
          if ((cause as { status?: number }).status === 404) {
            setJob(null);
            setError(
              "This installation is no longer being tracked. Check the current server software before trying again.",
            );
          } else timer = setTimeout(poll, 3000);
        }
      }
    }
    timer = setTimeout(poll, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, job?.id, jobBusy]);

  async function chooseProvider(provider: Provider) {
    const token = ++generation.current;
    setSelected(provider);
    setVersion("");
    setBuilds([]);
    setReleases([]);
    setReleaseSearch("");
    setError("");
    setLoading(true);
    try {
      const result = await api<{ versions: Release[] }>(
        `/versions/${encodeURIComponent(provider.id)}`,
      );
      if (token !== generation.current) return;
      setReleases(result.versions);
    } catch (cause) {
      if (token === generation.current)
        setError(
          cause instanceof Error ? cause.message : "Unable to load releases.",
        );
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }
  async function chooseVersion(next: string) {
    if (!selected) return;
    const token = ++generation.current;
    setVersion(next);
    setBuilds([]);
    setError("");
    setLoadingBuilds(true);
    try {
      const result = await api<{ builds: Build[] }>(
        `/versions/${encodeURIComponent(selected.id)}/${encodeURIComponent(next)}`,
      );
      if (token === generation.current) setBuilds(result.builds);
    } catch (cause) {
      if (token === generation.current)
        setError(
          cause instanceof Error ? cause.message : "Unable to load builds.",
        );
    } finally {
      if (token === generation.current) setLoadingBuilds(false);
    }
  }
  async function quickUpdate() {
    if (quickUpdateReason || checkingUpdate || loading || loadingBuilds) return;
    const token = ++generation.current;
    setCheckingUpdate(true);
    setError("");
    try {
      const [catalog, server] = await Promise.all([
        api<Catalog>("/versions?refresh=1"),
        api<Current>("/server"),
      ]);
      if (token !== generation.current) return;
      const runtime = catalog.runtimeUpdate;
      const provider = catalog.providers.find(
        (entry) => entry.id === runtime?.provider,
      );
      const latestJob = catalog.job ? normalizeJob(catalog.job) : null;
      setCurrent({ ...server, ...catalog.current, status: server.status });
      setRuntimeUpdate(runtime ?? null);
      setProviders(catalog.providers);
      setJob(latestJob);
      if (server.status !== "offline")
        throw new Error("Stop this server before updating.");
      if (latestJob?.status === "queued" || latestJob?.status === "running")
        throw new Error("Wait for the current installation to finish.");
      if (!runtime?.available || !runtime.gameVersion || !provider?.installable)
        throw new Error(
          runtime?.reason || "Quick updates are unavailable for this runtime.",
        );
      const installedBuild = installedRuntimeBuild(runtime);
      if (!installedBuild)
        throw new Error(
          "Installed build could not be identified. Choose a version to review an update.",
        );
      const base = `/versions/${encodeURIComponent(provider.id)}`;
      // Refreshing builds also refreshes its provider's release catalog.
      const buildResult = await api<{ builds: Build[] }>(
        `${base}/${encodeURIComponent(runtime.gameVersion)}?refresh=1`,
      );
      if (token !== generation.current) return;
      const latest = buildResult.builds
        .filter((build) => build.stable)
        .sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }))[0];
      if (!latest)
        throw new Error(
          `No stable ${provider.name} builds are available for Minecraft ${runtime.gameVersion}. Choose a version to review experimental builds.`,
        );
      if (!newerStableBuild(latest, installedBuild)) {
        notify(
          `No newer stable ${provider.name} build is available for Minecraft ${runtime.gameVersion}.`,
        );
        return;
      }
      const releaseResult = await api<{ versions: Release[] }>(base);
      if (token !== generation.current) return;
      setSelected(provider);
      setVersion(runtime.gameVersion);
      setReleases(releaseResult.versions);
      setBuilds(buildResult.builds);
      setReleaseSearch("");
      setLoading(false);
      setLoadingBuilds(false);
      installRequest.current = null;
      uncertainInstall.current = null;
      setConfirming(latest);
      setInstallMode("update");
      setAccepted(false);
      setDialogError("");
    } catch (cause) {
      if (token === generation.current)
        notify(
          cause instanceof Error
            ? cause.message
            : "Unable to check for updates.",
          true,
        );
    } finally {
      if (token === generation.current) setCheckingUpdate(false);
    }
  }
  async function install() {
    if (
      !allowChanges ||
      !selected ||
      !confirming ||
      (updating ? !canUpdate : !accepted) ||
      submitting ||
      jobBusy ||
      current?.status !== "offline"
    )
      return;
    const token = ++generation.current;
    setLoading(false);
    setSubmitting(true);
    setDialogError("");
    const input = {
      provider: selected.id,
      version,
      build: confirming.id,
      confirmed: true,
      ...(updating ? { updateRuntime: true } : { cleanInstall: true }),
    };
    const signature = JSON.stringify(input);
    if (installRequest.current?.signature !== signature)
      installRequest.current = { id: crypto.randomUUID(), signature };
    try {
      const result = normalizeJob(
        await post<Job | { job: Job }>("/versions/install", {
          ...input,
          requestId: installRequest.current.id,
        }),
      );
      if (token === generation.current) {
        uncertainInstall.current = null;
        setJob(result);
        setConfirming(null);
      }
    } catch (cause) {
      if (token === generation.current) {
        const status = (cause as { status?: number }).status;
        if (!status || status >= 500)
          uncertainInstall.current = installRequest.current.id;
        setDialogError(
          cause instanceof Error
            ? `${cause.message}${uncertainInstall.current ? " Checking whether the original installation was accepted. Retrying this confirmation will not start it twice." : ""}`
            : "Unable to start the installation.",
        );
      }
    } finally {
      if (token === generation.current) setSubmitting(false);
    }
  }
  function back() {
    generation.current++;
    setSelected(null);
    setVersion("");
    setReleaseSearch("");
    setError("");
    setLoading(false);
    setLoadingBuilds(false);
  }
  const shownProviders = providers.filter((provider) =>
    `${provider.name} ${provider.description}`
      .toLowerCase()
      .includes(softwareQuery.toLowerCase()),
  );
  const shownReleases = releases.filter(
    (release) =>
      (showExperimental || release.stable) &&
      release.label.toLowerCase().includes(releaseQuery.toLowerCase()),
  );
  const shownBuilds = builds.filter(
    (build) => showExperimental || build.stable,
  );
  return (
    <div className="management-page versions-page">
      <div className="page-heading">
        <div>
          <h1>Versions</h1>
        </div>
      </div>
      {current && (
        <section className="versions-current panel">
          <div className="versions-current-icon">
            <SoftwareIcon software={current.software} />
          </div>
          <div>
            <p className="eyebrow">CURRENT SOFTWARE</p>
            <strong>
              {current.software}{" "}
              <span>
                <VersionLink
                  label={current.version}
                  software={current.software}
                  url={current.url}
                />
              </span>
            </strong>
          </div>
          <span className={`status-badge ${current.status}`}>
            {current.status}
          </span>
          <div className="versions-current-update">
            <button
              className="btn primary"
              disabled={
                Boolean(quickUpdateReason) ||
                checkingUpdate ||
                loading ||
                loadingBuilds
              }
              aria-describedby="versions-quick-update-hint"
              onClick={() => void quickUpdate()}
            >
              {checkingUpdate ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <RefreshCw size={15} />
              )}
              {checkingUpdate ? "Checking…" : "Quick update"}
            </button>
            <span id="versions-quick-update-hint">
              {quickUpdateReason ||
                `Latest stable build · Keeps files${runtimeUpdate?.gameVersion ? ` · Minecraft ${runtimeUpdate.gameVersion}` : ""}`}
            </span>
          </div>
        </section>
      )}
      {job && (
        <section
          className={`management-notice versions-job ${job.status === "failed" ? "warning" : ""}`}
          role="status"
        >
          {jobBusy ? (
            <LoaderCircle size={19} className="spin" />
          ) : job.status === "completed" ? (
            <Check size={19} />
          ) : (
            <AlertCircle size={19} />
          )}
          <div>
            <strong>
              {jobBusy
                ? "Installing server software"
                : job.status === "completed"
                  ? "Installation complete"
                  : "Installation failed"}
            </strong>
            <p>
              {job.error ||
                (jobBusy ? job.progress?.message : undefined) ||
                job.message ||
                (jobBusy
                  ? "Preparing the official download…"
                  : job.status === "completed"
                    ? "Server software installed. Start the server when you are ready."
                    : "Installation failed.")}
            </p>
            {jobBusy && (
              <progress
                aria-label="Installation progress"
                max={Math.max(1, job.progress?.total ?? 0)}
                value={job.progress?.total ? job.progress.completed : undefined}
              />
            )}
          </div>
          {!jobBusy &&
            (permissions === undefined ||
              permissions.includes("file.update")) && (
              <button
                className="btn icon"
                aria-label="Dismiss installation status"
                onClick={async () => {
                  const dismissedId = job.id;
                  try {
                    await post(
                      `/versions/jobs/${encodeURIComponent(dismissedId)}/dismiss`,
                      {},
                    );
                    setJob((currentJob) =>
                      currentJob?.id === dismissedId ? null : currentJob,
                    );
                  } catch (cause) {
                    notify(
                      cause instanceof Error
                        ? cause.message
                        : "Unable to dismiss installation status.",
                      true,
                    );
                  }
                }}
              >
                <X size={16} />
              </button>
            )}
        </section>
      )}
      {proxy && (
        <div className="management-notice">
          <Info size={18} />
          <div>
            <strong>Proxy setup</strong>
            <p>
              {proxy === "Waterfall"
                ? "Waterfall is a discontinued proxy. After its first start, configure its listener and backend servers in config.yml using File Manager."
                : "Velocity connects players to your game servers. Configure its bind address, port, and backend servers in velocity.toml using File Manager."}
            </p>
          </div>
        </div>
      )}
      {error && (
        <StatePanel
          variant="error"
          title="Unable to load versions"
          message={error}
          onRetry={() => void refresh(true)}
        />
      )}
      {!selected ? (
        <>
          <div className="versions-toolbar">
            <SearchField
              className="management-search page-search"
              aria-label="Search server software"
              placeholder="Search server software…"
              value={search}
              onValueChange={setSearch}
            />
            <span>
              {providers.length
                ? `${shownProviders.length} software options`
                : "Official provider catalogs"}
            </span>
            <RefreshButton
              label="Refresh versions"
              disabled={jobBusy || submitting || checkingUpdate}
              onRefresh={() => refresh(true)}
              notify={notify}
              successMessage="Versions refreshed."
              tooltip={() => refreshedTooltip(lastRefreshedAt, loading)}
            />
          </div>
          {loading && !providers.length ? (
            <StatePanel variant="loading" title="Loading server software…" />
          ) : (
            <div className="versions-grid">
              {shownProviders.map((provider) => (
                <article
                  className={`panel version-provider version-provider-${provider.id}`}
                  key={provider.id}
                >
                  <div className="version-provider-mark" aria-hidden="true">
                    <SoftwareIcon software={provider.id} />
                  </div>
                  <div className="version-provider-content">
                    <div className="version-provider-top">
                      <h2>{provider.name}</h2>
                      <span className="version-provider-kind">
                        {provider.badge ||
                          (provider.kind === "proxy"
                            ? "Proxy"
                            : "Java Edition")}
                      </span>
                    </div>
                    <p>{provider.description}</p>
                  </div>
                  <div className="version-provider-actions">
                    {!provider.installable && (
                      <span className="version-provider-manual">
                        Manual installation
                      </span>
                    )}
                    {provider.installable ? (
                      <button
                        className="btn"
                        onClick={() => void chooseProvider(provider)}
                        disabled={jobBusy || checkingUpdate}
                      >
                        Choose version <ChevronRight size={15} />
                      </button>
                    ) : (
                      <a
                        className="btn"
                        href={provider.website}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Official downloads <ArrowUpRight size={15} />
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="versions-toolbar">
            <button className="btn" onClick={back} disabled={checkingUpdate}>
              <ArrowLeft size={15} /> All software
            </button>
            <h2>{selected.name}</h2>
            <a
              className="versions-source"
              href={selected.website}
              target="_blank"
              rel="noreferrer"
            >
              Official source <ArrowUpRight size={14} />
            </a>
            <RefreshButton
              label="Refresh versions"
              disabled={jobBusy || submitting || checkingUpdate}
              onRefresh={() => refresh(true)}
              notify={notify}
              successMessage="Versions refreshed."
              tooltip={() => refreshedTooltip(lastRefreshedAt, loading)}
            />
          </div>
          <div className="versions-browser">
            <section className="panel versions-releases">
              <div className="panel-title">
                <SoftwareIcon software={selected.id} />
                <h3>
                  {selected.kind === "proxy"
                    ? "Proxy releases"
                    : "Minecraft releases"}
                </h3>
              </div>
              <SearchField
                className="management-search"
                iconSize={15}
                aria-label="Search Minecraft versions"
                placeholder="Search versions…"
                value={releaseSearch}
                onValueChange={setReleaseSearch}
              />
              <Switch
                className="versions-toggle"
                label="Include experimental releases"
                checked={showExperimental}
                onCheckedChange={setShowExperimental}
              />
              <div className="versions-release-list">
                {loading && !releases.length ? (
                  <StatePanel variant="loading" title="Loading releases…" />
                ) : shownReleases.length ? (
                  shownReleases.map((release) => (
                    <div className="versions-release" key={release.id}>
                      <button
                        className={version === release.id ? "active" : ""}
                        onClick={() => void chooseVersion(release.id)}
                        disabled={checkingUpdate}
                      >
                        <span>{release.label}</span>
                        {!release.stable && <small>Experimental</small>}
                        <ChevronRight size={14} />
                      </button>
                      <VersionLink
                        label={release.label}
                        software={selected.name}
                        url={release.url}
                        iconOnly
                      />
                    </div>
                  ))
                ) : (
                  <StatePanel
                    variant="empty"
                    title="No matching releases"
                    message="Try changing the filter."
                  />
                )}
              </div>
            </section>
            <section className="panel versions-builds">
              <div className="panel-title">
                <Download size={16} />
                <h3>
                  {version
                    ? `${selected.name} · ${version}`
                    : "Choose a release"}
                </h3>
                {version && (
                  <span className="count-badge">{shownBuilds.length}</span>
                )}
              </div>
              {version && updateReason && (
                <p
                  className="versions-filter-notice"
                  id="runtime-update-reason"
                >
                  <Info size={16} aria-hidden="true" />
                  <span>{updateReason}</span>
                </p>
              )}
              {version &&
                !loadingBuilds &&
                !showExperimental &&
                builds.length > shownBuilds.length && (
                  <div className="versions-filter-notice">
                    <span>
                      {builds.length - shownBuilds.length} experimental
                      {builds.length - shownBuilds.length === 1
                        ? " build is"
                        : " builds are"}{" "}
                      hidden.
                    </span>
                    <button
                      className="btn"
                      onClick={() => setShowExperimental(true)}
                    >
                      Include experimental builds
                    </button>
                  </div>
                )}
              {!version ? (
                <StatePanel
                  variant="empty"
                  icon={<SoftwareIcon software={selected.id} />}
                  title="Find the right version for your world"
                  message={`Select a release to see available builds from ${selected.name}.`}
                />
              ) : loadingBuilds && !builds.length ? (
                <StatePanel
                  variant="loading"
                  title="Loading official builds…"
                />
              ) : shownBuilds.length ? (
                <div className="versions-build-list">
                  {shownBuilds.map((build, index) => (
                    <div className="versions-build" key={build.id}>
                      <div className="versions-build-icon">
                        <SoftwareIcon software={selected.id} />
                      </div>
                      <div className="versions-build-info">
                        <strong>
                          <VersionLink
                            label={build.label}
                            software={selected.name}
                            url={build.url}
                          />
                          {(build.recommended || index === 0) && (
                            <span className="tag">
                              {build.recommended
                                ? "Recommended"
                                : "Newest shown"}
                            </span>
                          )}
                        </strong>
                        <span>
                          {build.publishedAt
                            ? new Date(build.publishedAt).toLocaleDateString(
                                undefined,
                                {
                                  year: "numeric",
                                  month: "short",
                                  day: "numeric",
                                },
                              )
                            : selected.kind === "proxy"
                              ? `Proxy release ${version}`
                              : `Minecraft ${version}`}
                          {build.javaVersion && ` · ${buildJava(build)}`} ·{" "}
                          {build.stable ? "Stable" : "Experimental"}
                        </span>
                      </div>
                      <button
                        className="btn primary"
                        aria-describedby={
                          updateReason ? "runtime-update-reason" : undefined
                        }
                        disabled={
                          !allowChanges ||
                          checkingUpdate ||
                          jobBusy ||
                          current?.status !== "offline"
                        }
                        onClick={() => {
                          installRequest.current = null;
                          uncertainInstall.current = null;
                          setConfirming(build);
                          setInstallMode(canUpdate ? "update" : "clean");
                          setAccepted(false);
                          setDialogError("");
                        }}
                      >
                        {canUpdate ? (
                          <RefreshCw size={14} />
                        ) : (
                          <Download size={14} />
                        )}
                        {canUpdate ? "Update" : "Install"}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <StatePanel
                  variant="empty"
                  icon={<Info size={27} />}
                  title="No builds match this filter"
                  message={
                    builds.length
                      ? "Include experimental releases to see the available builds."
                      : "The provider has no server build for this release."
                  }
                />
              )}
              <div className="versions-build-footer">
                <ShieldCheck size={15} />
                <span>
                  {current?.status !== "offline"
                    ? "Stop this server before installing a version."
                    : "Downloads are verified against official checksums. Your server stays stopped after installation."}
                </span>
              </div>
            </section>
          </div>
        </>
      )}
      <dialog
        ref={dialog}
        className="modal management-dialog"
        aria-labelledby="versions-install-title"
        onCancel={(event) => {
          if (submitting) event.preventDefault();
          else setConfirming(null);
        }}
      >
        <div className="modal-header">
          <h2 id="versions-install-title">
            {updating ? "Update" : "Install"} {selected?.name}
          </h2>
          <button
            className="btn icon"
            aria-label="Close installation dialog"
            onClick={() => setConfirming(null)}
            disabled={submitting}
          >
            <X size={19} />
          </button>
        </div>
        <p className="management-dialog-description">
          {updating ? "Update" : "Install"} {selected?.name}{" "}
          {confirming && (
            <VersionLink
              label={confirming.label}
              software={selected?.name}
              url={confirming.url}
            />
          )}{" "}
          for {selected?.kind === "proxy" ? "proxy release" : "Minecraft"}{" "}
          {version}. The server will remain stopped when installation finishes.
        </p>
        {selected?.id === "spigot" && (
          <p>
            BuildTools compiles Spigot locally using Git and the panel’s
            configured JDK
            {confirming?.javaVersion ? ` (${buildJava(confirming)})` : ""}. The
            build can take several minutes.
          </p>
        )}
        {updateReason && (
          <p className="management-dialog-description">{updateReason}</p>
        )}
        {(canUpdate || updating) && (
          <fieldset className="versions-install-mode" disabled={submitting}>
            <legend>Installation type</legend>
            <label>
              <input
                type="radio"
                name="version-install-mode"
                value="update"
                checked={updating}
                disabled={!canUpdate}
                onChange={() => {
                  setInstallMode("update");
                  setAccepted(false);
                  setDialogError("");
                }}
              />
              <span>
                <strong>Update runtime</strong>
                <small>Keep worlds, mods, plugins and settings.</small>
              </span>
            </label>
            <label>
              <input
                type="radio"
                name="version-install-mode"
                value="clean"
                checked={!updating}
                onChange={() => {
                  setInstallMode("clean");
                  setAccepted(false);
                  setDialogError("");
                }}
              />
              <span>
                <strong>Clean install</strong>
                <small>Replace all files in this server’s folder.</small>
              </span>
            </label>
          </fieldset>
        )}
        {updating ? (
          <div className="management-notice">
            <ShieldCheck size={18} />
            <div>
              <strong>Your server files stay in place</strong>
              <p>
                Only the {selected?.name} runtime is updated. Your worlds, mods,
                plugins, configuration and Java settings are preserved.
                {confirming && !confirming.stable
                  ? " This is an experimental build."
                  : ""}
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="management-notice warning">
              <AlertCircle size={18} />
              <div>
                <strong>This replaces the server folder’s contents</strong>
                <p>
                  All current files will be removed, including worlds, mods,
                  plugins and settings. The selected software will be installed
                  into a clean folder.
                  {confirming && !confirming.stable
                    ? " This is an experimental build."
                    : ""}
                </p>
              </div>
            </div>
            <label className="versions-confirm">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />{" "}
              I understand this replaces all files in this server’s folder.
            </label>
          </>
        )}
        {updating && !canUpdate && (
          <p className="management-form-error" role="alert">
            The current runtime changed or could not be verified. Close this
            dialog and review the version again.
          </p>
        )}
        {dialogError && (
          <p className="management-form-error" role="alert">
            {dialogError}
          </p>
        )}
        {current?.status !== "offline" && (
          <p className="management-form-error" role="alert">
            Stop this server before installing a version.
          </p>
        )}
        <div className="modal-actions">
          <button
            className="btn"
            onClick={() => setConfirming(null)}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={
              !allowChanges ||
              (updating ? !canUpdate : !accepted) ||
              submitting ||
              jobBusy ||
              current?.status !== "offline"
            }
            onClick={() => void install()}
          >
            {submitting ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Download size={15} />
            )}{" "}
            {submitting
              ? "Preparing…"
              : updating
                ? "Update runtime"
                : "Install version"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
