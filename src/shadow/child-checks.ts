/**
 * The child's side of its questions to the serving process (checks.ts): the pending-answer table, the per-item privacy
 * verdict, and the bounded one-at-a-time queue of stable reruns. Content-free: only page ids and counts cross.
 *
 * Privacy verdict (plan decision 6, review F1). The source-scope check in classify.ts runs first. After it, every Rust row
 * the primary's own answer did not hold is a page the primary did not show this caller: the serving process judges it
 * with the primary's read policy under the captured `CallerAccess` (named by sample id: the record, the arguments and the policy
 * never travel back over the control channel, and neither does any content: the answer is a verdict). A page the caller may not read is a violation. A rise
 * of the policy generation during the check, or no answer, is `inconclusive`, never a pass. A row the primary's answer
 * holds needs no check, and a read that did not ask for the policy (`excludePrivate`) is not judged.
 */
import { createHash } from 'node:crypto';
import type { PageCandidates } from './checks.ts';
import { stripScores } from './classify.ts';
import { canonicalJson } from './codec.ts';

export const PRIVACY_ASK_TIMEOUT_MS = 10_000;
export const RERUN_QUEUE_BOUND = 64;

const SEP = '\u001f';
type Row = Record<string, unknown>;

function rowsOf(encoded: unknown): Row[] {
  const list = Array.isArray(encoded) ? encoded : encoded && typeof encoded === 'object' ? [encoded] : [];
  return list.filter((r): r is Row => !!r && typeof r === 'object');
}

/** The page a result row belongs to: a search or chunk row names it by `page_id`; a page row is its own (it has a slug). */
function pageOf(row: Row): { id?: number; key?: string } {
  const id = row.page_id ?? (typeof row.slug === 'string' ? row.id : undefined);
  return {
    ...(typeof id === 'number' ? { id } : {}),
    ...(typeof row.source_id === 'string' && typeof row.slug === 'string' ? { key: `${row.source_id}${SEP}${row.slug}` } : {}),
  };
}

const md5 = (text: string): string => createHash('md5').update(text).digest('hex');
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
/** The digest of an encoded result in the comparison form (codec.ts canonicalJson): what a rerun's answer carries instead of the result. */
export const resultDigest = (encoded: unknown): string => sha(canonicalJson(encoded));

/** The digest of a ranked answer's membership: its rows with scores out, in a fixed order; null when it is not a list of rows. Equal for the same rows in another order or with other scores. */
export const membersDigest = (encoded: unknown): string | undefined => (Array.isArray(encoded) ? sha(encoded.map((r) => canonicalJson(stripScores(r))).sort().join('\n')) : undefined);

/** The chunk a result row carries: its id and a digest of its text (null when the row has none), so a substituted chunk is not the same row. `invalid` is a row that claims a chunk it does not identify. */
export type ChunkIdentity = { id: number; sum: string | null } | 'invalid';
function chunkOf(row: Row): ChunkIdentity | undefined {
  if (typeof row.chunk_id === 'number' && Number.isSafeInteger(row.chunk_id)) return { id: row.chunk_id, sum: typeof row.chunk_text === 'string' ? md5(row.chunk_text) : null };
  // A ranked row (it has a score), or any row that names a chunk id or carries chunk text, must name a valid chunk: a missing or non-numeric id is never a page-only row.
  const claims = (row.chunk_id !== undefined && row.chunk_id !== null) || typeof row.chunk_text === 'string' || typeof row.score === 'number';
  return claims ? 'invalid' : undefined;
}

/** One result row reduced to identity: its page, its chunk and a digest of every field but the ranking ones. No content. */
/**
 * True when `encoded` is not a well-formed answer: for a read that answers a list (`list`), anything but a list; and in any
 * answer, a list element that is not an object (a null, a string, a number, a nested list), or a scalar where rows are expected.
 * Such an answer, or element, has no identity to judge, so a verdict over it is never complete.
 */
export function hasMalformedElement(encoded: unknown, list = false): boolean {
  if (list && !Array.isArray(encoded)) return true; // a null, an undefined or a single row where the read answers a list
  if (Array.isArray(encoded)) return encoded.some((r) => !r || typeof r !== 'object' || Array.isArray(r));
  return encoded !== null && encoded !== undefined && typeof encoded !== 'object';
}

export interface RowIdentity { id?: number; key?: string; chunk?: ChunkIdentity; payload: string }
export interface ExtraRow { id?: number; key?: string; chunk?: { id: number; sum: string | null }; /** The digest of every field but the ranking ones (see `RowIdentity`). */ payload: string }

export function rowIdentities(encoded: unknown): RowIdentity[] {
  return rowsOf(encoded).map((r) => ({ ...pageOf(r), ...(chunkOf(r) === undefined ? {} : { chunk: chunkOf(r) }), payload: sha(canonicalJson(stripScores(r))) }));
}

const pageSigs = (r: { id?: number; key?: string }): string[] => [...(r.id === undefined ? [] : [`i${r.id}`]), ...(r.key === undefined ? [] : [`k${r.key}`])];
const chunkSig = (c: ChunkIdentity | undefined): string => (c === undefined ? '-' : c === 'invalid' ? '!' : `${c.id}:${c.sum}`);

