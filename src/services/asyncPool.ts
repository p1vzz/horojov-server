export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>
) {
  if (items.length === 0) return;

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: safeConcurrency }, async () => {
      while (true) {
        const nextIndex = cursor;
        cursor += 1;
        if (nextIndex >= items.length) return;
        await worker(items[nextIndex]!, nextIndex);
      }
    })
  );
}
