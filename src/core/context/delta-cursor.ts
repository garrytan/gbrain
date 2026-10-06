/**
 * delta's per-arm cursor (contributor audit wave P0). Pages page by the
 * keyset `(updated_at, slug)`, facts by `(created_at, id)`, both at column
 * (microsecond) precision. Each arm advances through the prefix it actually
 * delivered and no further; an arm whose result is unknown does not move.
 *
 * The opaque `cursor` request param carries both keysets; the legacy
 * `since`/`slug` pair stays conservative so an older client re-sees pages but
 * never skips facts. Pure: no engine access.
 */

/** Pages arm position. `slug` undefined = strictly after `since` (a legacy stateless call). */
export interface PagesPos { since: string; slug?: string }
/** Facts arm position. `id` null = strictly after `at` (a legacy `since`). */
export interface FactsPos { at: string; id: number | null }
export interface DeltaPosition { pages: PagesPos; facts: FactsPos }

/** Rows committed in a transaction that started before this lag can still be missed (documented bound). */
export const DELTA_COMMIT_LAG_MS = 2_000;
export const DELTA_TIMESTAMP_RANGE = '0001-01-01T00:00:00Z to 9999-12-31T23:59:59.999999Z';

const MICRO_ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

/** Normalize an ISO UTC timestamp to the 6-digit `…ss.ffffffZ` shape so lexicographic order is time order. */
export function toMicroIso(iso: string): string {
  const m = MICRO_ISO.exec(iso);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${(m[7] ?? '').padEnd(6, '0')}Z`;
  return toMicroIso(new Date(Date.parse(iso)).toISOString());
}

/** Microseconds since the epoch, exact (BigInt) for a micro-ISO string. */
function toMicros(iso: string): bigint {
  const m = toMicroIso(iso);
  return BigInt(Date.parse(`${m.slice(0, 19)}Z`)) * 1000n + BigInt(m.slice(20, 26));
}

function fromMicros(us: bigint): string {
  const ms = us / 1000n - (us % 1000n < 0n ? 1n : 0n);
  const rem = us - ms * 1000n;
  const base = new Date(Number(ms)).toISOString();
  return `${base.slice(0, 23)}${String(rem).padStart(3, '0')}Z`;
}

/** One microsecond earlier: the strictly-earlier clamp at column precision. */
export function microBefore(iso: string): string {
  return fromMicros(toMicros(iso) - 1n);
}

export function horizonIso(now: number = Date.now()): string {
  return toMicroIso(new Date(now - DELTA_COMMIT_LAG_MS).toISOString());
}

/**
 * Validate a timestamp the way delta's `since` is validated: parseable,
 * a real calendar date, and inside 0001-9999 on the PARSED (UTC) value,
 * so an offset cannot smuggle year 0 or an extended year past the check.
 * Returns the canonical form or an error message.
 */
export function checkDeltaTimestamp(raw: string): { ok: true; value: string } | { ok: false; why: 'unparseable' | 'calendar' | 'range' } {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { ok: false, why: 'unparseable' };
  if (/^[+-]/.test(raw.trim())) return { ok: false, why: 'range' };
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (iso) {
    const [year, month, day] = iso.slice(1).map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > dim[month - 1]) return { ok: false, why: 'calendar' };
  }
  const year = new Date(ms).getUTCFullYear();
  if (year < 1 || year > 9999) return { ok: false, why: 'range' };
  return {
    ok: true,
    value: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(raw) ? raw : new Date(ms).toISOString(),
  };
}

/** Total order on pages positions; an undefined slug sorts after every slug at that timestamp. */
export function comparePages(a: PagesPos, b: PagesPos): number {
  const t = toMicroIso(a.since).localeCompare(toMicroIso(b.since));
  if (t !== 0) return t;
  if (a.slug === b.slug) return 0;
  if (a.slug === undefined) return 1;
  if (b.slug === undefined) return -1;
  return a.slug < b.slug ? -1 : 1;
}

/** Total order on facts positions; a null id sorts after every id at that timestamp. */
export function compareFacts(a: FactsPos, b: FactsPos): number {
  const t = toMicroIso(a.at).localeCompare(toMicroIso(b.at));
  if (t !== 0) return t;
  if (a.id === b.id) return 0;
  if (a.id === null) return 1;
  if (b.id === null) return -1;
  return a.id < b.id ? -1 : 1;
}

const maxPages = (a: PagesPos, b: PagesPos) => (comparePages(a, b) >= 0 ? a : b);
const maxFacts = (a: FactsPos, b: FactsPos) => (compareFacts(a, b) >= 0 ? a : b);

/** Opaque wire form: base64url JSON `{v:1, p:[since, slug], f:[at, id]}`. */
export function encodeDeltaCursor(pos: DeltaPosition): string {
  const body = { v: 1, p: [pos.pages.since, pos.pages.slug ?? null], f: [pos.facts.at, pos.facts.id] };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

const MAX_CURSOR_LEN = 2_048;
const MAX_SLUG_LEN = 512;

/** Decode + validate a `cursor` param. Returns the position or the reason it was refused. */
export function decodeDeltaCursor(raw: string): { ok: true; pos: DeltaPosition } | { ok: false; why: string } {
  if (raw.length > MAX_CURSOR_LEN || !/^[A-Za-z0-9_-]+$/.test(raw)) return { ok: false, why: 'not a cursor returned by delta (expected base64url)' };
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, why: 'not a cursor returned by delta (undecodable)' };
  }
  const b = body as { v?: unknown; p?: unknown; f?: unknown };
  if (!b || typeof b !== 'object' || b.v !== 1 || !Array.isArray(b.p) || !Array.isArray(b.f) || b.p.length !== 2 || b.f.length !== 2) {
    return { ok: false, why: 'not a version-1 delta cursor' };
  }
  const [ps, pslug] = b.p as unknown[];
  const [fa, fid] = b.f as unknown[];
  if (typeof ps !== 'string' || typeof fa !== 'string') return { ok: false, why: 'cursor timestamps must be strings' };
  for (const ts of [ps, fa]) {
    const c = checkDeltaTimestamp(ts);
    if (!c.ok) return { ok: false, why: c.why === 'range' ? `cursor timestamp outside ${DELTA_TIMESTAMP_RANGE}` : 'cursor timestamp is not a valid ISO 8601 calendar timestamp' };
  }
  if (pslug !== null && (typeof pslug !== 'string' || pslug.length > MAX_SLUG_LEN)) return { ok: false, why: 'cursor page slug is invalid' };
  if (fid !== null && (typeof fid !== 'number' || !Number.isSafeInteger(fid) || fid < 0)) return { ok: false, why: 'cursor fact id must be a non-negative integer' };
  const canonical = (ts: string) => (checkDeltaTimestamp(ts) as { value: string }).value;
  return {
    ok: true,
    pos: {
      pages: { since: canonical(ps), ...(pslug !== null ? { slug: pslug as string } : {}) },
      facts: { at: canonical(fa), id: fid as number | null },
    },
  };
}

/** Whether an arm's read completed (`ok`), threw (`failed`) or never finished before the deadline (`unknown`). */
export type ArmStatus = 'ok' | 'failed' | 'unknown';

/**
 * Next pages position: through the last DELIVERED page at or before the
 * horizon. An empty, complete, undropped session arm advances to the horizon (rows
 * from a transaction that commits later than the lag can still be missed —
 * the documented bound). Anything else holds.
 */
export function nextPagesPos(input: {
  start: PagesPos;
  complete: boolean;
  delivered: Array<{ updated_at: string; slug: string }>;
  undelivered: boolean;
  horizon: string;
  /** Session callers move an empty, complete arm up to the horizon; a stateless cursor stays put (its caller owns it). */
  advanceOnEmpty: boolean;
}): PagesPos {
  const { start, complete, delivered, undelivered, horizon, advanceOnEmpty } = input;
  if (!complete) return start;
  let next = start;
  for (const p of delivered) {
    if (toMicroIso(p.updated_at) > horizon) return next;
    next = { since: p.updated_at, slug: p.slug };
  }
  if (delivered.length === 0 && !undelivered && advanceOnEmpty) return maxPages(start, { since: horizon, slug: '' });
  return next;
}

export interface RawFactRef { id: number; at: string; repId: number }

/**
 * Next facts position, computed from the RAW rows (duplicate collapse emits a
 * cluster's newest row at its first-seen position): the largest raw row such
 * that every raw row at or below it belongs to a delivered cluster and is at
 * or before the horizon. Also returns the oldest raw row NOT covered, which
 * the conservative legacy cursor must stay strictly before.
 */
export function nextFactsPos(input: {
  start: FactsPos;
  complete: boolean;
  raw: RawFactRef[];
  overflowRow: { id: number; at: string } | null;
  deliveredRepIds: ReadonlySet<number>;
  horizon: string;
  advanceOnEmpty: boolean;
}): { next: FactsPos; oldestUndelivered: string | null } {
  const { start, complete, raw, overflowRow, deliveredRepIds, horizon, advanceOnEmpty } = input;
  if (!complete) return { next: start, oldestUndelivered: null };
  const oldestUndelivered = raw.find((r) => !deliveredRepIds.has(r.repId))?.at ?? overflowRow?.at ?? null;
  if (raw.length === 0 && !overflowRow) return { next: advanceOnEmpty ? maxFacts(start, { at: horizon, id: 0 }) : start, oldestUndelivered };
  let next = start;
  for (const r of raw) {
    if (!deliveredRepIds.has(r.repId) || toMicroIso(r.at) > horizon) break;
    next = { at: r.at, id: r.id };
  }
  return { next, oldestUndelivered };
}

/** Session row fields delta resumes from (see session-state.ts DeltaSessionState). */
interface SessionCursor {
  last_wake_at: string | null;
  cursor_slug: string | undefined;
  facts_cursor_at: string | null;
  facts_cursor_id: number | null;
}

/**
 * Where a delta call starts. Precedence: explicit `cursor` > explicit `since`
 * (both arms strictly after it, slug only when supplied) > the session row
 * (`since_slug` may override its slug) > none (a first wake).
 */
export function resolveDeltaStart(input: {
  cursorPos: DeltaPosition | null;
  explicitSince: string | null;
  explicitSlug: string | undefined;
  session: SessionCursor | null;
}): DeltaPosition | null {
  const { cursorPos, explicitSince, explicitSlug, session } = input;
  if (cursorPos) return cursorPos;
  if (explicitSince) {
    return { pages: { since: explicitSince, ...(explicitSlug !== undefined ? { slug: explicitSlug } : {}) }, facts: { at: explicitSince, id: null } };
  }
  if (!session?.last_wake_at) return null;
  const slug = explicitSlug ?? session.cursor_slug;
  return {
    pages: { since: session.last_wake_at, ...(slug !== undefined ? { slug } : {}) },
    facts: session.facts_cursor_at ? { at: session.facts_cursor_at, id: session.facts_cursor_id } : { at: session.last_wake_at, id: null },
  };
}

/**
 * The conservative single cursor for clients that do not send `cursor`.
 * No advance at all while any arm is failed or unknown; otherwise the last
 * delivered page, or on a page-less wake the newest delivered fact (an old
 * client reads facts strictly after `since`, so a budget that fits only part
 * of the facts still drains them). Never at or past the oldest undelivered
 * fact: it clamps one microsecond before it and resets the slug.
 */
export function legacyDeltaCursor(input: {
  start: DeltaPosition;
  pagesNext: PagesPos;
  factsNext: FactsPos;
  oldestUndelivered: string | null;
  incomplete: boolean;
  pagesDelivered: number;
  factsDelivered: number;
  pagesQuiet: boolean;
}): { legacy: PagesPos; clamped: boolean } {
  const { start, pagesNext, factsNext, oldestUndelivered, incomplete, pagesDelivered, factsDelivered, pagesQuiet } = input;
  if (incomplete) return { legacy: start.pages, clamped: false };
  const legacy: PagesPos =
    pagesDelivered > 0 ? pagesNext
      : pagesQuiet && factsDelivered > 0 && compareFacts(factsNext, start.facts) > 0 ? { since: factsNext.at, slug: '' }
        : start.pages;
  if (oldestUndelivered !== null && toMicroIso(legacy.since) >= toMicroIso(oldestUndelivered)) {
    return { legacy: { since: microBefore(oldestUndelivered), slug: '' }, clamped: true };
  }
  return { legacy, clamped: false };
}
