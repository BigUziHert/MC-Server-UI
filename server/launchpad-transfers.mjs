// Stage several independent files at once, but always drain every worker before
// a caller retries or removes staging. A failure stops queued work; in-flight
// downloads can finish so a retry reuses them. Caller cancellation stops all IO.
export async function parallelTransfers(items, work, signal, concurrency = 4) {
  signal?.throwIfAborted();
  const combined = signal ?? new AbortController().signal;
  let next = 0,
    failure;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length && !combined.aborted && !failure) {
        const index = next++;
        try {
          await work(items[index], index, combined);
        } catch (cause) {
          if (!failure) {
            failure = cause;
          }
        }
      }
    }),
  );
  if (failure) throw failure;
  combined.throwIfAborted();
}
