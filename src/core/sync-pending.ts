/**
 * GBRA-133 PR 2b.5: the oldest commit a source has not synced yet, and how long it has waited, for doctor
 * `managed_sync_latency` (managed and classic sources) and `source-health.ts` lag. A source whose sync stalled has no
 * new receipts, so a latency read from synced commits alone says nothing about it; this reads the commit that is
 * still waiting.
 *
 * A source is behind when its checkout HEAD differs from `sources.last_commit` (HEAD only: an uncommitted edit is not
 * a pending commit). The wait is dated, in order:
 *   1. the reflog: the time of the entry that first moved HEAD away from `last_commit` (`<git dir>/logs/HEAD`, read as
 *      a file). That is when the commit landed in the checkout, not its committer time, so a pulled old commit does
 *      not inflate the wait;
 *   2. the persisted `first_due_at` of the commit notifier (`sync_notifier_sources` while not idle, or a due freshness
 *      marker in `sync_wanted_markers`), current source incarnation only. It is the only clock for a caller that runs
 *      no git (a remote doctor) and for a checkout without a usable reflog;
 *   3. otherwise unknown, with the reason: `no_reflog` (no reflog entry reaches `last_commit`, which is an ancestor of
 *      HEAD) or `history_rewritten` (`last_commit` is not an ancestor of HEAD, or not in the repository).
 * Without git, a source the notifier never recorded as due reads `not_observed`, never current. Nothing is written.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { execFileBounded } from './bounded-child-exec.ts';
import { gitChildEnv } from './git-env.ts';
import { readCheckoutHead } from './checkout-head.ts';
import { enclosingGitMetadata } from './persistence/root-registry.ts';
import { missingTable } from './notifier/store.ts';

export type PendingState = 'current' | 'behind' | 'unknown' | 'not_observed' | 'never_synced';
export type PendingUnknownReason = 'no_reflog' | 'history_rewritten' | 'no_checkout';

export interface PendingCommit {
  source_id: string;
  state: PendingState;
  /** The checkout HEAD (git), or the notifier's observed HEAD without git. */
  head: string | null;
  synced_commit: string | null;
  /** When the oldest unsynced commit landed or was first due; null unless behind. */
  since: string | null;
  age_seconds: number | null;
  evidence: 'reflog' | 'first_due_at' | null;
  reason: PendingUnknownReason | null;
  first_due_at: string | null;
}

export interface PendingSource { id: string; root: string | null; last_commit: string | null }

/** At most this many trailing bytes of logs/HEAD are read (about 5,000 entries). */
const REFLOG_TAIL_BYTES = 1 << 20;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const ENTRY = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) .*? (\d+) [+-]\d{4}\t/;

function readTail(file: string): string | null {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, REFLOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return null; } finally { closeSync(fd); }
}

/** Unix seconds of the reflog entry that first moved HEAD away from `synced` after its last arrival there, or null. */
export function reflogDepartureSeconds(gitDir: string, synced: string): number | null {
  const text = readTail(join(gitDir, 'logs', 'HEAD'));
  if (!text) return null;
  const entries = text.split('\n').map(line => ENTRY.exec(line)).filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({ from: m[1]!, to: m[2]!, at: Number(m[3]) }));
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.to === synced) return entries[i + 1]?.at ?? null;
  }
  return entries.find(e => e.from === synced)?.at ?? null;
}

