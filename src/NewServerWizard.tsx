import {
  readSetupDrafts,
  saveSetupDraft,
  removeSetupDraft,
  useSetupScope,
} from "./setup-drafts";
import { peekSetupModpack, takeSetupModpack } from "./setup-handoff";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FolderOpen,
  Layers3,
  LoaderCircle,
  Package,
  RefreshCw,
  Settings2,
  Terminal,
  X,
} from "lucide-react";
import { usePanelApi, formatBytes } from "./api";
import type { ServerRecord } from "./ServerManager";
import SearchField, { useDebouncedValue } from "./SearchField";
import HostDirectoryPicker from "./HostDirectoryPicker";
import { JavaExecutableField } from "./LaunchSettings";
import { SoftwareIcon } from "./pages/Versions";
import { ProjectIcon } from "./pages/Launchpad";
import "./onboarding.css";

type Provider = {
  id: string;
  name: string;
  description: string;
  installable: boolean;
  website: string;
  kind: string;
};
type Release = {
  id: string;
  label: string;
  stable: boolean;
  recommended?: boolean;
  javaVersion?: number;
};
type Platform = {
  id: string;
  name: string;
  available: boolean;
  types: string[];
  requiresKey?: boolean;
  keyConfigured?: boolean;
  reason?: string;
  sortOptions?: { id: string; label: string }[];
};
type Java = {
  available: boolean;
  majorVersion?: number;
  version?: string;
  path?: string;
  error?: string;
};
type JavaInstallation = {
  path: string;
  version: string;
  majorVersion: number;
  vendor?: string;
  architecture?: string;
};
type JavaChoices = {
  installations: JavaInstallation[];
  recommendedPath: string | null;
  detectedCount: number;
  requiredJavaVersion: number | null;
  requirement: string;
  warnings: string[];
  installSupported?: boolean;
  installMessage?: string;
  installJob?: JavaInstallJob;
};
type JavaInstallJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  message: string;
  majorVersion: number | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error?: string;
};
type Catalog = {
  providers: Provider[];
  platforms: Platform[];
  gameVersions: string[];
  hostMemoryMB: number;
  runningAllocatedMemoryMB?: number;
  freeMemoryMB?: number;
  java: Java;
  warnings?: string[];
  managedServersDir?: string;
  managedJavaDirectory?: string;
  suggestedPort?: number;
};
type Project = {
  id: string;
  platform: string;
  title: string;
  description: string;
  iconUrl?: string;
  author?: string;
  downloads?: number;
  url?: string;
};
type PackVersion = {
  id: string;
  name: string;
  version: string;
  gameVersions: string[];
  loaders: string[];
  downloadable: boolean;
};
type Runtime = { loader: string; gameVersion: string; loaderVersion?: string };
type Plan = {
  planId: string;
  title: string;
  versionName: string;
  files: { path: string; size: number; action?: string }[];
  warnings: string[];
  loaderInstall?: Runtime;
  runtime?: {
    provider: string;
    version: string;
    build: string;
    software: string;
  };
  summary?: { fileCount: number; totalBytes: number };
  cleanInstall?: boolean;
  unavailableDependencies?: {
    platform: string;
    projectId?: string;
    versionId?: string;
    requiredBy?: string;
    issue?: string;
  }[];
};
type Job = {
  id: string;
  state?: string;
  status?: string;
  error?: string;
  message?: string;
  progress?: { message?: string };
  completed?: number;
  total?: number;
  cancellable?: boolean;
};
type Step = "source" | "catalog" | "configure" | "review" | "install" | "done";
type SetupResumeState = {
  version: 1;
  kind: "software" | "modpack";
  provider: Provider | null;
  project: Project | null;
  gameVersion: string;
  buildId: string;
  packVersionId: string;
  packLoader: string;
  runtime: { provider: string; version: string; build: string; label: string };
  plan: Plan | null;
  name: string;
  memory: string;
  port: string;
  javaPath: string;
  customLocation: boolean;
  installationDirectory: string;
  accepted: boolean;
  acknowledged: boolean;
  runtimeRequestId: string;
  runtimeDone: boolean;
  packDone: boolean;
  activeJob: { kind: "versions" | "launchpad"; id: string } | null;
  uncertainSubmission: "versions" | "launchpad" | null;
};
type Props = {
  resumeDraftId?: string;
  servers: ServerRecord[];
  remoteHost?: string;
  onBack: () => void;
  onClose: () => void;
  onSaved: (server: ServerRecord, outcome?: { incomplete?: boolean }) => void;
  onBackground?: () => void;
  onChangeHost?: () => void;
  onLockChange: (locked: boolean) => void;
  closeRequest: { current: (() => void) | null };
};
const names: Record<string, string> = {
  vanilla: "Vanilla",
  paper: "Paper",
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
  quilt: "Quilt",
  purpur: "Purpur",
  folia: "Folia",
  velocity: "Velocity",
};
const modLoaders = ["fabric", "forge", "neoforge", "quilt"];
const packPageSize = 20;
const normalizedFolder = (value: string) =>
  value.trim().replace(/^"(.*)"$/, "$1");
function javaVersions(choices: JavaChoices) {
  const versions = new Map<number, JavaInstallation>();
  const installations = [...choices.installations].sort(
    (a, b) =>
      b.majorVersion - a.majorVersion ||
      b.version.localeCompare(a.version, "en", { numeric: true }) ||
      Number(b.path === choices.recommendedPath) -
        Number(a.path === choices.recommendedPath) ||
      a.path.localeCompare(b.path, "en"),
  );
  for (const installation of installations)
    if (!versions.has(installation.majorVersion))
      versions.set(installation.majorVersion, installation);
  return [...versions.values()];
}
const message = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : "This request could not be completed. Please try again.";
const query = (values: Record<string, string | number>) =>
  new URLSearchParams(
    Object.entries(values)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => [key, String(value)]),
  ).toString();
const terminal = (job: Job) =>
  ["complete", "completed", "failed", "cancelled"].includes(
    job.state || job.status || "",
  );
const wait = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error("Setup view closed."));
    };
    signal.addEventListener("abort", cancel, { once: true });
  });

