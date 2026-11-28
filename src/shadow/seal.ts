/**
 * Carrying a clean follower from one serving process to the next (shadow follow). The child side is follow-child.ts
 * ("Sealing"); this is the serving side: the database checks that decide whether a seal may be written at close and
 * whether the next session may trust it.
 *
 * A seal says "every write this process committed is in the store or held as an obligation". What it cannot see is a
 * write by someone else. Wrapped gbrain processes leave a trace the child checks itself (they own the store in turn and
 * rewrite follower.json, or leave a line in follower-invalidations.jsonl). On a Postgres primary the writer hooks
 * (writer-hooks.ts) record other writing connections, but a record can be missing (a role with no way to write one,
 * both evidence tables locked, a row another transaction holds) or not move the evidence (a row refreshed that is not
 * the newest), so the seal does not rest on the records. Its token is the database's own count of what was written:
 *  - at close (`sealMark`) the token is read: the server's statistics epoch (`pg_stat_database.stats_reset`, the
 *    postmaster start) and, for every relation the seed copied (seed.json, plus `page_projection_jobs`, which the pages
 *    read carries), its oid, relfilenode and the tuples inserted, updated and deleted (`pg_stat_user_tables`), plus the
 *    coverage-gap rows. The token is versioned; a token of another shape is refused as `mark_unreadable`;
 *  - at the next start (`quietSince`, from `confirmSeal`) the same read must show the same token: any new write (or an
 *    aborted one), a TRUNCATE or rewrite, a relation dropped, created or replaced, a statistics reset or a restarted
 *    server refuses it. Counters only prove what the server has flushed (a backend flushes at most about a minute
 *    after a write, and at exit), so the check also refuses while any other connection to this database is not idle,
 *    went idle less than a minute ago, or cannot be seen, while a prepared transaction exists, while another connection
 *    has a write transaction open, and while a connection the hooks recorded is still connected (the cost: a writer
 *    still connected during the seal check is refused until it commits or disconnects). The same activity checks run
 *    at close. The sealing process's own connections are left out of the activity checks, not the counters: what it
 *    commits is published to the follower, and a write published after the follower closed is recorded as lost
 *    (follower.ts `close`), which voids the seal; its own writes after the token move the counters and refuse the seal;
 *  - a login role that can write a brain table with no complete way to record evidence (`uncovered_roles` of
 *    writer-observations.ts) refuses at close and at the next start; a new coverage gap and a hook that is not working
 *    refuse the next start;
 *  - a server older than PostgreSQL 15 (statistics in shared memory), or `track_counts` off for this database or for a
 *    role in it, refuses: with the counters not kept nothing proves the database was untouched. A superuser who sets
 *    `track_counts = off` in its own session is not detectable.
 * After the child took the confirmation the check is read once more; a write that began in between makes the serving
 * process send `revokeSeal`, which invalidates the watermark again with a full obligation (follow-child.ts).
 * Row security is switched off inside these reads, so a policy that would hide a row makes the read fail (no seal)
 * instead of returning fewer rows. Any error, a timeout, or hooks that are not installed: no seal, or no confirmation.
 * PGLite never seals and never confirms (`pglite_no_db_continuity`): nothing on a PGLite primary proves no other process
 * opened and wrote it between two sessions, so each session keeps its own full obligation and its 5 s check runs a pass.
 * Every refusal names its reason (a short code), which the child records in follower.json `seal_outcome` for status.
 */
import type { BrainEngine } from '../core/engine.ts';
import type { ReadQuery, ReadSource } from './read-pool.ts';
import { readSeedRecord } from './seed.ts';
import { hooksIntact, readWriterHooksManifest, WRITER_EVIDENCE_TABLES, WRITER_HOOK_TRIGGER } from './writer-hooks.ts';
import { readWriterEvidence } from './writer-observations.ts';

const SEAL_READ_MS = 2_000;