async function isAncestor(root: string, ancestor: string): Promise<boolean> {
  const r = await execFileBounded('git', ['-C', root, 'merge-base', '--is-ancestor', ancestor, 'HEAD'], { timeout: 10_000, env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0' }) });
  return r.error === null;
}

export interface GitPendingEvidence { head: string; behind: boolean; departedAt: number | null; reason: PendingUnknownReason | null }

/** One checkout: HEAD, whether it moved past `synced`, and when it left it (reflog). Null when no checkout can be read. */
export async function readGitPendingEvidence(root: string, synced: string): Promise<GitPendingEvidence | null> {
  const gitDir = enclosingGitMetadata(root);
  if (!gitDir || !existsSync(root)) return null;
  const checkout = await readCheckoutHead(root);
  if (!checkout) return null;
  if (checkout.head === synced) return { head: checkout.head, behind: false, departedAt: null, reason: null };
  const departedAt = reflogDepartureSeconds(gitDir, synced);
  if (departedAt !== null) return { head: checkout.head, behind: true, departedAt, reason: null };
  const reason: PendingUnknownReason = SHA.test(synced) && await isAncestor(root, synced) ? 'no_reflog' : 'history_rewritten';
  return { head: checkout.head, behind: true, departedAt: null, reason };
}

interface DueRow { source_id: string; first_due_at: unknown; observed_head: string | null }
export interface PersistedDue { firstDueAt: number | null; observedHead: string | null }

/** The notifier's persisted first_due_at per source (state not idle, or a due freshness marker), current incarnation only. */
export async function readFirstDue(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds: string[]): Promise<Map<string, PersistedDue>> {
  const out = new Map<string, PersistedDue>();
  if (!sourceIds.length) return out;
  let rows: DueRow[];
  try {
    rows = await engine.executeRaw<DueRow>(
      `SELECT s.id AS source_id, n.observed_head,
              LEAST(CASE WHEN n.state <> 'idle' THEN n.first_due_at END,
                    (SELECT min(m.first_due_at) FROM sync_wanted_markers m WHERE m.source_id = s.id AND m.intent = 'freshness'
                       AND m.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
                       AND (m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit))) AS first_due_at
         FROM sources s LEFT JOIN sync_notifier_sources n ON n.source_id = s.id AND n.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
        WHERE s.id = ANY($1::text[])`, [sourceIds]);
  } catch (error) {
    if (missingTable(error)) return out;
    throw error;
  }
  for (const row of rows) {
    const raw = row.first_due_at;
    const at = raw === null || raw === undefined ? NaN : (raw instanceof Date ? raw : new Date(String(raw))).getTime();
    out.set(row.source_id, { firstDueAt: Number.isFinite(at) ? at : null, observedHead: row.observed_head });
  }
  return out;
}

/**
 * The oldest unsynced commit of each source. `git: false` (a remote caller) reads only the database. With git, each
 * source costs one `rev-parse HEAD`, a file read of its reflog and, only when no reflog entry reaches
 * `last_commit`, one `merge-base --is-ancestor`.
 */
export async function readPendingCommits(engine: Pick<BrainEngine, 'executeRaw'>, sources: PendingSource[], opts: { git: boolean; nowMs?: number }): Promise<PendingCommit[]> {
  const nowMs = opts.nowMs ?? Date.now();
  const due = await readFirstDue(engine, sources.map(s => s.id));
  const iso = (ms: number) => new Date(ms).toISOString();
  return Promise.all(sources.map(async (source): Promise<PendingCommit> => {
    const persisted = due.get(source.id) ?? { firstDueAt: null, observedHead: null };
    const base = { source_id: source.id, synced_commit: source.last_commit, first_due_at: persisted.firstDueAt === null ? null : iso(persisted.firstDueAt),
      head: null as string | null, since: null as string | null, age_seconds: null as number | null, evidence: null as PendingCommit['evidence'], reason: null as PendingUnknownReason | null };
    const dated = (head: string | null, sinceMs: number, evidence: 'reflog' | 'first_due_at'): PendingCommit =>
      ({ ...base, state: 'behind', head, since: iso(sinceMs), age_seconds: Math.max(0, Math.round((nowMs - sinceMs) / 1000)), evidence });
    if (!source.last_commit) return { ...base, state: 'never_synced' };
    const git = opts.git && source.root ? await readGitPendingEvidence(source.root, source.last_commit).catch(() => null) : null;
    if (git && !git.behind) return { ...base, state: 'current', head: git.head };
    if (git && git.departedAt !== null) return dated(git.head, git.departedAt * 1000, 'reflog');
    if (persisted.firstDueAt !== null) return dated(git?.head ?? persisted.observedHead, persisted.firstDueAt, 'first_due_at');
    if (git) return { ...base, state: 'unknown', head: git.head, reason: git.reason };
    return { ...base, state: 'not_observed', head: persisted.observedHead, reason: opts.git && source.root ? 'no_checkout' : null };
  }));
}

export interface EmbedBacklog {
  source_id: string;
  /** disabled: a keyless brain (nothing will embed); behind: chunks wait for a vector; unknown: a waiting chunk has no pending-since stamp. */
  state: 'current' | 'behind' | 'unknown' | 'disabled';
  pending_chunks: number;
  oldest_pending_since: string | null;
  age_seconds: number | null;
}

/**
 * The embedding backlog of each source: live chunks of the published body generation without a vector in the active
 * embedding column (embed_skip pages excluded, as the doctor embeddings check counts them), aged from the oldest `content_chunks.embedding_pending_since`.
 */
export async function readEmbedBacklog(engine: BrainEngine, sourceIds: string[], opts: { nowMs?: number } = {}): Promise<Map<string, EmbedBacklog>> {
  const out = new Map<string, EmbedBacklog>();
  if (!sourceIds.length) return out;
  const nowMs = opts.nowMs ?? Date.now();
  const { embeddingsDisabled } = await import('./embedding-disabled.ts');
  if (await embeddingsDisabled(engine)) {
    for (const id of sourceIds) out.set(id, { source_id: id, state: 'disabled', pending_chunks: 0, oldest_pending_since: null, age_seconds: null });
    return out;
  }
  const { quoteIdentifier, resolveActiveEmbeddingColumnFromEngine } = await import('./search/embedding-column.ts');
  const { chunkGenerationFilter } = await import('./search/safe-chunks.ts');
  const column = quoteIdentifier((await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name);
  const rows = await engine.executeRaw<{ source_id: string; pending: unknown; unaged: unknown; oldest: unknown }>(
    `SELECT p.source_id, count(*)::int AS pending, count(*) FILTER (WHERE cc.embedding_pending_since IS NULL)::int AS unaged,
            min(cc.embedding_pending_since) AS oldest
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.${column} IS NULL AND p.deleted_at IS NULL AND p.source_id = ANY($1::text[]) AND ${chunkGenerationFilter('p', 'cc')}
        AND NOT jsonb_exists(COALESCE(p.frontmatter, '{}'::jsonb), 'embed_skip')
      GROUP BY p.source_id`, [sourceIds]);
  const byId = new Map(rows.map(row => [row.source_id, row]));
  for (const id of sourceIds) {
    const row = byId.get(id);
    const pending = Number(row?.pending ?? 0);
    const oldestMs = row?.oldest === null || row?.oldest === undefined ? NaN : (row.oldest instanceof Date ? row.oldest : new Date(String(row.oldest))).getTime();
    if (!pending) { out.set(id, { source_id: id, state: 'current', pending_chunks: 0, oldest_pending_since: null, age_seconds: null }); continue; }
    const aged = Number(row?.unaged ?? 0) === 0 && Number.isFinite(oldestMs);
    out.set(id, { source_id: id, state: aged ? 'behind' : 'unknown', pending_chunks: pending, oldest_pending_since: aged ? new Date(oldestMs).toISOString() : null,
      age_seconds: aged ? Math.max(0, Math.round((nowMs - oldestMs) / 1000)) : null });
  }
  return out;
}

export interface RosterSource extends PendingSource { managed: boolean }

/**
 * Every source whose commits sync: managed sources (bound worktree; the root is this host's binding, else the source
 * path) and classic sources with a local path, not archived and not sync-disabled. `sourceIds` confines it in SQL.
 */
export async function loadPendingRoster(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds?: string[]): Promise<RosterSource[]> {
  const { existingHostIdFor } = await import('./persistence/identity.ts');
  const { isSyncDisabledConfig } = await import('./sync-policy.ts');
  const rows = await engine.executeRaw<{ id: string; last_commit: string | null; root: string | null; managed: unknown; config: unknown }>(
    `SELECT s.id, s.last_commit, s.config, (b.source_id IS NOT NULL) AS managed, COALESCE(h.local_path, s.local_path) AS root
       FROM sources s
       LEFT JOIN persistence_source_bindings b ON b.source_id = s.id AND b.source_incarnation = s.incarnation
       LEFT JOIN persistence_host_bindings h ON h.worktree_id = b.worktree_id AND h.host_id::text = $2
      WHERE s.archived IS NOT TRUE AND (b.source_id IS NOT NULL OR s.local_path IS NOT NULL)
        AND ($1::text[] IS NULL OR s.id = ANY($1::text[]))
      ORDER BY s.id`, [sourceIds ?? null, existingHostIdFor(engine)]);
  return rows.filter(row => !isSyncDisabledConfig(row.config))
    .map(row => ({ id: row.id, last_commit: row.last_commit, root: row.root, managed: row.managed === true || row.managed === 't' }));
}
