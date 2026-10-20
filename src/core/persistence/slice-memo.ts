/**
 * GBRA-108: the legacy sweep screens a slice of pages through one reads view (`sliceReads`, import-reads.ts). The checks
 * every preparation of the slice repeats with the same inputs (the owner binding, the configured root, the content-sanity
 * config lift) are answered once per view. Any other engine is not a slice view, so its callers read every time.
 */
const slices = new WeakMap<object, Map<string, Promise<unknown>>>();

export function registerSliceView<T extends object>(view: T): T {
  slices.set(view, new Map());
  return view;
}

export function sliceMemo<T>(view: object, key: string, read: () => Promise<T>): Promise<T> {
  const memo = slices.get(view);
  if (!memo) return read();
  const hit = memo.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const value = read();
  memo.set(key, value);
  // A failed check is not shared: the next preparation of the slice runs it again.
  value.catch(() => memo.delete(key));
  return value;
}
