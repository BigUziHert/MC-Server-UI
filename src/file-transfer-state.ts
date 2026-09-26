import { useSyncExternalStore } from "react";
import { messageOf, type PageProps, type useServerApi } from "./api";

type Api = ReturnType<typeof useServerApi>["api"];
export type Transfer = {
  id: string;
  kind: "copy" | "upload";
  destination: string;
  serverName: string;
  status: "running" | "completed" | "failed" | "unconfirmed";
  message: string;
  completedFiles: number;
  totalFiles: number | null;
  completedBytes: number;
  totalBytes: number | null;
};
type Report = (update: Partial<Transfer>) => void;
const transfers = new Map<string, Transfer>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const emit = () => listeners.forEach((listener) => listener());

export function useFileTransfer(key: string) {
  return useSyncExternalStore(subscribe, () => transfers.get(key) ?? null);
}
export function dismissFileTransfer(key: string) {
  if (transfers.get(key)?.status === "running") return;
  transfers.delete(key);
  emit();
}
export function startFileTransfer(
  key: string,
  initial: Pick<Transfer, "kind" | "destination" | "serverName">,
  work: (report: Report, id: string) => Promise<string>,
  notify: PageProps["notify"],
) {
  if (transfers.get(key)?.status === "running") return false;
  const id = crypto.randomUUID();
  const report: Report = (update) => {
    const current = transfers.get(key);
    if (current?.id !== id) return;
    transfers.set(key, { ...current, ...update });
    emit();
  };
  transfers.set(key, {
    ...initial,
    id,
    status: "running",
    message: "Preparing files…",
    completedFiles: 0,
    totalFiles: null,
    completedBytes: 0,
    totalBytes: null,
  });
  emit();
  void work(report, id)
    .then((message) => {
      report({ status: "completed", message });
      notify(`${initial.serverName}: ${message}`);
    })
    .catch((cause) => {
      const message = messageOf(cause);
      report({
        status: cause instanceof UnconfirmedTransfer ? "unconfirmed" : "failed",
        message,
      });
      notify(`${initial.serverName}: ${message}`, true);
    });
  return true;
}

type CopyResult = {
  copiedFiles: number;
  copiedDirectories: number;
  paths: string[];
};
type CopyOperation = {
  id: string;
  status: "running" | "completed" | "failed";
  phase: "scanning" | "copying" | "completed" | "failed";
  filesProcessed: number;
  totalFiles: number | null;
  bytesProcessed: number;
  totalBytes: number | null;
  error?: string;
  result?: CopyResult;
};
export class UnconfirmedTransfer extends Error {}
export async function pasteFiles(
  api: Api,
  body: { sourceServerId: string; paths: string[]; destinationPath: string },
  report: Report,
  requestId: string,
) {
  const completeMessage = (result: CopyResult) =>
    `${result.copiedFiles} ${result.copiedFiles === 1 ? "file" : "files"} and ${result.copiedDirectories} ${result.copiedDirectories === 1 ? "folder" : "folders"} copied to /${body.destinationPath || "server"}.`;
  const partialFailure = (cause: Error, result?: Partial<CopyResult>) => {
    if (result?.copiedFiles || result?.copiedDirectories) {
      report({ completedFiles: result.copiedFiles ?? 0 });
      return new Error(
        `${cause.message} ${result.copiedFiles ?? 0} files and ${result.copiedDirectories ?? 0} folders were copied before the operation stopped.`,
      );
    }
    return cause;
  };
  const result = await new Promise<CopyResult>((resolve, reject) => {
    let finished = false;
    let unconfirmed = false;
    let unavailable = 0;
    let timer: ReturnType<typeof setTimeout>;
    const done = (result?: CopyResult, cause?: Error) => {
      if (finished) {
        if (unconfirmed && result && !cause) {
          unconfirmed = false;
          report({
            status: "completed",
            message: completeMessage(result),
            completedFiles: result.copiedFiles,
          });
        } else if (
          unconfirmed &&
          cause &&
          !(cause instanceof UnconfirmedTransfer)
        ) {
          unconfirmed = false;
          report({ status: "failed", message: cause.message });
        }
        return;
      }
      finished = true;
      unconfirmed = cause instanceof UnconfirmedTransfer;
      clearTimeout(timer);
      if (cause) reject(cause);
      else resolve(result!);
    };
    const uncertain = () =>
      done(
        undefined,
        new UnconfirmedTransfer(
          "The copy's outcome could not be confirmed. It may still finish on the server. Check the destination before pasting again; the request was not retried.",
        ),
      );
    const poll = async () => {
      try {
        const { operation } = await api<{ operation: CopyOperation | null }>(
          `/files/copy-operation?requestId=${encodeURIComponent(requestId)}`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (finished) return;
        if (operation?.id === requestId) {
          unavailable = 0;
          report({
            message:
              operation.phase === "scanning"
                ? "Scanning files…"
                : "Copying files…",
            completedFiles: operation.filesProcessed,
            totalFiles: operation.totalFiles,
            completedBytes: operation.bytesProcessed,
            totalBytes: operation.totalBytes,
          });
          if (operation.status === "completed" && operation.result)
            done(operation.result);
          if (operation.status === "failed")
            done(
              undefined,
              partialFailure(
                new Error(
                  operation.error ||
                    "The copy could not finish. Check the destination for copied files.",
                ),
                operation.result,
              ),
            );
        } else unavailable++;
      } catch (cause) {
        unavailable++;
        const status = (cause as { status?: number }).status;
        if (status === 401 || status === 403) {
          uncertain();
          return;
        }
      } finally {
        if (!finished && unavailable >= 5) uncertain();
        if (!finished) timer = setTimeout(poll, 1000);
      }
    };
    timer = setTimeout(poll, 100);
    void api<CopyResult>("/files/copy", {
      method: "POST",
      body: JSON.stringify({ ...body, requestId }),
    })
      .then((value) => done(value))
      .catch((cause) => {
        if (cause?.status >= 400 && cause.status < 500)
          done(undefined, partialFailure(cause, cause));
        else {
          if (finished) return;
          report({
            message:
              "Connection interrupted. Checking the original copy's status…",
          });
        }
      });
  });
  return completeMessage(result);
}