import { PGLITE_NO_DB_CONTINUITY } from './follow-status.ts';

export { PGLITE_NO_DB_CONTINUITY };

/** A seal check's answer: quiet, or refused with a short reason code. */
export type SealVerdict = { ok: true } | { ok: false; reason: string };
/** The mark to seal with, or the reason no seal may be written. */
export type SealMarkResult = { token: string } | { refused: string };

/** Whether this primary is checked through writer hooks (Postgres) or not at all (PGLite). */
export interface SealDeps {
  dir: string;
  reads: ReadSource;
  postgres: boolean;
  rpc: <T>(method: string, args?: Record<string, unknown>, timeoutMs?: number) => Promise<T>;
}

/** Tables the seed copies without a relation of their own: the pages read carries `page_projection_jobs` (seed-gaps.ts `carried`). */
export const SEAL_CARRIED_TABLES: readonly string[] = ['page_projection_jobs'];

/** The token's shape version. A token of another version (the writer fingerprint of an older build has none) is refused as `mark_unreadable`. */
const TOKEN_VERSION = 2;

/** Statistics are in shared memory (flushed by each backend, readable at once) from PostgreSQL 15. */
const MIN_SERVER_VERSION = 150_000;
/** A backend flushes its counters when it goes idle, at the latest about a minute after a write; a connection that went idle less than this ago may hold unflushed counts. */
const SETTLE_SECONDS = 61;

/** A copied relation as the database knows it: identity and cumulative tuple counts (decimal strings, compared as integers). */
interface Rel { oid: string; relfilenode: string; ins: string; upd: string; del: string }
/** What a Postgres seal records: the sealing process's connection name, the statistics and server epoch, the copied relations (null: the table does not exist) and the coverage gaps then. */
interface Mark { v: typeof TOKEN_VERSION; app: string; stats_reset: string; postmaster: string; rels: Record<string, Rel | null>; gaps: number; gaps_max: string }

const READ_FAILED = 'read_failed';
const bounded = <T>(work: Promise<T>, onTimeout: T): Promise<T> => Promise.race([
  work,
  new Promise<T>((resolve) => { const t = setTimeout(() => resolve(onTimeout), SEAL_READ_MS); (t as { unref?: () => void }).unref?.(); }),
]);

const isCount = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
const isRel = (v: unknown): v is Rel => { const r = v as Rel; return !!r && typeof r === 'object' && isCount(r.oid) && isCount(r.relfilenode) && isCount(r.ins) && isCount(r.upd) && isCount(r.del); };
const isMark = (v: unknown): v is Mark => {
  const m = v as Mark;
  return !!m && typeof m === 'object' && m.v === TOKEN_VERSION && typeof m.app === 'string' && typeof m.stats_reset === 'string' && typeof m.postmaster === 'string'
    && !!m.rels && typeof m.rels === 'object' && !Array.isArray(m.rels) && Object.values(m.rels).every((r) => r === null || isRel(r))
    && Number.isInteger(m.gaps) && typeof m.gaps_max === 'string';
};

/**
 * Server facts: the version, whether counters are kept (this session's setting, and any database or role setting for
 * this database that turns `track_counts` off: a connection opened later gets it), this connection's name, and the
 * statistics and server epoch. The snapshot of statistics is dropped first, so the counters read next are current.
 */
const FACTS_SQL = `SELECT current_setting('server_version_num')::int AS version, current_setting('track_counts') AS track_counts,
  EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) AS c
    WHERE s.setdatabase IN (0, (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()))
      AND c ~* '^track_counts=' AND c !~* '^track_counts=(on|true|yes|1|t|tr|tru|y|ye)$') AS counts_role_off,
  current_setting('application_name') AS app,
  coalesce((SELECT extract(epoch FROM stats_reset)::text FROM pg_catalog.pg_stat_database WHERE datname = current_database()), '') AS stats_reset,
  extract(epoch FROM pg_catalog.pg_postmaster_start_time())::text AS postmaster`;