/**
 * The Rust rows the primary's answer did not hold, at ROW identity. A row held by the primary is byte-equal to one of its rows
 * in every field but the ranking ones (a score is not identity). Not held, and then: a row with no page identity, or that
 * claims a chunk it does not identify, or that has the page and chunk of a primary row but another payload (a substituted
 * title, flags, text) is UNIDENTIFIED: never cleared. A row on a page or chunk the primary did not return is extra, for the
 * serving process to judge (page policy, safe fence, the chunk is that page's with the text the primary stores).
 */
export function extraIds(primary: RowIdentity[], rust: RowIdentity[]): { rows: ExtraRow[]; unidentified: number } {
  const chunky = primary.some((r) => typeof r.chunk === 'object');
  const full = new Set(primary.flatMap((r) => pageSigs(r).map((p) => `${p}|${chunkSig(r.chunk)}|${r.payload}`)));
  const ident = new Set(primary.flatMap((r) => pageSigs(r).map((p) => `${p}|${chunkSig(r.chunk)}`)));
  const out: { rows: ExtraRow[]; unidentified: number } = { rows: [], unidentified: 0 };
  for (const r of rust) {
    const pages = pageSigs(r);
    if (pages.some((p) => full.has(`${p}|${chunkSig(r.chunk)}|${r.payload}`))) continue;
    if (pages.length === 0 || r.chunk === 'invalid' || (chunky && r.chunk === undefined) || pages.some((p) => ident.has(`${p}|${chunkSig(r.chunk)}`))) { out.unidentified++; continue; }
    out.rows.push({ ...(r.id === undefined ? {} : { id: r.id }), ...(r.key === undefined ? {} : { key: r.key }), ...(r.chunk ? { chunk: r.chunk as { id: number; sum: string | null } } : {}), payload: r.payload });
  }
  return out;
}

/** The identities one row answers to (its page by id and by slug, with its chunk), each mapped to the digest of its non-ranking fields: how the primary's stored rows are looked up. */
export function storedPayloads(rows: RowIdentity[]): Map<string, string> {
  return new Map(rows.flatMap((r) => pageSigs(r).map((p): [string, string] => [`${p}|${chunkSig(r.chunk)}`, r.payload])));
}
/** Does the primary's stored row for this extra row's page and chunk carry exactly its non-ranking fields? A row the primary does not hold, or holds with any other field, does not. */
export const matchesStored = (stored: Map<string, string>, r: ExtraRow): boolean => pageSigs(r).some((p) => stored.get(`${p}|${chunkSig(r.chunk)}`) === r.payload);

export const extraRows = (encodedPrimary: unknown, encodedRust: unknown): { rows: ExtraRow[]; unidentified: number } => extraIds(rowIdentities(encodedPrimary), rowIdentities(encodedRust));

/** The pages (and chunk ids) of extra rows. */
export function candidatesOf(rows: ExtraRow[]): PageCandidates {
  const out: PageCandidates = { ids: [], keys: [], chunks: [] };
  for (const p of rows) {
    if (p.id !== undefined) out.ids.push(p.id);
    else if (p.key !== undefined) out.keys.push(p.key); // a slug leaves the child only for a row with no page id
    if (p.chunk) out.chunks.push(p.chunk.id);
  }
  return out;
}

/** The pages (and chunk ids) of the Rust answer that the primary's answer did not hold. */
export const missingPages = (encodedPrimary: unknown, encodedRust: unknown): PageCandidates => candidatesOf(extraRows(encodedPrimary, encodedRust).rows);

/** Did the read ask for the read policy (`excludePrivate`, plain, under `remote`, or on a find's `untrusted` policy)? Only then is a missing row a policy question. */
export function policyApplies(args: unknown[]): boolean {
  return args.some((a) => {
    const o = a as { excludePrivate?: unknown; remote?: { excludePrivate?: unknown }; untrusted?: { excludePrivate?: unknown } | null } | null;
    return !!o && typeof o === 'object' && (o.excludePrivate === true || o.remote?.excludePrivate === true || o.untrusted?.excludePrivate === true);
  });
}

export type PrivacyVerdict = 'clean' | 'violation' | 'privacy_check_moved' | 'privacy_check_unavailable';
/** `complete`: every extra Rust row was identified and the primary judged it (or there was none). Only then is a ranked diff accepted (exactness.ts RANKED_PRIVATE_EXCEPTION). */
export interface PrivacyResult { verdict: PrivacyVerdict; complete: boolean }

/**
 * Asks the serving process (checks.ts `privacyAnswer`) about the Rust rows the primary's answer lacked, for the sample `sid`
 * (its captured caller record, arguments and primary answer all stay there). The ask carries only the Rust rows' identities
 * (page, chunk, digests; no content) and the answer is a verdict, never content: the serving process compares the rows with
 * the primary's own answer for `phase` (the sample's, or the stable rerun's), judges the extra ones with the primary's read
 * policy and safe fence, and says clean, violation or moved. A row the check cannot evaluate (no page identity, no valid chunk
 * identity, a payload that differs from the primary's row of that page and chunk, a page or chunk the primary does not have,
 * a failed, skipped or moved check) leaves `complete` false.
 */
