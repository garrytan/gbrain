/**
 * The census comparison normaliser: masks what is expected to differ between two brains seeded from the same
 * fixture (clocks, ids, uuids, temp paths, engine names) so the rest compares value for value. Pure: no I/O, no
 * engine. census.ts imports it; test/rust-census-normalize.test.ts pins it.
 */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const TIMESTAMP_KEY = /(^|_)(created_at|updated_at|updated_at_iso|deleted_at|snapshot_at|ingested_at|embedded_at|last_written_at|last_sync_at|last_checked|first_seen|at|ts|time|timestamp|started_at|finished_at|generated_at|now)$/;
const CLOCK_KEY = /(^|_)(latency_ms|duration_ms|durationMs|elapsedMs|duration_s|elapsed_ms|took_ms|days_since_effective|ms|uptime_s|age_s|age_ms|pid)$/;
// A serve PID inside notice text, in exactly the two forms a readiness notice prints: `kill <n>` and `PID <n>`.
// Each arm runs its own serve, so the number differs like a `pid` key does; any other number in text still compares.
const SERVE_PID_TEXT = /\b(kill|PID) \d+\b/g;
const ENGINE_NAME = /^(rust|pglite|postgres)$/;
const ID_KEY = /^(id|page_id|event_page_id|chunk_id|fact_id|version_id|job_id)$/;

// An opaque cursor: optional `<tag>.` prefix (`lk1.`, `gpw1.`), then base64 or base64url text that decodes to a
// JSON object or array. Decoded, normalised (so the clocks inside are masked) and compared by content; the cursor
// format itself is untouched. Anything that does not decode to JSON stays a plain string.
const CURSOR = /^([a-z][a-z0-9]{0,7}\.)?([A-Za-z0-9_+/-]{8,}={0,2})$/;

function decodeCursor(value: string): { prefix: string; body: unknown } | null {
  const m = CURSOR.exec(value);
  if (!m) return null;
  const text = Buffer.from(m[2]!, 'base64url').toString('utf8');
  if (!/^[[{]/.test(text)) return null;
  try { return { prefix: m[1] ?? '', body: JSON.parse(text) }; } catch { return null; }
}

export function normalize(value: unknown, paths: Array<[string, string]>, key = ''): unknown {
  if (value === null || value === undefined) return value === null ? null : '<undefined>';
  if (typeof value === 'string') {
    const cursor = decodeCursor(value);
    if (cursor) return `<cursor ${cursor.prefix}${JSON.stringify(normalize(cursor.body, paths))}>`;
    if (TIMESTAMP_KEY.test(key) || INSTANT.test(value)) return '<timestamp>';
    if (/engine/i.test(key) && ENGINE_NAME.test(value)) return '<engine>';
    let s = paths.reduce((text, [path, mark]) => text.split(path).join(mark), value);
    s = s.replace(/\b(engine:\s*)(rust|pglite|postgres)\b/g, '$1<engine>');
    s = s.replace(UUID, '<uuid>').replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<timestamp>').replace(/\b\d+(\.\d+)?\s?ms\b/g, '<n>ms').replace(SERVE_PID_TEXT, '$1 <pid>');
    return s;
  }
  if (typeof value === 'number') {
    if (ID_KEY.test(key)) return '<id>';
    if (CLOCK_KEY.test(key)) return '<clock>';
    return Number.isInteger(value) ? value : Math.round(value * 1e5) / 1e5;
  }
  if (Array.isArray(value)) return value.map((v) => normalize(v, paths, key));
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    // engine names are expected to differ; compare everything else
    return Object.fromEntries(Object.keys(o).sort().filter((k) => k !== 'engine').map((k) => [k, normalize(o[k], paths, k)]));
  }
  return value;
}

/**
 * Where an arm's output first differs from the reference's: a JSON path and both values, each cut to 120 characters.
 * Two strings that differ are named at the first differing character (`path@offset`), with the text from 20
 * characters before it, so a long MCP text body still shows the difference.
 */
export interface FirstDiff { path: string; ref: string; arm: string }

const shortValue = (v: unknown): string => (v === undefined ? '<missing>' : JSON.stringify(v) ?? String(v)).slice(0, 120);

function diffAt(a: unknown, b: unknown, path: string): FirstDiff | null {
  if (a === b) return null;
  if (typeof a === 'string' && typeof b === 'string') {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const from = Math.max(0, i - 20);
    return { path: `${path}@${i}`, ref: JSON.stringify(a.slice(from, from + 120)), arm: JSON.stringify(b.slice(from, from + 120)) };
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = i < a.length && i < b.length ? diffAt(a[i], b[i], `${path}[${i}]`) : { path: `${path}[${i}]`, ref: shortValue(a[i]), arm: shortValue(b[i]) };
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
    for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])].sort()) {
      const d = Object.hasOwn(x, k) && Object.hasOwn(y, k) ? diffAt(x[k], y[k], `${path}.${k}`)
        : { path: `${path}.${k}`, ref: shortValue(Object.hasOwn(x, k) ? x[k] : undefined), arm: shortValue(Object.hasOwn(y, k) ? y[k] : undefined) };
      if (d) return d;
    }
    return null;
  }
  return { path, ref: shortValue(a), arm: shortValue(b) };
}

/**
 * The first place an arm's answer differs from the reference's, both already normalised: `$.exit` when the exit
 * codes differ, else the first `$.out...` path in sorted-key, array-index order. null when the two are equal.
 */
export function firstDiff(ref: { exit: number; out: unknown }, arm: { exit: number; out: unknown }): FirstDiff | null {
  return diffAt({ exit: ref.exit, out: ref.out }, { exit: arm.exit, out: arm.out }, '$');
}

/** An arm's raw output for the JSON report: the temp paths masked, cut to `limit` characters. */
export function maskedExcerpt(text: string, paths: Array<[string, string]>, limit = 600): string {
  return paths.reduce((t, [path, mark]) => t.split(path).join(mark), text.trim()).slice(0, limit);
}