/**
 * Who could have written, or still be about to be seen writing. $1 connection names left out of the open-write check,
 * $2 connection names left out of the other checks (backends that are idle and settled, or hidden from this role, show
 * `state` and `application_name` as NULL and are counted: hidden means unknown).
 *  writing  another backend has a transaction with a write open (a transaction id is assigned at the first write);
 *  prepared a prepared transaction exists in this database (it holds locks and has no backend);
 *  live     a connection the hooks recorded as a writer is still connected, however old its row (its next write may not
 *           leave a new row);
 *  recent   another client connection is not idle or went idle less than SETTLE_SECONDS ago;
 *  gaps     the coverage-gap rows.
 */
const ACTIVITY_SQL = `SELECT
  (SELECT count(*)::int FROM pg_catalog.pg_stat_activity a WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
    AND a.backend_xid IS NOT NULL AND a.backend_type <> 'autovacuum worker' AND NOT (coalesce(a.application_name, '') = ANY($1::text[]))) AS writing,
  (SELECT count(*)::int FROM pg_catalog.pg_prepared_xacts WHERE database = current_database()) AS prepared,
  (SELECT count(*)::int FROM engine_writer_sessions s WHERE NOT (s.application_name = ANY($2::text[]))
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a WHERE a.pid = s.backend_pid AND a.datname = current_database())) AS live,
  (SELECT count(*)::int FROM pg_catalog.pg_stat_activity a WHERE a.datname = current_database() AND a.backend_type = 'client backend' AND a.pid <> pg_backend_pid()
    AND NOT (coalesce(a.application_name, '') = ANY($2::text[]))
    AND (a.state IS DISTINCT FROM 'idle' OR a.state_change IS NULL OR a.state_change > clock_timestamp() - interval '${SETTLE_SECONDS} seconds')) AS recent,
  (SELECT count(*)::int FROM engine_writer_coverage_gaps) AS gaps,
  (SELECT coalesce(max(created_at)::text, '') FROM engine_writer_coverage_gaps) AS gaps_max`;

/** The copied relations that exist (as ordinary tables of the current schema), with identity and counters. $1 names. */
const RELS_SQL = `SELECT c.relname::text AS name, c.oid::text AS oid, c.relfilenode::text AS relfilenode,
  coalesce(t.n_tup_ins, 0)::text AS ins, coalesce(t.n_tup_upd, 0)::text AS upd, coalesce(t.n_tup_del, 0)::text AS del
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_catalog.pg_stat_user_tables t ON t.relid = c.oid
  WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname::text = ANY($1::text[])`;

type Observed = Omit<Mark, 'v'>;

/**
 * The common read of a seal and of its check, in the order the refusals are decided: server and counters, then who is
 * connected or writing, then the relations. `mark` is null at the seal; at the check it is the seal's token, whose
 * connection name (the sealing process, finished by now) is left out of the activity checks as well as this one's.
 */
