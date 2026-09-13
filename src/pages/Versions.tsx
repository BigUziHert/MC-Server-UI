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
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { ServerScope, useServerApi, type PageProps } from "../api";
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
type Build = Release & { publishedAt?: string; javaVersion?: number };
type Current = {
  software: string;
  version: string;
  status: string;
  mode: string;
};
type Job = {
  id: string;
  state: "queued" | "running" | "complete" | "failed";
  message?: string;
  error?: string;
  progress?: { phase?: string; message?: string };
};

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

function SoftwareIcon({ software }: { software: string }) {
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
  const [selected, setSelected] = useState<Provider | null>(null);
  const [releases, setReleases] = useState<Release[]>([]);
  const [version, setVersion] = useState("");
  const [builds, setBuilds] = useState<Build[]>([]);
  const [search, setSearch] = useState("");
  const [showExperimental, setShowExperimental] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingBuilds, setLoadingBuilds] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<Build | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [dialogError, setDialogError] = useState("");
  const generation = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const jobBusy = job?.state === "queued" || job?.state === "running";

  const refresh = useCallback(async () => {
    const token = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const [catalog, server] = await Promise.all([
        api<{ providers: Provider[]; job?: Job | null }>("/versions"),
        api<Current>("/server"),
      ]);
      if (token !== generation.current) return;
      setProviders(catalog.providers);
      setJob(catalog.job ?? null);
      setCurrent(server);
    } catch (cause) {
      if (token === generation.current)
        setError(
          cause instanceof Error ? cause.message : "Unable to load versions.",
        );
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
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
      void api<Current>("/server")
        .then((server) => {
          if (!cancelled) setCurrent(server);
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
        const result = await api<Job>(
          `/versions/jobs/${encodeURIComponent(job!.id)}`,
        );
        if (cancelled) return;
        setJob(result);
        if (result.state === "complete") {
          notify(
            result.message ||
              "Server software installed. Start the server when you are ready.",
          );
          const server = await api<Current>("/server");
          if (!cancelled) setCurrent(server);
        } else if (result.state === "failed")
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
          timer = setTimeout(poll, 3000);
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
    setSearch("");
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
    if (!selected || !confirming || !accepted) return;
    const token = generation.current;
    setSubmitting(true);
    setDialogError("");
    try {
      const result = await post<Job>("/versions/install", {
        provider: selected.id,
        version,
        build: confirming.id,
        confirmed: true,
      });
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
    setSearch("");
    setError("");
    setLoading(false);
    setLoadingBuilds(false);
  }
  const shownProviders = providers.filter((provider) =>
    `${provider.name} ${provider.description}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const shownReleases = releases.filter(
    (release) =>
      (showExperimental || release.stable) &&
      release.label.toLowerCase().includes(search.toLowerCase()),
  );
  const shownBuilds = builds.filter(
    (build) => showExperimental || build.stable,
  );
  return (
    <div className="management-page versions-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">MINECRAFT</p>
          <h1>Versions</h1>
          <p>Choose the software that runs your world.</p>
        </div>
        <button
          className="btn"
          onClick={() =>
            selected ? void chooseProvider(selected) : void refresh()
          }
          disabled={loading || jobBusy}
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
      {current && (
        <section className="versions-current panel">
          <div className="versions-current-icon">
            <SoftwareIcon software={current.software} />
          </div>
          <div>
            <span className="eyebrow">CURRENT SOFTWARE</span>
            <strong>
              {current.software} <span>{current.version}</span>
            </strong>
          </div>
          <span className={`status-badge ${current.status}`}>
            {current.status}
          </span>
          <span className="versions-current-hint">
            Installs preserve your world and existing JVM settings.
          </span>
        </section>
      )}
      {job && (
        <section
          className={`management-notice versions-job ${job.state === "failed" ? "warning" : ""}`}
          role="status"
        >
          {jobBusy ? (
            <LoaderCircle size={19} className="versions-spin" />
          ) : job.state === "complete" ? (
            <Check size={19} />
          ) : (
            <AlertCircle size={19} />
          )}
          <div>
            <strong>
              {jobBusy
                ? "Installing server software"
                : job.state === "complete"
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
        <div className="management-notice warning" role="alert">
          <AlertCircle size={17} />
          <span>{error}</span>
        </div>
      )}
      {!selected ? (
        <>
          <div className="versions-toolbar">
            <label className="management-search">
              <Search size={16} />
              <input
                aria-label="Search server software"
                placeholder="Search server software…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <span>
              {providers.length
                ? `${shownProviders.length} software options`
                : "Official provider catalogs"}
            </span>
          </div>
          {loading ? (
            <div className="versions-loading">
              <LoaderCircle className="versions-spin" /> Loading server
              software…
            </div>
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
              <label className="management-search">
                <Search size={15} />
                <input
                  aria-label="Search Minecraft versions"
                  placeholder="Search versions…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <label className="versions-toggle">
                <input
                  type="checkbox"
                  checked={showExperimental}
                  onChange={(event) =>
                    setShowExperimental(event.target.checked)
                  }
                />{" "}
                Include experimental releases
              </label>
              <div className="versions-release-list">
                {loading ? (
                  <p className="versions-loading">Loading releases…</p>
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
                  <p className="versions-empty">
                    No matching releases. Try changing the filter.
                  </p>
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
              {!version ? (
                <div className="versions-empty">
                  <SoftwareIcon software={selected.id} />
                  <h3>Find the right version for your world</h3>
                  <p>
                    Select a release to see available builds from{" "}
                    {selected.name}.
                  </p>
                </div>
              ) : loadingBuilds ? (
                <div className="versions-loading">
                  <LoaderCircle className="versions-spin" /> Loading official
                  builds…
                </div>
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
                          {index === 0 && (
                            <span className="tag">Newest shown</span>
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
                          setAccepted(false);
                          setDialogError("");
                        }}
                      >
                        <Download size={14} /> Install
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="versions-empty">
                  <Info size={27} />
                  <h3>No builds match this filter</h3>
                  <p>
                    {builds.length
                      ? "Include experimental releases to see the available builds."
                      : "The provider has no server build for this release."}
                  </p>
                </div>
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
          <h2 id="versions-install-title">Install {selected?.name}</h2>
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
          Install {selected?.name} {version}, {confirming?.label}. This updates
          server software and startup settings. Your world, mods, plugins, and
          existing JVM settings stay in place. The next Start runs real server
          software.
        </p>
        <div className="management-notice">
          <Info size={18} />
          <div>
            <strong>Check compatibility before changing versions</strong>
            <p>
              Keep a backup of your world. Mods and plugins must support the
              selected software and Minecraft release.
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
          I’m ready to install this version on the selected server.
        </label>
        {dialogError && (
          <p className="management-form-error" role="alert">
            {dialogError}
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
            disabled={!accepted || submitting}
            onClick={() => void install()}
          >
            {submitting ? (
              <LoaderCircle size={15} className="versions-spin" />
            ) : (
              <Download size={15} />
            )}{" "}
            {submitting ? "Preparing…" : "Install version"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
