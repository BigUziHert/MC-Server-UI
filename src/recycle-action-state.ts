import { useSyncExternalStore } from "react";
import { messageOf, type PageProps, type useServerApi } from "./api";

export type RecoveryItem = {
  id: string;
  name: string;
  originalPath: string;
  kind?: "backup";
  type: "file" | "directory";
  size: number;
  deletedAt: string;
  status: "ready" | "incomplete";
  message?: string;
};
export type RecoveryOperation = {
  id: string;
  itemId: string;
  type: "restore" | "delete";
  item?: RecoveryItem;
  status: "running" | "completed" | "failed";
  phase: string;
  filesProcessed: number;
  totalFiles: number | null;
  bytesProcessed: number;
  totalBytes: number | null;
  error?: string;
};
export type RecoveryBatch = {
  id: string;
  type: "restore" | "delete";
  targets: RecoveryItem[];
  completed: string[];
  failures: { item: RecoveryItem; message: string }[];
  currentItemId: string | null;
  operation: RecoveryOperation | null;
  running: boolean;
  checking: boolean;
  unconfirmed: { item: RecoveryItem; requestId: string } | null;
  message: string;
  single: boolean;
};
type Api = ReturnType<typeof useServerApi>["api"];
const batches = new Map<string, RecoveryBatch>();
const listeners = new Set<() => void>();
const transports = new Map<string, Set<AbortController>>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useRecoveryBatch = (key: string) =>
  useSyncExternalStore(subscribe, () => batches.get(key) ?? null);
export const recoveryPending = (batch: RecoveryBatch | null | undefined) =>
  !!(batch?.running || batch?.checking || batch?.unconfirmed);
function update(key: string, id: string, value: Partial<RecoveryBatch>) {
  const batch = batches.get(key);
  if (batch?.id !== id) return;
  batches.set(key, { ...batch, ...value });
  emit();
}
class UnconfirmedRecovery extends Error {}
const uncertainMessage =
  "The outcome could not be confirmed. This operation may still finish on the server. No request was retried; remaining items were not sent. Check the status or inspect Recycle Bin and the original location before trying again.";
export function recoverySummary(batch: RecoveryBatch) {
  if (batch.unconfirmed) return uncertainMessage;
  if (
    batch.single &&
    batch.type === "restore" &&
    batch.completed.length === 1 &&
    !batch.failures.length
  ) {
    const item = batch.targets[0];
    return item.kind === "backup"
      ? `${item.name} restored to Backups.`
      : `${item.name} restored to /${item.originalPath}.`;
  }
  const count = batch.completed.length;
  const backups =
    batch.type === "restore" &&
    batch.targets.some(
      (item) => item.kind === "backup" && batch.completed.includes(item.id),
    );
  const unsent = batch.targets.length - count - batch.failures.length;
  return `${count} ${count === 1 ? "item" : "items"} ${batch.type === "restore" ? "restored" : "permanently deleted"}.${backups ? " Restored archives are available in Backups." : ""}${batch.failures.length ? ` ${batch.failures.length} ${batch.failures.length === 1 ? "item failed and remains" : "items failed and remain"} selected.` : ""}${unsent ? ` ${unsent} remaining ${unsent === 1 ? "item was" : "items were"} not sent.` : ""}`;
}

