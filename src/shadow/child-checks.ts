/**
 * The child's side of its questions to the serving process (checks.ts): the pending-answer table, the per-item privacy
 * verdict, and the bounded one-at-a-time queue of stable reruns. Content-free: only page ids and counts cross.
 *
 * Privacy verdict (plan decision 6, review F1). The source-scope check in classify.ts runs first. After it, every Rust row
 * the primary's own answer did not hold is a page the primary did not show this caller: the serving process judges it
 * with the primary's read policy under the captured `CallerAccess` (named by sample id: the record, the arguments and the policy
 * never travel back over the control channel). A page the caller may not read is a violation. A rise
 * of the policy generation during the check, or no answer, is `inconclusive`, never a pass. A row the primary's answer
 * holds needs no check, and a read that did not ask for the policy (`excludePrivate`) is not judged.
 */
import { createHash } from 'node:crypto';
import type { PageCandidates, PrivacyAnswer } from './checks.ts';

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
/** The chunk a result row carries: its id and a digest of its text (null when the row has none), so a substituted chunk is not the same row. */
function chunkOf(row: Row): { id: number; sum: string | null } | undefined {
  return typeof row.chunk_id === 'number' ? { id: row.chunk_id, sum: typeof row.chunk_text === 'string' ? md5(row.chunk_text) : null } : undefined;
}

export interface ExtraRow { id?: number; key?: string; chunk?: { id: number; sum: string | null } }

/**
 * The Rust rows the primary's answer did not hold, at ROW identity: the same page AND the same chunk (id and text) is the
 * primary's row; a row on a known page with another chunk, or another text, is extra, because the page's policy cannot vouch
 * for a chunk the primary did not return. `unidentified` counts the rows that name no page at all.
 */
export function extraRows(encodedPrimary: unknown, encodedRust: unknown): { rows: ExtraRow[]; unidentified: number } {
  const sig = (p: { id?: number; key?: string }, c: { id: number; sum: string | null } | undefined): string[] =>
    [...(p.id === undefined ? [] : [`i${p.id}`]), ...(p.key === undefined ? [] : [`k${p.key}`])].map((page) => `${page}|${c ? `${c.id}:${c.sum}` : '-'}`);
  const have = new Set(rowsOf(encodedPrimary).flatMap((r) => sig(pageOf(r), chunkOf(r))));
  const out: { rows: ExtraRow[]; unidentified: number } = { rows: [], unidentified: 0 };
  for (const r of rowsOf(encodedRust)) {
    const p = pageOf(r);
    const c = chunkOf(r);
    if (sig(p, c).some((s) => have.has(s))) continue;
    if (p.id === undefined && p.key === undefined) out.unidentified++; else out.rows.push({ ...p, ...(c ? { chunk: c } : {}) });
  }
  return out;
}

/** The pages (and chunk ids) of the Rust answer that the primary's answer did not hold. */
export function missingPages(encodedPrimary: unknown, encodedRust: unknown): PageCandidates {
  const out: PageCandidates = { ids: [], keys: [], chunks: [] };
  for (const p of extraRows(encodedPrimary, encodedRust).rows) {
    if (p.id !== undefined) out.ids.push(p.id);
    else if (p.key !== undefined) out.keys.push(p.key); // a slug leaves the child only for a row with no page id
    if (p.chunk) out.chunks.push(p.chunk.id);
  }
  return out;
}

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
 * Asks the serving process (checks.ts `policyCheck`) about every Rust page the primary's answer lacked, for the sample `sid`
 * (its captured caller record, and the primary's own policy text). `phase` says which primary read to hold the check to: the
 * sample's own, or the stable rerun's. A row the check cannot evaluate (no page identity, a page or chunk the primary does
 * not have, a chunk on another page or with other text, a failed, skipped or moved check) leaves `complete` false.
 */
export async function privacyVerdict(ask: Asker, args: unknown[], primary: unknown, rust: unknown, sid: string | undefined, phase: 'sample' | 'rerun', at: number): Promise<PrivacyResult> {
  if (!policyApplies(args)) return { verdict: 'clean', complete: false };
  const extra = extraRows(primary, rust);
  if (extra.rows.length === 0) return { verdict: 'clean', complete: extra.unidentified === 0 };
  if (!sid) return { verdict: 'privacy_check_unavailable', complete: false };
  try {
    const answer = await ask({ kind: 'privacy', sid, phase, at, candidates: missingPages(primary, rust) }, PRIVACY_ASK_TIMEOUT_MS) as PrivacyAnswer;
    if (answer.moved) return { verdict: 'privacy_check_moved', complete: false };
    if (answer.violations > 0) return { verdict: 'violation', complete: false };
    const pageIds = new Map(answer.found.pages.map((p) => [p.id, p.key]));
    const pageKeys = new Map(answer.found.pages.map((p) => [p.key, p.id]));
    const chunks = new Map(answer.found.chunks.map((c) => [c.id, c]));
    const judged = (r: ExtraRow): boolean => {
      const page = r.id !== undefined ? (pageIds.has(r.id) ? r.id : undefined) : r.key !== undefined ? pageKeys.get(r.key) : undefined;
      if (page === undefined) return false;
      if (!r.chunk) return true;
      const c = chunks.get(r.chunk.id);
      return !!c && c.page_id === page && r.chunk.sum !== null && c.sum === r.chunk.sum; // the chunk is that page's, with the text the primary stores
    };
    return { verdict: 'clean', complete: extra.unidentified === 0 && extra.rows.every(judged) };
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
