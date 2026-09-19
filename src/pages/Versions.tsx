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
import SearchField, { useDebouncedValue } from "../SearchField";
import RefreshButton from "../RefreshButton";
import StatePanel from "../StatePanel";
import Switch from "../Switch";
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
type Release = { id: string; label: string; stable: boolean };
type Build = Release & {
  publishedAt?: string;
  javaVersion?: number;
  recommended?: boolean;
};
type Current = {
  software: string;
  version: string;
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
type Job = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  state?: "queued" | "running" | "complete" | "failed";
  message?: string;
  error?: string;
  progress?: { phase?: string; message?: string };
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

export default function Versions({ notify }: PageProps) {
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
  const [confirming, setConfirming] = useState<Build | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [installMode, setInstallMode] = useState<"update" | "clean">("clean");
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [dialogError, setDialogError] = useState("");
  const generation = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const jobBusy = job?.status === "queued" || job?.status === "running";
  const canUpdate = Boolean(
    runtimeUpdate?.available &&
    runtimeUpdate.provider === selected?.id &&
    runtimeUpdate.gameVersion === version,
  );
  const updating = installMode === "update";

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
    setReleases([]);
    setBuilds([]);
    setReleaseSearch("");
    setSelected(null);
    setVersion("");
    setJob(null);
    setConfirming(null);
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
          notify(
            result.message ||
              "Server software installed. Start the server when you are ready.",
          );
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
        } else if (result.status === "failed")
          notify(
            result.error || result.message || "Installation failed.",
            true,
          );
        else timer = setTimeout(poll, 1000);
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
  }, [api, job?.id, jobBusy, notify]);

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
  async function install() {
    if (
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
    try {
      const result = normalizeJob(
        await post<Job | { job: Job }>("/versions/install", {
          provider: selected.id,
          version,
          build: confirming.id,
          confirmed: true,
          ...(updating ? { updateRuntime: true } : { cleanInstall: true }),
        }),
      );
      if (token === generation.current) {
        setJob(result);
        setConfirming(null);
      }
    } catch (cause) {
      if (token === generation.current)
        setDialogError(
          cause instanceof Error
            ? cause.message
            : "Unable to start the installation.",
        );
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
              {current.software} <span>{current.version}</span>
            </strong>
          </div>
          <span className={`status-badge ${current.status}`}>
            {current.status}
          </span>
          <span className="versions-current-hint">
            Runtime updates keep your files. Clean installs replace them.
          </span>
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
                job.progress?.message ||
                job.message ||
                "Preparing the official download…"}
            </p>
          </div>
          {!jobBusy && (
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
      {(selected?.kind === "proxy" || current?.software === "Velocity") && (
        <div className="management-notice">
          <Info size={18} />
          <div>
            <strong>Proxy setup</strong>
            <p>
              Velocity connects players to your game servers. Before starting,
              configure its bind address, port, and backend servers in
              velocity.toml using File Manager. The panel’s Minecraft port
              setting does not configure Velocity’s listener.
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
            <RefreshButton
              label="Refresh versions"
              disabled={jobBusy || submitting}
              onRefresh={() => refresh(true)}
              notify={notify}
              successMessage="Versions refreshed."
            />
            <SearchField
              className="management-search"
              aria-label="Search server software"
              grow
              placeholder="Search server software…"
              value={search}
              onValueChange={setSearch}
            />
            <span>
              {providers.length
                ? `${shownProviders.length} software options`
                : "Official provider catalogs"}
            </span>
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
                        disabled={jobBusy}
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
            <button className="btn" onClick={back}>
              <ArrowLeft size={15} /> All software
            </button>
            <h2>{selected.name}</h2>
            <RefreshButton
              label="Refresh versions"
              disabled={jobBusy || submitting}
              onRefresh={() => refresh(true)}
              notify={notify}
              successMessage="Versions refreshed."
            />
            <a
              className="versions-source"
              href={selected.website}
              target="_blank"
              rel="noreferrer"
            >
              Official source <ArrowUpRight size={14} />
            </a>
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
                    <button
                      key={release.id}
                      className={version === release.id ? "active" : ""}
                      onClick={() => void chooseVersion(release.id)}
                    >
                      <span>{release.label}</span>
                      {!release.stable && <small>Experimental</small>}
                      <ChevronRight size={14} />
                    </button>
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
                          {build.label}{" "}
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
                            : `Minecraft ${version}`}
                          {build.javaVersion
                            ? ` · Java ${build.javaVersion}+`
                            : ""}{" "}
                          · {build.stable ? "Stable" : "Experimental"}
                        </span>
                      </div>
                      <button
                        className="btn primary"
                        disabled={jobBusy || current?.status !== "offline"}
                        onClick={() => {
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
          {updating ? "Update" : "Install"} {selected?.name} {confirming?.label}{" "}
          for Minecraft {version}. The server will remain stopped when
          installation finishes.
        </p>
        {!canUpdate && runtimeUpdate?.reason && (
          <p className="management-dialog-description">
            {runtimeUpdate.reason}
          </p>
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