export default function NewServerWizard({
  servers,
  resumeDraftId,
  remoteHost,
  onBack,
  onClose,
  onSaved,
  onBackground,
  onChangeHost,
  onLockChange,
  closeRequest,
}: Props) {
  const { api } = usePanelApi();
  const setupScope = useSetupScope();
  const [savedDraft] = useState(() =>
    readSetupDrafts(setupScope).find((item) => item.id === resumeDraftId),
  );
  const [resumed] = useState(() => {
    const state = savedDraft?.state as SetupResumeState | undefined;
    return state?.version === 1 &&
      ["software", "modpack"].includes(state.kind) &&
      state.runtime &&
      typeof state.runtime.provider === "string" &&
      typeof state.runtimeRequestId === "string"
      ? state
      : undefined;
  });
  const draftCreatedAt = useRef(savedDraft?.createdAt || Date.now());
  const initialServer = savedDraft?.serverId
    ? (servers.find(
        (item) =>
          item.id === savedDraft.serverId &&
          (!savedDraft.serverDir ||
            !item.serverDir ||
            item.serverDir === savedDraft.serverDir),
      ) ?? null)
    : null;
  const [draftError, setDraftError] = useState("");
  const [handoff] = useState(peekSetupModpack);
  useEffect(() => {
    if (handoff) takeSetupModpack();
  }, [handoff]);
  const [step, setStep] = useState<Step>(
    resumed ? "install" : handoff ? "catalog" : "source",
  );
  const [kind, setKind] = useState<"software" | "modpack">(
    resumed?.kind ?? (handoff ? "modpack" : "software"),
  );
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [provider, setProvider] = useState<Provider | null>(
    resumed?.provider ?? null,
  );
  const [releases, setReleases] = useState<Release[]>([]);
  const [builds, setBuilds] = useState<Release[]>([]);
  const [gameVersion, setGameVersion] = useState(resumed?.gameVersion ?? "");
  const [buildId, setBuildId] = useState(resumed?.buildId ?? "");
  const [experimental, setExperimental] = useState(false);
  const [platform, setPlatform] = useState("modrinth");
  const [projects, setProjects] = useState<Project[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const softwareQuery = useDebouncedValue(search);
  const [filterVersion, setFilterVersion] = useState("");
  const [filterLoader, setFilterLoader] = useState("");
  const [sort, setSort] = useState("downloads");
  const [project, setProject] = useState<Project | null>(
    resumed?.project ??
      (handoff ? { ...handoff, iconUrl: handoff.iconUrl || undefined } : null),
  );
  const [packVersions, setPackVersions] = useState<PackVersion[]>([]);
  const [packVersionId, setPackVersionId] = useState(
    resumed?.packVersionId ?? "",
  );
  const [packLoader, setPackLoader] = useState(resumed?.packLoader ?? "");
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [name, setName] = useState(resumed?.name ?? "");
  const nameEdited = useRef(false);
  const memoryEdited = useRef(false);
  const portEdited = useRef(Boolean(resumed));
  const [memory, setMemory] = useState(resumed?.memory ?? "4");
  const [customLocation, setCustomLocation] = useState(
    resumed?.customLocation ?? false,
  );
  const [installationDirectory, setInstallationDirectory] = useState(
    resumed?.installationDirectory ?? "",
  );
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);
  const browseFolderButton = useRef<HTMLButtonElement>(null);
  const [supportDirectory, setSupportDirectory] = useState("");
  const [javaMajor, setJavaMajor] = useState<number | null>(null);
  const [customJava, setCustomJava] = useState(Boolean(resumed));
  const [customJavaPath, setCustomJavaPath] = useState(
    resumed?.javaPath ?? "java",
  );
  const [acknowledgedJavaCompatibility, setAcknowledgedJavaCompatibility] =
    useState(false);
  const [javaChoices, setJavaChoices] = useState<JavaChoices | null>(null);
  const [javaLoading, setJavaLoading] = useState(false);
  const [javaError, setJavaError] = useState("");
  const [javaRefresh, setJavaRefresh] = useState(0);
  const [javaChoicesKey, setJavaChoicesKey] = useState("");
  const [javaInstallJob, setJavaInstallJob] = useState<JavaInstallJob | null>(
    null,
  );
  const [javaInstallError, setJavaInstallError] = useState("");
  const [port, setPort] = useState(() => {
    if (resumed) return resumed.port;
    let next = 25565;
    while (servers.some((s) => s.port === next)) next++;
    return String(next);
  });
  const [plan, setPlan] = useState<Plan | null>(resumed?.plan ?? null);
  const [runtime, setRuntime] = useState<{
    provider: string;
    version: string;
    build: string;
    label: string;
  } | null>(resumed?.runtime ?? null);
  const [accepted, setAccepted] = useState(resumed?.accepted ?? false);
  const [acknowledged, setAcknowledged] = useState(
    resumed?.acknowledged ?? false,
  );
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creationRejected, setCreationRejected] = useState(false);
  const [configurationDetailsOpen, setConfigurationDetailsOpen] =
    useState(false);
  const [progress, setProgress] = useState("");
  const [jobProgress, setJobProgress] = useState<Job | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [created, setCreated] = useState<ServerRecord | null>(initialServer);
  const controller = useRef(new AbortController());
  const heading = useRef<HTMLHeadingElement>(null);
  const requestId = useRef(savedDraft?.id ?? crypto.randomUUID());
  const runtimeRequestId = useRef(
    resumed?.runtimeRequestId ?? crypto.randomUUID(),
  );
  const createdRef = useRef<ServerRecord | null>(initialServer);
  const runtimeDone = useRef(resumed?.runtimeDone ?? false);
  const packDone = useRef(resumed?.packDone ?? false);
  const activeJob = useRef<{
    kind: "versions" | "launchpad";
    id: string;
  } | null>(resumed?.activeJob ?? null);
  const uncertainSubmission = useRef<"versions" | "launchpad" | null>(
    resumed?.uncertainSubmission ?? null,
  );
  const observedJobs = useRef(new Set<string>());
  const busyRef = useRef(false);
  const packVersion = packVersions.find((item) => item.id === packVersionId);
  const build = builds.find((item) => item.id === buildId);
  const source = catalog?.platforms.find((item) => item.id === platform);
  const title = kind === "software" ? provider?.name : project?.title;
  const isPrepared =
    kind === "software"
      ? Boolean(provider && build && gameVersion)
      : Boolean(project && packVersion && gameVersion && packLoader);
  const javaSelectionKey = query({
    gameVersion,
    provider: kind === "software" ? provider?.id || "" : packLoader,
    requiredJavaVersion: kind === "software" ? build?.javaVersion || "" : "",
    build: kind === "software" ? buildId : "",
  });
  const selectedJava =
    customJava && customJavaPath.trim()
      ? {
          path: normalizedFolder(customJavaPath),
          majorVersion: javaMajor ?? 0,
          version: "Custom installation",
        }
      : javaChoicesKey === javaSelectionKey
        ? javaChoices?.installations.find(
            (item) => item.majorVersion === javaMajor,
          )
        : undefined;
  const canInstallJava =
    javaChoices?.installSupported &&
    Number.isInteger(javaChoices.requiredJavaVersion) &&
    (javaChoices.requiredJavaVersion ?? 0) >= 8;
  const displayStep = ["source", "catalog"].includes(step)
    ? 0
    : step === "configure"
      ? 1
      : step === "review"
        ? 2
        : 3;

  useEffect(() => {
    const lifetime = new AbortController();
    controller.current = lifetime;
    return () => lifetime.abort();
  }, []);
  useEffect(() => {
    onLockChange(busy);
    return () => onLockChange(false);
  }, [busy, onLockChange]);
  useEffect(() => {
    closeRequest.current = close;
    return () => {
      closeRequest.current = null;
    };
  });
  useEffect(() => {
    heading.current?.focus();
    const dialog = heading.current?.closest("dialog");
    if (dialog) dialog.scrollTop = 0;
  }, [step]);
  useEffect(() => {
    const cancel = new AbortController();
    setCatalogError("");
    void api<Catalog>("/server-setup", {
      signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(30000)]),
    })
      .then((result) => {
        if (cancel.signal.aborted) return;
        setCatalog(result);
        if (!portEdited.current && Number.isInteger(result.suggestedPort))
          setPort(String(result.suggestedPort));
      })
      .catch((cause) => {
        if (!cancel.signal.aborted) setCatalogError(message(cause));
      });
    return () => cancel.abort();
  }, [api, refresh]);
  useEffect(() => {
    if (step !== "configure" || !isPrepared) return;
    const cancel = new AbortController();
    setJavaLoading(true);
    setJavaError("");
    setJavaChoices(null);
    void api<JavaChoices>(
      `/server-setup/java?${javaSelectionKey}${javaRefresh ? "&refresh=1" : ""}`,
      { signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(30000)]) },
    )
      .then((result) => {
        if (cancel.signal.aborted) return;
        const installations = javaVersions(result);
        setJavaChoices({ ...result, installations });
        setJavaChoicesKey(javaSelectionKey);
        setJavaMajor((current) =>
          installations.some((item) => item.majorVersion === current)
            ? current
            : installations.find((item) => item.path === result.recommendedPath)
                ?.majorVersion ||
              installations[0]?.majorVersion ||
              null,
        );
        if (
          result.installJob &&
          ["queued", "running"].includes(result.installJob.status) &&
          !installations.length &&
          result.installJob.majorVersion === result.requiredJavaVersion &&
          result.requiredJavaVersion !== null &&
          !busyRef.current
        )
          void installJava(result.installJob);
      })
      .catch((cause) => {
        if (!cancel.signal.aborted) setJavaError(message(cause));
      })
      .finally(() => {
        if (!cancel.signal.aborted) setJavaLoading(false);
      });
    return () => cancel.abort();
  }, [api, step, isPrepared, javaSelectionKey, javaRefresh]);
  useEffect(() => {
    if (resumed || !provider || kind !== "software") return;
    const cancel = new AbortController();
    setLoading(true);
    setListError("");
    setReleases([]);
    setBuilds([]);
    setGameVersion("");
    setBuildId("");
    void api<{ versions: Release[] }>(
      `/server-setup/versions/${encodeURIComponent(provider.id)}`,
      { signal: cancel.signal },
    )
      .then((result) => {
        if (cancel.signal.aborted) return;
        setReleases(result.versions);
        setGameVersion(
          result.versions.find((item) => item.stable || experimental)?.id || "",
        );
      })
      .catch((cause) => {
        if (!cancel.signal.aborted) setListError(message(cause));
      })
      .finally(() => {
        if (!cancel.signal.aborted) setLoading(false);
      });
    return () => cancel.abort();
  }, [api, provider, kind, refresh]);
  useEffect(() => {
    if (resumed || !provider || !gameVersion || kind !== "software") return;
    const cancel = new AbortController();
    setLoading(true);
    setListError("");
    setBuilds([]);
    setBuildId("");
    void api<{ builds: Release[] }>(
      `/server-setup/versions/${encodeURIComponent(provider.id)}/${encodeURIComponent(gameVersion)}`,
      { signal: cancel.signal },
    )
      .then((result) => {
        if (cancel.signal.aborted) return;
        setBuilds(result.builds);
        const visible = result.builds.filter(
          (item) => item.stable || experimental,
        );
        setBuildId(
          (visible.find((item) => item.recommended) ?? visible[0])?.id ?? "",
        );
      })
      .catch((cause) => {
        if (!cancel.signal.aborted) setListError(message(cause));
      })
      .finally(() => {
        if (!cancel.signal.aborted) setLoading(false);
      });
    return () => cancel.abort();
  }, [api, provider, gameVersion, kind, refresh]);
  useEffect(() => {
    if (!catalog || kind !== "modpack" || step !== "catalog" || project) return;
    if (!source?.available || (source.requiresKey && !source.keyConfigured)) {
      setProjects([]);
      setTotal(0);
      return;
    }
    const cancel = new AbortController();
    setLoading(true);
    setListError("");
    setProjects([]);
    const timer = setTimeout(() => {
      void api<{ projects: Project[]; total: number }>(
        `/server-setup/launchpad/search?${query({ platform, type: "modpack", query: search.trim(), gameVersion: filterVersion, loader: filterLoader, sort, limit: packPageSize, offset })}`,
        { signal: cancel.signal },
      )
        .then((result) => {
          if (cancel.signal.aborted) return;
          setProjects(result.projects);
          setTotal(result.total);
        })
        .catch((cause) => {
          if (!cancel.signal.aborted) setListError(message(cause));
        })
        .finally(() => {
          if (!cancel.signal.aborted) setLoading(false);
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      cancel.abort();
    };
  }, [
    api,
    catalog,
    kind,
    step,
    project,
    platform,
    search,
    filterVersion,
    filterLoader,
    sort,
    offset,
    refresh,
  ]);
  useEffect(() => {
    if (resumed || !project) return;
    const cancel = new AbortController();
    setLoading(true);
    setListError("");
    setPackVersions([]);
    setPackVersionId("");
    void api<{ versions: PackVersion[] }>(
      `/server-setup/launchpad/versions?${query({ platform: project.platform, projectId: project.id, type: "modpack", gameVersion: filterVersion, loader: filterLoader })}`,
      { signal: cancel.signal },
    )
      .then((result) => {
        if (cancel.signal.aborted) return;
        setPackVersions(result.versions);
        setPackVersionId(
          result.versions.find((item) => item.downloadable)?.id || "",
        );
      })
      .catch((cause) => {
        if (!cancel.signal.aborted) setListError(message(cause));
      })
      .finally(() => {
        if (!cancel.signal.aborted) setLoading(false);
      });
    return () => cancel.abort();
  }, [api, project, filterVersion, filterLoader, refresh]);
  useEffect(() => {
    if (resumed || !packVersion) return;
    setGameVersion(
      packVersion.gameVersions.includes(filterVersion)
        ? filterVersion
        : [...packVersion.gameVersions].sort((a, b) =>
            b.localeCompare(a, "en", { numeric: true }),
          )[0] || "",
    );
    setPackLoader(
      packVersion.loaders.find(
        (value) => value === filterLoader && modLoaders.includes(value),
      ) ||
        packVersion.loaders.find((value) => modLoaders.includes(value)) ||
        "",
    );
  }, [packVersion, filterVersion, filterLoader]);

  const request = <T,>(
    path: string,
    body?: unknown,
    serverId?: string,
    method = "POST",
  ) =>
    api<T>(path, {
      ...(body === undefined ? {} : { method, body: JSON.stringify(body) }),
      headers: serverId ? { "X-Server-Id": serverId } : undefined,
      signal: AbortSignal.any([
        controller.current.signal,
        AbortSignal.timeout(body && path.endsWith("preview") ? 300000 : 30000),
      ]),
    });
  const packSelection = () => ({
    platform: project!.platform,
    projectId: project!.id,
    versionId: packVersionId,
    type: "modpack",
    gameVersion,
    loader: packLoader,
  });
  function go(next: Step) {
    if (busyRef.current || createdRef.current) return;
    setError("");
    setFolderBrowserOpen(false);
    setStep(next);
  }
  function chooseKind(value: "software" | "modpack") {
    setKind(value);
    setSearch("");
    setListError("");
    setStep("catalog");
  }
  function configure() {
    if (!isPrepared || loading) return;
    if (!nameEdited.current) {
      const base =
        kind === "modpack"
          ? project!.title.slice(0, 60)
          : "My Minecraft server";
      let suggested = base,
        index = 2;
      while (
        servers.some(
          (server) => server.name.toLowerCase() === suggested.toLowerCase(),
        )
      )
        suggested = `${base} ${index++}`;
      setName(suggested);
    }
    const suggestion = Math.max(
      1,
      Math.min(
        kind === "modpack" ? 6 : 4,
        Math.floor(
          Math.max(
            2048,
            (catalog?.hostMemoryMB || 8192) -
              (catalog?.runningAllocatedMemoryMB || 0),
          ) / 2048,
        ),
      ),
    );
    if (!memoryEdited.current) setMemory(String(suggestion));
    setStep("configure");
    setError("");
    setJavaInstallJob(null);
    setJavaInstallError("");
  }
  async function installJava(resume?: JavaInstallJob) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setJavaInstallError("");
    try {
      let job =
        resume ||
        (
          await request<{ job: JavaInstallJob }>("/server-setup/java/install", {
            gameVersion,
            provider: kind === "software" ? provider?.id : packLoader,
            ...(kind === "software" ? { build: buildId } : {}),
          })
        ).job;
      setJavaInstallJob(job);
      while (job.status === "queued" || job.status === "running") {
        await wait(controller.current.signal);
        const result = await request<{ job: JavaInstallJob }>(
          `/server-setup/java/jobs/${encodeURIComponent(job.id)}`,
        );
        job = result.job;
        setJavaInstallJob(job);
      }
      if (job.status === "failed")
        throw new Error(
          job.error || "Java could not be installed. Please try again.",
        );
      setJavaRefresh((value) => value + 1);
    } catch (cause) {
      if (!controller.current.signal.aborted)
        setJavaInstallError(message(cause));
    } finally {
      busyRef.current = false;
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function saveKey() {
    if (remoteHost || !apiKey.trim() || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await request(
        "/server-setup/launchpad/settings",
        { curseforgeApiKey: apiKey.trim() },
        undefined,
        "PUT",
      );
      setApiKey("");
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError(message(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function browseInstallationDirectory() {
    if (busyRef.current) return;
    setError("");
    setFolderBrowserOpen(true);
  }
  async function review(event: FormEvent) {
    event.preventDefault();
    if (busyRef.current || !isPrepared) return;
    if (javaLoading || !selectedJava) {
      setError(
        "Choose an installed, compatible Java version before continuing.",
      );
      return;
    }
    const mb = Number(memory) * 1024;
    if (!name.trim()) {
      setError("Give your server a name.");
      return;
    }
    if (!Number.isInteger(mb) || mb < 256 || mb > 262144) {
      setError("Choose between 0.25 and 256 GB of memory.");
      return;
    }
    if (
      !Number.isInteger(Number(port)) ||
      Number(port) < 1024 ||
      Number(port) > 65535 ||
      servers.some((s) => s.port === Number(port))
    ) {
      setError(
        servers.some((s) => s.port === Number(port))
          ? `Port ${port} is already used by ${servers.find((s) => s.port === Number(port))!.name}. Choose another port.`
          : "Choose an unused server port between 1024 and 65535 in Advanced settings.",
      );
      setConfigurationDetailsOpen(true);
      requestAnimationFrame(() =>
        document.getElementById("setup-port")?.focus(),
      );
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    setPlan(null);
    setAccepted(false);
    setAcknowledged(false);
    try {
      setProgress("Checking Java, memory, and installation folder…");
      const check = await request<{
        java: Java;
        compatible?: boolean;
        ready?: boolean;
        warnings?: string[];
        requiredJavaVersion?: number;
        installationDirectory?: string;
        supportDirectory?: string;
      }>("/server-setup/preflight", {
        memoryLimitMB: mb,
        port: Number(port),
        installationDirectory: customLocation
          ? normalizedFolder(installationDirectory)
          : undefined,
        javaPath: selectedJava.path,
        acknowledgedJavaCompatibility,
        provider: kind === "software" ? provider?.id : packLoader,
        gameVersion,
        requiredJavaVersion:
          kind === "software" ? build?.javaVersion : undefined,
      });
      if (!check.java.available || check.compatible === false) {
        setJavaRefresh((value) => value + 1);
        throw new Error(
          check.java.error ||
            `Java ${check.requiredJavaVersion || "for this Minecraft version"} is needed. Refresh Java and choose a compatible installation.`,
        );
      }
      if (check.ready === false)
        throw new Error(
          "Choose a smaller memory allocation so the server PC has RAM available for its operating system and other apps.",
        );
      setWarnings(check.warnings || []);
      if (check.installationDirectory)
        setInstallationDirectory(check.installationDirectory);
      setSupportDirectory(check.supportDirectory || "");
      if (kind === "modpack") {
        setProgress("Preparing the modpack installation review…");
        const next = await request<Plan>("/server-setup/modpack-preview", {
          ...packSelection(),
          installationDirectory: customLocation
            ? normalizedFolder(installationDirectory)
            : undefined,
        });
        const required = next.loaderInstall;
        if (
          !required?.loader ||
          !required.gameVersion ||
          !required.loaderVersion
        )
          throw new Error(
            "This pack does not identify an exact server runtime for automatic setup. Choose another release, or import a server you have already installed.",
          );
        if (
          required.loader !== packLoader ||
          required.gameVersion !== gameVersion
        )
          throw Object.assign(
            new Error("This release has a different declared runtime."),
            { detectedRuntime: required },
          );
        if (!next.runtime || !next.cleanInstall)
          throw new Error(
            `The required ${names[required.loader] || required.loader} ${required.loaderVersion} build is not available from its official catalog. Try another pack release.`,
          );
        setRuntime({
          provider: next.runtime.provider,
          version: next.runtime.version,
          build: next.runtime.build,
          label: `${next.runtime.software} ${next.runtime.build}`,
        });
        setPlan(next);
      } else
        setRuntime({
          provider: provider!.id,
          version: gameVersion,
          build: build!.id,
          label: `${provider!.name} ${build!.label}`,
        });
      setStep("review");
    } catch (cause) {
      if (!controller.current.signal.aborted) {
        const detected = (
          cause as {
            detectedRuntime?: {
              loader?: string;
              gameVersion?: string;
              loaderVersion?: string;
            };
          }
        )?.detectedRuntime;
        if (
          kind === "modpack" &&
          detected?.gameVersion &&
          detected.loader &&
          modLoaders.includes(detected.loader)
        ) {
          setGameVersion(detected.gameVersion);
          setPackLoader(detected.loader);
          setJavaRefresh((value) => value + 1);
          setAcknowledgedJavaCompatibility(false);
          setError(
            `This release runs on Minecraft ${detected.gameVersion} with ${names[detected.loader] || detected.loader}. The selection has been corrected. Check Java and review again before creating the server.`,
          );
        } else setError(message(cause));
      }
    } finally {
      busyRef.current = false;
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function followJob(
    job: Job,
    type: "versions" | "launchpad",
    serverId: string,
  ) {
    uncertainSubmission.current = null;
    observedJobs.current.add(`${type}:${job.id}`);
    activeJob.current = { kind: type, id: job.id };
    persistSetup();
    let current = job;
    while (!terminal(current)) {
      setJobProgress(current);
      setProgress(
        current.progress?.message ||
          current.message ||
          "Installing verified downloads…",
      );
      await wait(controller.current.signal);
      const response = await request<Job | { job: Job }>(
        `/${type}/jobs/${encodeURIComponent(job.id)}`,
        undefined,
        serverId,
      );
      current = "job" in response ? response.job : response;
    }
    activeJob.current = null;
    setJobProgress(null);
    if (
      ["failed", "cancelled"].includes(current.state || current.status || "")
    ) {
      if (type === "versions") runtimeRequestId.current = crypto.randomUUID();
      throw new Error(
        current.error ||
          current.message ||
          "Installation failed. You can retry using the same server.",
      );
    }
    if (type === "versions") runtimeDone.current = true;
    else packDone.current = true;
    persistSetup();
  }
  async function startJob(
    type: "versions" | "launchpad",
    body: unknown,
    serverId: string,
  ) {
    uncertainSubmission.current = type;
    persistSetup();
    try {
      const response = await request<Job | { job: Job }>(
        `/${type}/install`,
        type === "versions"
          ? {
              ...(body as Record<string, unknown>),
              requestId: runtimeRequestId.current,
            }
          : body,
        serverId,
      );
      return "job" in response ? response.job : response;
    } catch (cause) {
      // The server may have accepted the job before the response was lost.
      // This new workspace has only this wizard's installation sequence.
      const state = await request<{ job?: Job }>(
        `/${type}`,
        undefined,
        serverId,
      ).catch(() => null);
      if (state?.job && !observedJobs.current.has(`${type}:${state.job.id}`))
        return state.job;
      if (state) uncertainSubmission.current = null;
      throw cause;
    }
  }
  async function refreshCreatedServer() {
    const response = await request<{ servers: ServerRecord[] }>("/servers");
    const latest = response.servers.find(
      (server) => server.id === createdRef.current?.id,
    );
    if (!latest)
      throw new Error("Your server could not be found. Refresh and try again.");
    createdRef.current = latest;
    setCreated(latest);
    return latest;
  }
  async function cancelInstallation() {
    const pending = activeJob.current;
    if (
      !pending ||
      !createdRef.current ||
      !jobProgress?.cancellable ||
      cancelling
    )
      return;
    setCancelling(true);
    try {
      const result = await request<Job | { job: Job }>(
        `/${pending.kind}/jobs/${encodeURIComponent(pending.id)}/cancel`,
        {},
        createdRef.current.id,
      );
      setJobProgress("job" in result ? result.job : result);
    } catch (cause) {
      setError(message(cause));
    } finally {
      setCancelling(false);
    }
  }
  async function openConsole() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      onSaved(await refreshCreatedServer(), {
        incomplete: !(kind === "software"
          ? runtimeDone.current
          : packDone.current),
      });
    } catch (cause) {
      if (!controller.current.signal.aborted) setError(message(cause));
    } finally {
      busyRef.current = false;
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  function persistSetup() {
    if (!runtime) return;
    if (kind === "software" ? runtimeDone.current : packDone.current) {
      removeSetupDraft(setupScope, requestId.current);
      return;
    }
    const state: SetupResumeState = {
      version: 1,
      kind,
      provider,
      project,
      gameVersion,
      buildId,
      packVersionId,
      packLoader,
      runtime,
      plan,
      name,
      memory,
      port,
      javaPath: normalizedFolder(
        selectedJava?.path || customJavaPath || "java",
      ),
      customLocation,
      installationDirectory,
      accepted,
      acknowledged,
      runtimeRequestId: runtimeRequestId.current,
      runtimeDone: runtimeDone.current,
      packDone: packDone.current,
      activeJob: activeJob.current,
      uncertainSubmission: uncertainSubmission.current,
    };
    const stored = saveSetupDraft({
      id: requestId.current,
      scope: setupScope,
      createdAt: draftCreatedAt.current,
      name: name || "Unfinished server",
      serverId: createdRef.current?.id ?? savedDraft?.serverId,
      serverDir: createdRef.current?.serverDir ?? savedDraft?.serverDir,
      state,
    });
    if (!stored)
      setDraftError(
        "This browser could not save the setup draft. Keep this setup open until installation finishes.",
      );
  }
  useEffect(() => {
    if (step === "install" || step === "done" || created) persistSetup();
  }, [step, busy, error, jobProgress, created]);
  async function install() {
    if (
      busyRef.current ||
      !runtime ||
      ((kind !== "software" || provider?.kind !== "proxy") && !accepted) ||
      (plan?.unavailableDependencies?.length && !acknowledged)
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setStep("install");
    try {
      persistSetup();
      if (resumed && savedDraft?.serverId) {
        const response = await request<{ servers: ServerRecord[] }>("/servers");
        const existing = response.servers.find(
          (item) => item.id === savedDraft.serverId,
        );
        if (
          !existing ||
          (savedDraft.serverDir &&
            existing.serverDir &&
            existing.serverDir !== savedDraft.serverDir)
        )
          throw new Error(
            "The saved server was removed or its folder changed. This draft cannot create a replacement. Remove the draft from Add server and review the current server manually.",
          );
        createdRef.current = existing;
        setCreated(existing);
      }
      setProgress(
        createdRef.current
          ? "Checking the saved installation…"
          : "Creating your server…",
      );
      if (!createdRef.current) {
        setCreationRejected(false);
        const response = await request<{ server: ServerRecord }>(
          "/server-setup",
          {
            requestId: requestId.current,
            confirmed: true,
            acceptedEula:
              kind === "software" && provider?.kind === "proxy"
                ? false
                : accepted,
            configuration: {
              name: name.trim(),
              mode: "live",
              memoryLimitMB: Number(memory) * 1024,
              port: Number(port),
              javaPath: selectedJava?.path,
              installationDirectory: customLocation
                ? normalizedFolder(installationDirectory)
                : undefined,
            },
          },
        ).catch((cause: unknown) => {
          if (!controller.current.signal.aborted)
            setCreationRejected(
              (cause as { setupNotCreated?: boolean })?.setupNotCreated ===
                true,
            );
          throw cause;
        });
        createdRef.current = response.server;
        setCreated(response.server);
        persistSetup();
      }
      const serverId = createdRef.current.id;
      if (uncertainSubmission.current) {
        const type = uncertainSubmission.current;
        const state = await request<{ job?: Job }>(
          `/${type}`,
          undefined,
          serverId,
        );
        uncertainSubmission.current = null;
        if (state.job && !observedJobs.current.has(`${type}:${state.job.id}`))
          await followJob(state.job, type, serverId);
      }
      if (activeJob.current) {
        const pending = activeJob.current;
        const response = await request<Job | { job: Job }>(
          `/${pending.kind}/jobs/${encodeURIComponent(pending.id)}`,
          undefined,
          serverId,
        );
        await followJob(
          "job" in response ? response.job : response,
          pending.kind,
          serverId,
        );
      }
      if (kind === "software" && !runtimeDone.current) {
        setProgress(`Installing ${runtime.label}…`);
        await followJob(
          await startJob(
            "versions",
            {
              provider: runtime.provider,
              version: runtime.version,
              build: runtime.build,
              confirmed: true,
              cleanInstall: true,
            },
            serverId,
          ),
          "versions",
          serverId,
        );
      }
      if (kind === "modpack" && !packDone.current) {
        setProgress("Verifying modpack files for your new server…");
        const next = await request<Plan>(
          "/launchpad/preview",
          packSelection(),
          serverId,
        );
        const priorPaths = new Set(plan?.files.map((file) => file.path));
        const priorIssues = JSON.stringify(plan?.unavailableDependencies || []);
        if (
          next.files.some((file) => !priorPaths.has(file.path)) ||
          JSON.stringify(next.unavailableDependencies || []) !== priorIssues ||
          JSON.stringify(next.loaderInstall) !==
            JSON.stringify(plan?.loaderInstall) ||
          JSON.stringify(next.runtime) !== JSON.stringify(plan?.runtime)
        ) {
          setPlan(next);
          setAcknowledged(false);
          setStep("review");
          throw new Error(
            "The provider's installation details changed. Review the updated files before continuing.",
          );
        }
        await followJob(
          await startJob(
            "launchpad",
            {
              planId: next.planId,
              confirmed: true,
              cleanInstall: true,
              acknowledgedUnavailableDependencies: acknowledged,
            },
            serverId,
          ),
          "launchpad",
          serverId,
        );
      }
      await refreshCreatedServer();
      setProgress("Your server is ready.");
      setStep("done");
    } catch (cause) {
      if (!controller.current.signal.aborted) setError(message(cause));
    } finally {
      busyRef.current = false;
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  function close() {
    if (folderBrowserOpen) {
      setFolderBrowserOpen(false);
      browseFolderButton.current?.focus();
      return;
    }
    if (!busyRef.current) {
      if (step === "install" && !createdRef.current && !creationRejected) {
        setError(
          "Server creation has not been confirmed. Retry to check the original request before closing setup.",
        );
        return;
      }
      if (createdRef.current) void openConsole();
      else onClose();
    }
  }
  function back() {
    if (busyRef.current || createdRef.current) return;
    setError("");
    if (step === "source") onBack();
    else if (step === "catalog" && (provider || project)) {
      setProvider(null);
      setProject(null);
      setListError("");
    } else if (step === "catalog") go("source");
    else if (step === "configure") go("catalog");
    else if (step === "review") go("configure");
  }
  function editRejectedConfiguration() {
    if (busyRef.current || createdRef.current || !creationRejected) return;
    // Keep the request ID: if a response was misleading or another request
    // finished late, the host must still reject a duplicate creation.
    setPlan(null);
    setRuntime(null);
    setAccepted(false);
    setAcknowledged(false);
    setCreationRejected(false);
    setConfigurationDetailsOpen(true);
    setStep("configure");
  }
  const configureTitle = kind === "modpack" ? project?.title : provider?.name;
  return (
    <div className="setup-wizard">
      <div className="setup-topbar">
        <span className="setup-brand">
          <Package size={18} /> NEW SERVER
        </span>
        <button
          className="btn icon"
          type="button"
          aria-label="Close add server"
          disabled={busy}
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      <ol className="setup-steps" aria-label="Setup progress">
        {["Choose", "Configure", "Review", "Install"].map((label, index) => (
          <li
            key={label}
            aria-current={displayStep === index ? "step" : undefined}
            className={displayStep >= index ? "reached" : ""}
          >
            <span>{displayStep > index ? <Check size={13} /> : index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <h2 id="add-server-title" ref={heading} tabIndex={-1}>
        {step === "source"
          ? "What would you like to play?"
          : step === "catalog"
            ? configureTitle ||
              (kind === "software"
                ? "Choose server software"
                : "Find your modpack")
            : step === "configure"
              ? "Make it yours"
              : step === "review"
                ? "Ready to create your server?"
                : step === "done"
                  ? "Your server is ready"
                  : "Setting up your server"}
      </h2>
      {
        <p className="setup-host-context">
          Computer: <strong>{remoteHost || "This computer"}</strong>{" "}
          {onChangeHost && !busy && !created && (
            <button type="button" className="btn" onClick={onChangeHost}>
              Change computer
            </button>
          )}
        </p>
      }
      {provider?.kind === "proxy" && (
        <p className="management-notice">
          Velocity is a proxy. Configure its listener port and backend servers
          in velocity.toml before starting; the panel port does not configure
          that listener.
        </p>
      )}
      <p className="setup-intro">
        {step === "source"
          ? "Start with server software or a complete modpack."
          : step === "catalog"
            ? kind === "software"
              ? "The same official releases available in Versions."
              : "Browse Launchpad and choose a release to install."
            : step === "configure"
              ? "Choose a name and how much memory your server can use."
              : step === "review"
                ? "Check your choices. Installation will leave the server stopped."
                : step === "done"
                  ? "Open Console and press Start when you’re ready to play."
                  : "You can follow installation progress here."}
      </p>

      {step === "source" && (
        <>
          <div className="setup-source-choices">
            <button
              className="setup-source-card"
              onClick={() => chooseKind("software")}
              aria-label="Server software"
            >
              <Layers3 size={29} />
              <strong>Server software</strong>
              <span>Vanilla, Paper, NeoForge, Fabric, and more.</span>
              <span className="setup-card-action">
                Choose software <ArrowRight size={15} />
              </span>
            </button>
            <button
              className="setup-source-card"
              onClick={() => chooseKind("modpack")}
              aria-label="Modpack"
            >
              <Package size={29} />
              <strong>Modpack</strong>
              <span>A ready-made collection of mods, installed together.</span>
              <span className="setup-card-action">
                Browse Launchpad <ArrowRight size={15} />
              </span>
            </button>
          </div>
        </>
      )}
      {step === "catalog" && (
        <>
          {!catalog && (
            <div className="setup-loading" role="status">
              {catalogError ? (
                <>
                  <AlertCircle size={22} />
                  <p>{catalogError}</p>
                  <button
                    className="btn"
                    onClick={() => setRefresh((value) => value + 1)}
                  >
                    Retry catalog
                  </button>
                </>
              ) : (
                <>
                  <LoaderCircle size={23} className="spin" /> Loading catalogs…
                </>
              )}
            </div>
          )}
          {catalog && kind === "software" && !provider && (
            <>
              <SearchField
                aria-label="Search server software"
                placeholder="Search server software…"
                value={search}
                onValueChange={setSearch}
              />
              <div className="setup-software-grid">
                {catalog.providers
                  .filter((item) =>
                    `${item.name} ${item.description}`
                      .toLowerCase()
                      .includes(softwareQuery.toLowerCase()),
                  )
                  .map((item) => (
                    <article key={item.id} className="setup-software-card">
                      <span className="version-provider-mark">
                        <SoftwareIcon software={item.id} />
                      </span>
                      <div>
                        <strong>{item.name}</strong>
                        <p>{item.description}</p>
                        {item.installable ? (
                          <button
                            className="btn"
                            aria-label={`Choose ${item.name}`}
                            onClick={() => setProvider(item)}
                          >
                            Choose <ChevronRight size={14} />
                          </button>
                        ) : (
                          <a
                            className="btn"
                            href={item.website}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Official downloads <ExternalLink size={12} />
                          </a>
                        )}
                      </div>
                    </article>
                  ))}
              </div>
              {!catalog.providers.some((item) =>
                `${item.name} ${item.description}`
                  .toLowerCase()
                  .includes(softwareQuery.toLowerCase()),
              ) && (
                <p className="setup-empty">No software matches your search.</p>
              )}
            </>
          )}
          {kind === "software" && provider && (
            <div className="setup-selection-panel">
              <div className="setup-selected">
                <span className="version-provider-mark">
                  <SoftwareIcon software={provider.id} />
                </span>
                <div>
                  <strong>{provider.name}</strong>
                  <p>{provider.description}</p>
                </div>
              </div>
              <div className="setup-field-grid">
                <label className="form-field">
                  {provider.kind === "proxy"
                    ? "Proxy version"
                    : "Minecraft version"}
                  <select
                    value={gameVersion}
                    disabled={!releases.length || loading}
                    onChange={(event) => setGameVersion(event.target.value)}
                  >
                    <option value="" disabled>
                      Select version
                    </option>
                    {releases
                      .filter((item) => item.stable || experimental)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="form-field">
                  Build
                  <select
                    value={buildId}
                    disabled={loading || !builds.length}
                    onChange={(event) => setBuildId(event.target.value)}
                  >
                    <option value="" disabled>
                      Select build
                    </option>
                    {builds
                      .filter((item) => item.stable || experimental)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                          {item.recommended ? " (recommended)" : ""}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <label className="setup-check">
                <input
                  type="checkbox"
                  checked={experimental}
                  onChange={(event) => {
                    setExperimental(event.target.checked);
                    if (
                      !event.target.checked &&
                      releases.find((item) => item.id === gameVersion)
                        ?.stable === false
                    )
                      setGameVersion(
                        releases.find((item) => item.stable)?.id || "",
                      );
                    if (!event.target.checked && !build?.stable) setBuildId("");
                  }}
                />{" "}
                Include experimental releases
              </label>
            </div>
          )}
          {catalog && kind === "modpack" && !project && (
            <>
              <div className="setup-catalog-toolbar">
                <label className="form-field">
                  Platform
                  <select
                    value={platform}
                    onChange={(event) => {
                      setPlatform(event.target.value);
                      setOffset(0);
                      setSort(
                        catalog.platforms.find(
                          (item) => item.id === event.target.value,
                        )?.sortOptions?.[0]?.id || "downloads",
                      );
                    }}
                  >
                    {catalog.platforms
                      .filter((item) => item.types.includes("modpack"))
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                  </select>
                </label>
                <SearchField
                  aria-label="Search modpacks"
                  placeholder="Search modpacks…"
                  value={search}
                  onValueChange={(value) => {
                    setSearch(value);
                    setOffset(0);
                  }}
                />
              </div>
              {source?.requiresKey && !source.keyConfigured ? (
                <div className="setup-key">
                  {remoteHost ? (
                    <p>
                      Ask the owner of {remoteHost} to configure the{" "}
                      {source.name} API key before browsing its modpacks.
                    </p>
                  ) : (
                    <>
                      <p>
                        Enter your {source.name} API key to browse and install
                        its modpacks.
                      </p>
                      <label className="form-field">
                        API key
                        <input
                          type="password"
                          value={apiKey}
                          autoComplete="off"
                          onChange={(event) => setApiKey(event.target.value)}
                        />
                      </label>
                      <button
                        className="btn"
                        onClick={() => void saveKey()}
                        disabled={busy || !apiKey.trim()}
                      >
                        Save key
                      </button>
                    </>
                  )}
                </div>
              ) : !source?.available ? (
                <p className="setup-empty">
                  {source?.reason || "This platform is currently unavailable."}
                </p>
              ) : (
                <>
                  <details className="setup-advanced setup-filters">
                    <summary>Filters and sorting</summary>
                    <div className="setup-field-grid">
                      <label className="form-field">
                        Minecraft version
                        <select
                          value={filterVersion}
                          onChange={(event) => {
                            setFilterVersion(event.target.value);
                            setOffset(0);
                          }}
                        >
                          <option value="">All versions</option>
                          {catalog.gameVersions
                            .filter((value) => /^\d+(?:\.\d+)+$/.test(value))
                            .map((value) => (
                              <option key={value}>{value}</option>
                            ))}
                        </select>
                      </label>
                      <label className="form-field">
                        Loader
                        <select
                          value={filterLoader}
                          onChange={(event) => {
                            setFilterLoader(event.target.value);
                            setOffset(0);
                          }}
                        >
                          <option value="">All loaders</option>
                          {modLoaders.map((value) => (
                            <option key={value} value={value}>
                              {names[value]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="form-field">
                        Sort by
                        <select
                          value={sort}
                          onChange={(event) => {
                            setSort(event.target.value);
                            setOffset(0);
                          }}
                        >
                          {(
                            source.sortOptions || [
                              { id: "downloads", label: "Most downloaded" },
                            ]
                          ).map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </details>
                  <div className="setup-pack-list">
                    {projects.map((item) => (
                      <article className="setup-pack-card" key={item.id}>
                        <ProjectIcon url={item.iconUrl} />
                        <div>
                          <strong>{item.title}</strong>
                          <p>{item.description}</p>
                          <small>
                            {item.author ? `By ${item.author}` : ""}
                            {item.downloads != null
                              ? ` · ${item.downloads.toLocaleString()} downloads`
                              : ""}
                          </small>
                        </div>
                        <button
                          className="btn"
                          aria-label={`Choose ${item.title}`}
                          onClick={() => setProject(item)}
                        >
                          Choose <ChevronRight size={14} />
                        </button>
                      </article>
                    ))}
                  </div>
                  {!loading && !listError && !projects.length && (
                    <p className="setup-empty">
                      No modpacks match. Try another search or platform.
                    </p>
                  )}
                  <div className="setup-pagination">
                    <span>{total.toLocaleString()} modpacks</span>
                    <button
                      className="btn icon"
                      aria-label="Previous modpacks"
                      disabled={loading || !offset}
                      onClick={() =>
                        setOffset((value) => Math.max(0, value - 5))
                      }
                    >
                      <ChevronLeft size={17} />
                    </button>
                    <span>
                      Page {Math.floor(offset / packPageSize) + 1} of{" "}
                      {Math.max(1, Math.ceil(total / packPageSize))}
                    </span>
                    <button
                      className="btn icon"
                      aria-label="Next modpacks"
                      disabled={loading || offset + packPageSize >= total}
                      onClick={() => setOffset((value) => value + 5)}
                    >
                      <ChevronRight size={17} />
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          {kind === "modpack" && project && (
            <div className="setup-selection-panel">
              <div className="setup-selected">
                <ProjectIcon url={project.iconUrl} />
                <div>
                  <strong>{project.title}</strong>
                  <p>{project.description}</p>
                </div>
              </div>
              <label className="form-field">
                Modpack version
                <select
                  value={packVersionId}
                  disabled={loading}
                  onChange={(event) => setPackVersionId(event.target.value)}
                >
                  <option value="" disabled>
                    Select a release
                  </option>
                  {packVersions.map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                      disabled={!item.downloadable}
                    >
                      {item.name}
                      {!item.downloadable ? " — no server download" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {packVersion && (
                <div className="setup-field-grid">
                  <label className="form-field">
                    Minecraft version
                    <select
                      value={gameVersion}
                      onChange={(event) => setGameVersion(event.target.value)}
                    >
                      {packVersion.gameVersions.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label className="form-field">
                    Loader
                    <select
                      value={packLoader}
                      onChange={(event) => setPackLoader(event.target.value)}
                    >
                      <option value="" disabled>
                        Select loader
                      </option>
                      {packVersion.loaders
                        .filter((value) => modLoaders.includes(value))
                        .map((value) => (
                          <option key={value} value={value}>
                            {names[value]}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              )}
              {!loading && !packVersions.some((item) => item.downloadable) && (
                <p className="setup-empty">
                  This project has no supported server download. Choose another
                  modpack.
                </p>
              )}
            </div>
          )}
          {loading && (
            <p className="setup-loading" role="status">
              <LoaderCircle size={18} className="spin" /> Loading releases…
            </p>
          )}
          {listError && (
            <div className="setup-error" role="alert">
              <p>{listError}</p>
              <button
                className="btn"
                onClick={() => setRefresh((value) => value + 1)}
              >
                <RefreshCw size={14} /> Retry catalog
              </button>
            </div>
          )}
        </>
      )}

      {step === "configure" && (
        <form
          id="setup-configure"
          onSubmit={(event) => void review(event)}
          noValidate
        >
          <div className="setup-choice-summary">
            <Check size={18} />
            <span>
              <strong>{title}</strong>
              <small>
                {provider?.kind === "proxy" ? "Proxy" : "Minecraft"}{" "}
                {gameVersion} ·{" "}
                {kind === "software" ? build?.label : packVersion?.name}
              </small>
            </span>
            <button
              className="btn"
              type="button"
              disabled={busy}
              onClick={() => go("catalog")}
            >
              Change
            </button>
          </div>
          <div className="form-field">
            <label htmlFor="setup-name">Server name</label>
            <input
              id="setup-name"
              required
              maxLength={64}
              value={name}
              disabled={busy}
              onChange={(event) => {
                nameEdited.current = true;
                setName(event.target.value);
              }}
              placeholder="Survival with friends"
            />
          </div>
          <div className="form-field">
            <label htmlFor="setup-memory">Memory (GB)</label>
            <div className="setup-memory">
              <input
                aria-label="Memory slider"
                type="range"
                min={1}
                max={Math.max(
                  4,
                  Math.min(
                    64,
                    Math.floor((catalog?.hostMemoryMB || 16384) / 1024),
                  ),
                )}
                step={1}
                value={Number(memory)}
                disabled={busy}
                onChange={(event) => {
                  memoryEdited.current = true;
                  setMemory(event.target.value);
                }}
              />
              <input
                id="setup-memory"
                type="number"
                min={0.25}
                max={256}
                step={0.25}
                required
                value={memory}
                disabled={busy}
                onChange={(event) => {
                  memoryEdited.current = true;
                  setMemory(event.target.value);
                }}
              />
            </div>
            <small>
              {catalog?.runningAllocatedMemoryMB
                ? `${(catalog.runningAllocatedMemoryMB / 1024).toFixed(1)} GB already allocated to running servers. `
                : ""}
              {catalog?.hostMemoryMB
                ? `${(catalog.hostMemoryMB / 1024).toFixed(0)} GB installed on the server PC. `
                : ""}
              Leave memory available for its operating system and other apps.
            </small>
          </div>
          <div className="form-field setup-location-field">
            <label htmlFor="setup-location">Installation location</label>
            <select
              id="setup-location"
              value={customLocation ? "custom" : "default"}
              disabled={busy}
              onChange={(event) => {
                setCustomLocation(event.target.value === "custom");
                setFolderBrowserOpen(false);
              }}
            >
              <option value="default">MC Panel's default server folder</option>
              <option value="custom">Choose a folder or another drive</option>
            </select>
            {customLocation ? (
              <>
                <label htmlFor="setup-directory">Installation folder</label>
                <div className="setup-directory-input">
                  <input
                    id="setup-directory"
                    required
                    value={installationDirectory}
                    disabled={busy}
                    onChange={(event) =>
                      setInstallationDirectory(event.target.value)
                    }
                    placeholder="D:\Minecraft\Survival"
                    aria-describedby="setup-directory-help"
                  />
                  <button
                    ref={browseFolderButton}
                    className="btn"
                    type="button"
                    disabled={busy}
                    onClick={browseInstallationDirectory}
                  >
                    <FolderOpen size={15} /> Browse
                  </button>
                </div>
                {folderBrowserOpen && (
                  <HostDirectoryPicker
                    initialDirectory={installationDirectory}
                    remoteHost={remoteHost}
                    onClose={() => {
                      setFolderBrowserOpen(false);
                      browseFolderButton.current?.focus();
                    }}
                    onSelect={(directory) => {
                      setInstallationDirectory(directory);
                      setFolderBrowserOpen(false);
                      browseFolderButton.current?.focus();
                    }}
                  />
                )}
                <small id="setup-directory-help">
                  Choose an empty folder or enter a new folder path on the
                  computer running MC Panel. Server files and worlds go here.
                  Downloads, backups, and support files use a .mc-panel folder
                  beside it on the same drive.
                </small>
              </>
            ) : (
              <small>
                {catalog?.managedServersDir || "MC Panel's server data folder"}
              </small>
            )}
          </div>
          <div className="form-field setup-java-field">
            <div className="setup-java-header">
              <label htmlFor="setup-java">Java executable</label>
              <button
                className="btn"
                type="button"
                disabled={busy || javaLoading}
                onClick={() => setJavaRefresh((value) => value + 1)}
              >
                <RefreshCw size={14} className={javaLoading ? "spin" : ""} />
                Refresh Java
              </button>
            </div>
            <select
              id="setup-java"
              value={selectedJava?.majorVersion ?? ""}
              disabled={
                busy || javaLoading || !javaChoices?.installations.length
              }
              required
              onChange={(event) => setJavaMajor(Number(event.target.value))}
              aria-describedby="setup-java-help"
            >
              <option value="" disabled>
                {javaLoading
                  ? "Finding installed Java versions…"
                  : "No compatible Java installation found"}
              </option>
              {javaChoices?.installations.map((item) => (
                <option key={item.majorVersion} value={item.majorVersion}>
                  Java {item.majorVersion}
                </option>
              ))}
            </select>
            <label>
              <input
                type="checkbox"
                checked={customJava}
                disabled={busy}
                onChange={(event) => {
                  setCustomJava(event.target.checked);
                  setAcknowledgedJavaCompatibility(false);
                }}
              />{" "}
              Choose a specific Java installation
            </label>
            {customJava && (
              <>
                <JavaExecutableField
                  id="setup-custom-java"
                  value={customJavaPath}
                  onChange={(value) => {
                    setCustomJavaPath(value);
                    setAcknowledgedJavaCompatibility(false);
                  }}
                />
                <label>
                  <input
                    type="checkbox"
                    checked={acknowledgedJavaCompatibility}
                    disabled={busy}
                    onChange={(event) =>
                      setAcknowledgedJavaCompatibility(event.target.checked)
                    }
                  />{" "}
                  Allow a newer Java runtime after checking compatibility
                </label>
                <small>
                  Some older loaders require the exact Java version. The host
                  still verifies that this executable can start.
                </small>
              </>
            )}
            <small id="setup-java-help">
              {javaLoading
                ? "Checking Java installations on the computer running MC Panel."
                : javaError
                  ? javaError
                  : javaChoices?.installations.length
                    ? javaChoices.requirement
                    : canInstallJava
                      ? `${javaChoices.requirement} is needed for this Minecraft version.`
                      : `${javaChoices?.requirement || "A compatible Java runtime is required."} Install it on the server PC, then select Refresh Java.`}
            </small>
            {!javaLoading && !selectedJava && canInstallJava && (
              <div className="setup-java-install">
                <button
                  className="btn primary"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void installJava(
                      javaInstallJob &&
                        ["queued", "running"].includes(javaInstallJob.status)
                        ? javaInstallJob
                        : undefined,
                    )
                  }
                >
                  {busy ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Download size={15} />
                  )}
                  {busy
                    ? "Installing Java…"
                    : `Install Java ${javaChoices.requiredJavaVersion}`}
                </button>
                <small>
                  Downloads Eclipse Temurin for MC Panel. No administrator
                  access needed. Shared Java installs use{" "}
                  {catalog?.managedJavaDirectory ||
                    "MC Panel's app data folder"}
                  , even when the server is on another drive.
                </small>
              </div>
            )}
            {!selectedJava && javaChoices?.installMessage && (
              <small>{javaChoices.installMessage}</small>
            )}
            {javaInstallJob && (
              <div
                className="setup-java-progress"
                role="status"
                aria-live="polite"
              >
                <span>{javaInstallJob.message}</span>
                {javaInstallJob.status === "running" &&
                  javaInstallJob.totalBytes && (
                    <>
                      <progress
                        value={javaInstallJob.downloadedBytes}
                        max={javaInstallJob.totalBytes}
                        aria-label="Java download progress"
                      />
                      <small>
                        {formatBytes(javaInstallJob.downloadedBytes)} /{" "}
                        {formatBytes(javaInstallJob.totalBytes)}
                      </small>
                    </>
                  )}
              </div>
            )}
            {javaInstallError && <small role="alert">{javaInstallError}</small>}
            {javaChoices?.warnings.map((warning) => (
              <small key={warning}>{warning}</small>
            ))}
          </div>
          <details
            className="setup-advanced"
            open={configurationDetailsOpen}
            onToggle={(event) =>
              setConfigurationDetailsOpen(event.currentTarget.open)
            }
          >
            <summary>
              <Settings2 size={14} /> Advanced settings
            </summary>
            <div className="setup-field-grid">
              <label className="form-field">
                {provider?.kind === "proxy"
                  ? "Panel connection port"
                  : "Server port"}
                <input
                  id="setup-port"
                  type="number"
                  min={1024}
                  max={65535}
                  value={port}
                  disabled={busy}
                  onChange={(event) => {
                    portEdited.current = true;
                    setPort(event.target.value);
                  }}
                />
              </label>
            </div>
          </details>
        </form>
      )}
      {step === "review" && (
        <>
          {provider?.kind !== "proxy" && (
            <p className="setup-warning">
              New servers start with the whitelist off. Anyone who can reach the
              server can join. After setup, use Players to add allowed players
              and enable the whitelist before sharing the address.
            </p>
          )}
          <dl className="setup-review">
            <div>
              <dt>Server</dt>
              <dd>{name}</dd>
            </div>
            <div>
              <dt>{kind === "modpack" ? "Modpack" : "Software"}</dt>
              <dd>
                {title}
                {kind === "modpack" ? ` · ${packVersion?.name}` : ""}
              </dd>
            </div>
            <div>
              <dt>
                {provider?.kind === "proxy" ? "Proxy version" : "Minecraft"}
              </dt>
              <dd>{gameVersion}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd>{runtime?.label}</dd>
            </div>
            <div>
              <dt>Memory</dt>
              <dd>{memory} GB</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>
                {(customLocation
                  ? installationDirectory
                  : catalog?.managedServersDir) ||
                  "A new folder in MC Panel’s server data"}
              </dd>
            </div>
            {customLocation && supportDirectory && (
              <div>
                <dt>Downloads, backups, and support files</dt>
                <dd>
                  {supportDirectory} (a separate subfolder for this server)
                </dd>
              </div>
            )}
          </dl>
          {warnings.map((value) => (
            <p className="setup-warning" key={value}>
              {value}
            </p>
          ))}
          {Boolean(plan?.warnings?.length) && (
            <details className="setup-advanced">
              <summary>Installation notes ({plan!.warnings.length})</summary>
              <ul>
                {plan!.warnings.map((value, index) => (
                  <li key={index}>{value}</li>
                ))}
              </ul>
            </details>
          )}
          {Boolean(plan?.unavailableDependencies?.length) && (
            <div className="setup-warning">
              <strong>Some requirements couldn’t be checked</strong>
              <p>The catalog could not verify every required download.</p>
              <ul>
                {plan!.unavailableDependencies!.map((item, index) => (
                  <li key={index}>
                    {item.issue ||
                      `${item.platform} project ${item.projectId || item.versionId}`}
                  </li>
                ))}
              </ul>
              <label className="setup-check">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />{" "}
                I will manage these unavailable requirements myself
              </label>
            </div>
          )}
          {(kind !== "software" || provider?.kind !== "proxy") && (
            <label className="setup-check setup-eula">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />{" "}
              <span>
                I agree to the{" "}
                <a
                  href="https://aka.ms/MinecraftEULA"
                  target="_blank"
                  rel="noreferrer"
                >
                  Minecraft EULA <ExternalLink size={12} />
                </a>
              </span>
            </label>
          )}
        </>
      )}
      {step === "install" && (
        <div className="setup-install-progress" role="status">
          {busy ? (
            <LoaderCircle size={38} className="spin" />
          ) : (
            <AlertCircle size={38} />
          )}
          <strong>{busy ? progress : "Setup needs attention"}</strong>
          <p>
            {busy
              ? "Keep MC Panel open while the downloads are verified and installed."
              : created
                ? "Your server folder and setup draft are saved on this device for seven days. Retry now, or use Finish setup in Add server to continue later."
                : creationRejected
                  ? "Your server wasn’t created. Go back to correct your settings; your selections are saved."
                  : "We couldn’t confirm server creation. Retry to continue without creating a duplicate."}
          </p>
          {busy && (
            <progress
              aria-label="Installation progress"
              max={Math.max(1, jobProgress?.total ?? 0)}
              value={
                jobProgress?.total ? (jobProgress.completed ?? 0) : undefined
              }
            />
          )}
          {busy && onBackground && (
            <button className="btn" type="button" onClick={onBackground}>
              Continue in background
            </button>
          )}
          {busy && jobProgress?.cancellable && (
            <button
              className="btn danger"
              type="button"
              disabled={cancelling}
              onClick={() => void cancelInstallation()}
            >
              {cancelling ? "Cancelling…" : "Cancel installation"}
            </button>
          )}
        </div>
      )}
      {step === "done" && (
        <div className="setup-complete">
          <span>
            <Check size={36} />
          </span>
          <strong>{name}</strong>
          <p>
            {title} · {provider?.kind === "proxy" ? "Proxy" : "Minecraft"}{" "}
            {gameVersion} · {memory} GB
          </p>
          <small>Installed and stopped</small>
        </div>
      )}
      {busy && step === "configure" && (
        <p className="setup-loading" role="status">
          <LoaderCircle size={18} className="spin" /> {progress}
        </p>
      )}
      {draftError && (
        <p className="setup-error" role="alert">
          {draftError}
        </p>
      )}
      {error && (
        <div className="setup-error" role="alert">
          <AlertCircle size={17} />
          <p>{error}</p>
        </div>
      )}
      <div className="setup-actions">
        {step === "install" && !busy && !created && creationRejected ? (
          <button className="btn" onClick={editRejectedConfiguration}>
            <ArrowLeft size={15} /> Back to configuration
          </button>
        ) : step !== "done" && step !== "install" && !created ? (
          <button className="btn" onClick={back} disabled={busy}>
            <ArrowLeft size={15} /> Back
          </button>
        ) : (
          <span />
        )}
        {step === "catalog" && (provider || project) && (
          <button
            className="btn primary"
            onClick={configure}
            disabled={!isPrepared || loading || !!listError}
          >
            Continue <ArrowRight size={15} />
          </button>
        )}
        {step === "configure" && (
          <button
            className="btn primary"
            type="submit"
            form="setup-configure"
            disabled={busy || javaLoading || !selectedJava || folderBrowserOpen}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <ArrowRight size={15} />
            )}{" "}
            Review installation
          </button>
        )}
        {step === "review" && (
          <button
            className="btn primary"
            onClick={() => void install()}
            disabled={
              busy ||
              ((kind !== "software" || provider?.kind !== "proxy") &&
                !accepted) ||
              Boolean(plan?.unavailableDependencies?.length && !acknowledged)
            }
          >
            <Download size={15} />
            {created ? "Confirm installation" : "Create and install"}
          </button>
        )}
        {step === "install" && !busy && (
          <div className="setup-recovery-actions">
            {created && (
              <button className="btn" onClick={() => void openConsole()}>
                Finish later
              </button>
            )}
            <button className="btn primary" onClick={() => void install()}>
              <RefreshCw size={15} /> Retry installation
            </button>
          </div>
        )}
        {step === "done" && created && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => void openConsole()}
          >
            <Terminal size={16} /> Open Console <ArrowRight size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