// Request and status observation outlive the mounted page, but every update is
// bound to the original server, batch and request. Closing never replays a write.
function observe(
  api: Api,
  key: string,
  batchId: string,
  item: RecoveryItem,
  requestId: string,
  type: RecoveryBatch["type"],
  send: boolean,
  onLate: (failure?: Error) => void,
) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let uncertain = false;
    let requestPending = send;
    let unavailable = 0;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    if (!transports.has(batchId)) transports.set(batchId, new Set());
    transports.get(batchId)!.add(controller);
    const active = () =>
      batches.get(key)?.id === batchId && !controller.signal.aborted;
    const release = () => {
      const set = transports.get(batchId);
      set?.delete(controller);
      if (!set?.size) transports.delete(batchId);
    };
    const finish = (failure?: Error) => {
      if (settled) {
        if (
          uncertain &&
          active() &&
          !(failure instanceof UnconfirmedRecovery)
        ) {
          uncertain = false;
          onLate(failure);
        }
        return;
      }
      settled = true;
      uncertain = failure instanceof UnconfirmedRecovery;
      clearTimeout(timer);
      if (!requestPending) release();
      failure ? reject(failure) : resolve();
    };
    const unknown = () => finish(new UnconfirmedRecovery(uncertainMessage));
    const poll = async () => {
      if (!active()) {
        unknown();
        return;
      }
      try {
        const { operation } = await api<{
          operation: RecoveryOperation | null;
        }>(
          `/files/recycle-bin/operation?requestId=${encodeURIComponent(requestId)}`,
          {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(5000),
            ]),
          },
        );
        if (settled || !active()) return;
        if (
          operation?.id === requestId &&
          operation.itemId === item.id &&
          operation.type === type
        ) {
          unavailable = 0;
          update(key, batchId, { operation, message: "" });
          if (operation.status === "completed") finish();
          if (operation.status === "failed")
            finish(
              new Error(
                operation.error || "The recovery action could not finish.",
              ),
            );
        } else unavailable++;
      } catch (cause) {
        if (settled || !active()) return;
        unavailable++;
        const status = (cause as { status?: number }).status;
        if (status === 401 || status === 403) {
          unknown();
          return;
        }
        update(key, batchId, {
          message:
            "Connection interrupted. Checking the original operation; it has not been retried.",
        });
      } finally {
        if (
          !settled &&
          unavailable >= 5 &&
          (!requestPending || Date.now() - started >= 30000)
        )
          unknown();
        if (!settled) timer = setTimeout(poll, 1000);
      }
    };
    timer = setTimeout(poll, 100);
    if (!send) return;
    const base = `/files/recycle-bin/${encodeURIComponent(item.id)}`;
    void api(
      type === "restore"
        ? `${base}/restore`
        : `${base}?requestId=${encodeURIComponent(requestId)}`,
      {
        method: type === "restore" ? "POST" : "DELETE",
        ...(type === "restore" ? { body: JSON.stringify({ requestId }) } : {}),
        signal: controller.signal,
      },
    )
      .then(() => {
        requestPending = false;
        if (active()) finish();
      })
      .catch((cause) => {
        requestPending = false;
        if (!active()) return;
        if (cause?.status === 401 || cause?.status === 403) {
          unknown();
        } else if (cause?.status >= 400 && cause.status < 500) finish(cause);
        else if (!settled)
          update(key, batchId, {
            message:
              "The response was interrupted. Checking the original operation; it has not been retried.",
          });
      })
      .finally(() => {
        // Keep an uncertain pending request observable until it actually returns.
        if (settled) release();
      });
  });
}
function resolveUnconfirmed(
  key: string,
  batchId: string,
  requestId: string,
  notify: PageProps["notify"],
  failure?: Error,
) {
  const batch = batches.get(key);
  if (batch?.id !== batchId || batch.unconfirmed?.requestId !== requestId)
    return;
  const item = batch.unconfirmed.item;
  update(key, batchId, {
    running: false,
    checking: false,
    unconfirmed: null,
    currentItemId: null,
    message: "",
    completed: failure ? batch.completed : [...batch.completed, item.id],
    failures: failure
      ? [...batch.failures, { item, message: failure.message }]
      : batch.failures,
  });
  notify(recoverySummary(batches.get(key)!), !!failure);
}
export function startRecoveryBatch(
  api: Api,
  key: string,
  type: RecoveryBatch["type"],
  targets: RecoveryItem[],
  notify: PageProps["notify"],
  options: { single?: boolean; existing?: RecoveryOperation } = {},
) {
  if (!targets.length || recoveryPending(batches.get(key))) return null;
  const id = crypto.randomUUID();
  batches.set(key, {
    id,
    type,
    targets: [...targets],
    completed: [],
    failures: [],
    currentItemId: targets[0].id,
    operation: options.existing || null,
    running: true,
    checking: false,
    unconfirmed: null,
    message: "",
    single: !!options.single,
  });
  emit();
  void (async () => {
    for (const item of targets) {
      if (batches.get(key)?.id !== id) return;
      const requestId = options.existing?.id || crypto.randomUUID();
      update(key, id, {
        currentItemId: item.id,
        operation: options.existing || null,
        message: "",
      });
      try {
        await observe(
          api,
          key,
          id,
          item,
          requestId,
          type,
          !options.existing,
          (failure) => resolveUnconfirmed(key, id, requestId, notify, failure),
        );
        const batch = batches.get(key);
        if (batch?.id !== id) return;
        update(key, id, { completed: [...batch.completed, item.id] });
      } catch (cause) {
        const batch = batches.get(key);
        if (batch?.id !== id) return;
        if (cause instanceof UnconfirmedRecovery) {
          update(key, id, {
            unconfirmed: { item, requestId },
            message: uncertainMessage,
          });
          break;
        }
        update(key, id, {
          failures: [...batch.failures, { item, message: messageOf(cause) }],
        });
      }
    }
    const batch = batches.get(key);
    if (batch?.id !== id) return;
    update(key, id, { running: false, currentItemId: null });
    notify(
      recoverySummary(batches.get(key)!),
      !!batch.unconfirmed || batch.failures.length > 0,
    );
  })();
  return id;
}
export function checkRecoveryStatus(
  api: Api,
  key: string,
  notify: PageProps["notify"],
) {
  const batch = batches.get(key);
  if (!batch?.unconfirmed || batch.running || batch.checking) return;
  const { item, requestId } = batch.unconfirmed;
  update(key, batch.id, {
    checking: true,
    message: "Checking the original operation…",
  });
  void observe(api, key, batch.id, item, requestId, batch.type, false, () => {})
    .then(() => resolveUnconfirmed(key, batch.id, requestId, notify))
    .catch((cause) => {
      if (cause instanceof UnconfirmedRecovery)
        update(key, batch.id, { checking: false, message: uncertainMessage });
      else resolveUnconfirmed(key, batch.id, requestId, notify, cause);
    });
}
export function dismissRecoveryBatch(key: string) {
  const batch = batches.get(key);
  if (!batch || batch.running || batch.checking) return;
  batches.delete(key);
  transports.get(batch.id)?.forEach((controller) => controller.abort());
  transports.delete(batch.id);
  emit();
}