async function observe(tx: BrainEngine, query: ReadQuery, names: string[], mark: Mark | null): Promise<Observed | { refused: string }> {
  await query('SELECT pg_catalog.pg_stat_clear_snapshot()');
  const [facts] = await query(FACTS_SQL);
  if (!facts || typeof facts.version !== 'number' || !Number.isInteger(facts.version) || typeof facts.app !== 'string' || typeof facts.stats_reset !== 'string' || typeof facts.postmaster !== 'string') return { refused: 'mark_unreadable' };
  if (facts.version < MIN_SERVER_VERSION) return { refused: 'postgres_version_old' };
  if (String(facts.track_counts).toLowerCase() !== 'on' || facts.counts_role_off !== false) return { refused: 'track_counts_off' };
  const settled = mark ? [facts.app, mark.app] : [facts.app];
  const [act] = await query(ACTIVITY_SQL, [mark ? [] : [facts.app], settled]);
  if (!act) return { refused: 'mark_unreadable' };
  if (act.writing !== 0) return { refused: 'other_writer_open' };
  if (act.prepared !== 0) return { refused: 'prepared_transaction' };
  if (act.live !== 0) return { refused: 'other_writer_live' };
  if (act.recent !== 0) return { refused: 'other_backend_recent' };
  const found = new Map((await query(RELS_SQL, [names])).map((r) => [r.name as string, r as unknown as Rel]));
  const rels: Record<string, Rel | null> = {};
  for (const name of names) { const r = found.get(name); rels[name] = r && isRel(r) ? { oid: r.oid, relfilenode: r.relfilenode, ins: r.ins, upd: r.upd, del: r.del } : null; }
  if (typeof act.gaps !== 'number' || !Number.isInteger(act.gaps) || typeof act.gaps_max !== 'string') return { refused: 'mark_unreadable' };
  return { app: facts.app, stats_reset: facts.stats_reset, postmaster: facts.postmaster, rels, gaps: act.gaps, gaps_max: act.gaps_max };
}

/** A login role that can write a brain table but has no complete way to record evidence refuses (writer-observations.ts `uncovered_roles`). */
async function uncoveredWriterRoles(tx: BrainEngine): Promise<boolean> {
  return (await readWriterEvidence(tx, new Date(), true, WRITER_HOOK_TRIGGER, WRITER_EVIDENCE_TABLES)).uncovered_roles !== 0;
}

/** What differs between the token's relations and these, as a reason: a statistics epoch or server restart first, then identity, then the counters. */
function changed(mark: Mark, now: Observed): string | null {
  if (now.stats_reset !== mark.stats_reset) return 'stats_reset_changed';
  if (now.postmaster !== mark.postmaster) return 'postmaster_restarted';
  const names = Object.keys(mark.rels);
  for (const name of names) {
    const was = mark.rels[name]!, is = now.rels[name]!;
    if (was !== null && is === null) return 'relation_missing';
    if (was === null && is !== null) return 'relation_added';
  }
  for (const name of names) if (mark.rels[name] !== null && mark.rels[name]!.oid !== now.rels[name]!.oid) return 'relation_oid_changed';
  for (const name of names) if (mark.rels[name] !== null && mark.rels[name]!.relfilenode !== now.rels[name]!.relfilenode) return 'relfilenode_changed';
  const counters = (r: Rel): bigint[] => [BigInt(r.ins), BigInt(r.upd), BigInt(r.del)];
  const moved: boolean[] = [];
  for (const name of names) {
    const was = mark.rels[name], is = now.rels[name];
    if (!was || !is) continue;
    const a = counters(was), b = counters(is);
    if (b.some((n, i) => n < a[i]!)) return 'counter_decreased';
    moved.push(b.some((n, i) => n > a[i]!));
  }
  return moved.some(Boolean) ? 'writes_since_seal' : null;
}

/**
 * The mark to seal with: a token naming the database's write counters for the relations the seed copied (Postgres), or
 * the reason no seal may be written (PGLite; another process may still be writing, or is connected and may write
 * unrecorded; a role that cannot record its writes; counters not kept; no seed record; the hooks are not installed; the
 * read failed or timed out). The child keeps the token as it is and hands it back at the next start.
 */