export async function privacyVerdict(ask: Asker, args: unknown[], primary: unknown, rust: unknown, sid: string | undefined, phase: 'sample' | 'rerun', at: number, expectList = false, attempt?: string): Promise<PrivacyResult> {
  if (!policyApplies(args)) return { verdict: 'clean', complete: false };
  const rows = rowIdentities(rust);
  const whole = !hasMalformedElement(rust, expectList); // an answer that is not the list the read answers, or an element that is not a row, has no identity to judge: the verdict is never complete
  if (phase === 'sample') {
    const extra = extraIds(rowIdentities(primary), rows);
    if (extra.rows.length === 0) return { verdict: 'clean', complete: whole && extra.unidentified === 0 };
  }
  if (!sid) return { verdict: 'privacy_check_unavailable', complete: false };
  try {
    // A slug leaves the child only for a row with no page id.
    const wire = rows.map(({ key, ...r }) => (r.id === undefined && key !== undefined ? { ...r, key } : r));
    const answer = await ask({ kind: 'privacy', sid, phase, at, ...(attempt === undefined ? {} : { attempt }), rows: wire }, PRIVACY_ASK_TIMEOUT_MS) as Partial<PrivacyResult> | null;
    const v = answer?.verdict;
    if (v === 'clean') return { verdict: 'clean', complete: whole && answer?.complete === true };
    if (v === 'violation' || v === 'privacy_check_moved') return { verdict: v, complete: false };
    return { verdict: 'privacy_check_unavailable', complete: false };
  } catch { return { verdict: 'privacy_check_unavailable', complete: false }; }
}

export type Asker = ((payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown>) & { answer(line: { id?: number; session?: string; ok?: boolean; value?: unknown; error?: { code?: string } }): void; closeAll(): void };

/** A failure code the child records: a plain lowercase token from a bounded set of shapes, else `failed`. Never text that could hold content. */
export const safeCode = (code: unknown): string => (typeof code === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(code) ? code : 'failed');

/** One `ask` line out, one `answer` line back, matched by id AND by this child's session nonce (an answer meant for another child is ignored); a late answer after the timeout is ignored. */
export function createAsker(write: (line: string) => void, session = ''): Asker {
  let next = 0;
  let closed = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const settle = (id: number, ok: boolean, value: unknown): void => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve(value); else p.reject(Object.assign(new Error(safeCode(value)), { code: safeCode(value) }));
  };
  const ask = ((payload: Record<string, unknown>, timeoutMs: number) => new Promise<unknown>((resolve, reject) => {
    if (closed) { reject(Object.assign(new Error('closing'), { code: 'closing' })); return; }
    const id = ++next;
    const timer = setTimeout(() => settle(id, false, 'timeout'), Math.max(1, timeoutMs));
    (timer as { unref?: () => void }).unref?.();
    pending.set(id, { resolve, reject, timer });
    try { write(JSON.stringify({ t: 'ask', id, session, ...payload }) + '\n'); } catch { settle(id, false, 'parent_gone'); }
  })) as Asker;
  ask.answer = (line) => { if (typeof line.id === 'number' && line.session === session) settle(line.id, line.ok === true, line.ok === true ? line.value : line.error?.code ?? 'failed'); };
  ask.closeAll = () => { closed = true; for (const id of [...pending.keys()]) settle(id, false, 'closing'); };
  return ask;
}

/** Runs queued tasks one at a time, at most `bound` queued or running; a task over the bound is refused to its caller. */
export function createSerialQueue<T>(bound: number, run: (task: T) => Promise<void>) {
  const items: T[] = [];
  let busy: Promise<void> | null = null;
  const pump = (): void => {
    busy ??= (async () => {
      while (items.length) { try { await run(items.shift()!); } catch { /* run records its own failures */ } }
      busy = null;
    })();
  };
  return {
    /** False when the queue is full. */
    add(task: T): boolean {
      if (items.length + (busy ? 1 : 0) >= bound) return false;
      items.push(task);
      pump();
      return true;
    },
    /** Takes out what has not started, for the caller to finish as skipped. */
    drop(): T[] { return items.splice(0); },
    idle: (): Promise<void> => busy ?? Promise.resolve(),
  };
}

/** The wait before a rerun: a timer (never a busy loop) that `close()` ends at once. `sleep` is a seam for tests. */
export function createWaiter(sleep?: (ms: number) => Promise<void>) {
  let closed = false;
  const wakers = new Set<() => void>();
  return {
    pause: sleep ?? ((ms: number): Promise<void> => (closed ? Promise.resolve() : new Promise((resolve) => { // already closed: no timer, so a moved answer followed at once by the end of input holds nothing
      const done = (): void => { clearTimeout(timer); wakers.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      wakers.add(done);
    }))),
    close(): void { closed = true; for (const wake of [...wakers]) wake(); },
    closed: (): boolean => closed,
  };
}
