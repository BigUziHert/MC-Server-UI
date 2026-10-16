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

// Reviews expose ordered plans and errors. Drain started operations before a
// rejected review removes its stage, retaining the earliest input's error even
// when a later operation happens to fail first.
export async function mapReview(items, work, signal, concurrency = 4) {
  signal?.throwIfAborted();
  const results = new Array(items.length),
    failures = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length && !signal?.aborted && !failures.length) {
        const index = next++;
        try {
          results[index] = await work(items[index], index);
        } catch (cause) {
          failures.push({ index, cause });
        }
      }
    }),
  );
  signal?.throwIfAborted();
  if (failures.length)
    throw failures.sort((a, b) => a.index - b.index)[0].cause;
  return results;
}