export async function sealMark(d: Pick<SealDeps, 'dir' | 'reads' | 'postgres'>): Promise<SealMarkResult> {
  if (!d.postgres) return { refused: PGLITE_NO_DB_CONTINUITY };
  if (readWriterHooksManifest(d.dir)?.state !== 'installed') return { refused: 'hooks_not_installed' };
  const seed = readSeedRecord(d.dir);
  if (!seed) return { refused: 'seed_unreadable' };
  const copied = Object.entries(seed.relations ?? {});
  const required = copied.filter(([, r]) => !r?.absent).map(([name]) => name);
  const names = [...new Set([...copied.map(([name]) => name), ...SEAL_CARRIED_TABLES])];
  const read = d.reads.read(async (tx, query): Promise<SealMarkResult> => {
    await query('SET LOCAL row_security = off');
    const seen = await observe(tx, query, names, null);
    if ('refused' in seen) return seen;
    if (required.some((name) => seen.rels[name] === null)) return { refused: 'relation_missing' };
    if (await uncoveredWriterRoles(tx)) return { refused: 'uncovered_writer_role' };
    const mark: Mark = { v: TOKEN_VERSION, app: seen.app, stats_reset: seen.stats_reset, postmaster: seen.postmaster, rels: seen.rels, gaps: seen.gaps, gaps_max: seen.gaps_max };
    return isMark(mark) ? { token: JSON.stringify(mark) } : { refused: 'mark_unreadable' };
  }).catch((): SealMarkResult => ({ refused: READ_FAILED })); // silent-read-ok: a refusal is "no seal", so a failed read fails closed and the next session needs a full pass
  return bounded(read, { refused: 'read_timeout' });
}

/** Whether the database shows what the mark recorded (nobody wrote, nobody is about to be seen writing, no gap), with every hook still working. */
export async function quietSince(d: Pick<SealDeps, 'dir' | 'reads' | 'postgres'>, token: string | null): Promise<SealVerdict> {
  if (!d.postgres) return { ok: false, reason: PGLITE_NO_DB_CONTINUITY };
  if (readWriterHooksManifest(d.dir)?.state !== 'installed') return { ok: false, reason: 'hooks_not_installed' };
  let mark: unknown = null;
  try { mark = token === null ? null : JSON.parse(token); } catch { mark = null; } // silent-read-ok: an unreadable mark refuses the seal
  if (!isMark(mark)) return { ok: false, reason: 'mark_unreadable' };
  const was = mark;
  const read = d.reads.read(async (tx, query): Promise<SealVerdict> => {
    await query('SET LOCAL row_security = off');
    const seen = await observe(tx, query, Object.keys(was.rels), was);
    if ('refused' in seen) return { ok: false, reason: seen.refused };
    const moved = changed(was, seen);
    if (moved) return { ok: false, reason: moved };
    if (seen.gaps !== was.gaps || seen.gaps_max !== was.gaps_max) return { ok: false, reason: 'coverage_gap' };
    if (await uncoveredWriterRoles(tx)) return { ok: false, reason: 'uncovered_writer_role' };
    if (!await hooksIntact(tx)) return { ok: false, reason: 'hook_missing' };
    return { ok: true };
  }).catch((): SealVerdict => ({ ok: false, reason: READ_FAILED })); // silent-read-ok: a refusal keeps the obligation, so a failed read fails closed
  return bounded(read, { ok: false, reason: 'read_timeout' });
}

/**
 * Confirms (or refuses) the seal the owner child took over at its start, if there is one. Never rejects. A child that
 * took no seal, or a read that fails, changes nothing: the session's own full obligation stays until a full pass.
 * Once the child took a confirmation the check is read again: a write that began after the first read (and before the
 * child applied the verdict) makes the child withdraw the confirmation (`revokeSeal`), a failed second read included.
 */
export async function confirmSeal(d: SealDeps): Promise<void> {
  try {
    const state = await d.rpc<{ pending_seal?: { db_at: string | null } | null }>('state', {}, 10_000);
    const pending = state?.pending_seal;
    if (!pending) return;
    const verdict = await quietSince(d, pending.db_at ?? null);
    await d.rpc('confirmSeal', { db_at: pending.db_at ?? null, ok: verdict.ok, reason: verdict.ok ? null : verdict.reason }, 10_000);
    if (!verdict.ok) return;
    const again = await quietSince(d, pending.db_at ?? null);
    if (!again.ok) await d.rpc('revokeSeal', { reason: again.reason }, 10_000);
  } catch { /* the obligation stays: a full pass settles it */ }
}
