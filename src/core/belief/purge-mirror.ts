/**
 * The text-free purge mirror and restore-time purge replay
 * (docs/designs/BELIEF_LEDGER.md section 8).
 *
 * Every owner-requested purge appends an `intent` line to
 * `<brain home>/purge-events.jsonl` (0600) and fsyncs it before its
 * transaction commits, and a `committed` line after. A line names the request,
 * the source and its incarnation, the scope, the fingerprints and content
 * hashes, the page lifetimes and the purge_epoch it commits; never claim text.
 * The mirror is a superset of committed purges: a purge that rolled back may
 * leave an intent line with no committed line.
 *
 * A restore (PGLite: `restorePgliteBackup`; Postgres: `replayPurgesFromDatabase`,
 * the `gbrain beliefs replay-purges` step) replays every committed purge newer
 * than the archive for a matching source incarnation: tombstones, the restored
 * rows' removal, the standard ledger redaction, and one `fact.purged` or
 * `page.purged` with cause `restore_replay` naming the original request. Each
 * replay records `complete` (a restored row held the text and the carrying-field
 * pass ran), `partial` (no restored row matched: tombstones and key-level
 * redaction only) or `unverified` (an intent line with no committed line, not
 * replayed). `coverage.restored` carries the outcome, or `purge_replay:
 * 'unavailable'` when no mirror could be read.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { configDir } from '../config.ts';
import { opError } from '../ops/contract.ts';
import { COVERAGE_KEY, factKey, pageKey, slugRef } from './keys.ts';
import { appendBeliefEvents, type BeliefEventDraft } from './append.ts';
import { appendDerivedHidden, bumpPurgeEpoch, derivedBeliefTargets, pageLifetimesOf, pagePurgeClaims, redactCarryingFields, redactPurgedKeys, registerLiveCarriers } from './purge.ts';
import { derivedRowsFrom, hideDerivedRows, type DerivationRef } from '../facts/derivation-inputs.ts';

export const PURGE_MIRROR_FILE = 'purge-events.jsonl';

export type PurgeReplayFault = 'skip_replay' | 'replay_uncommitted' | 'always_complete';
let replayFault: PurgeReplayFault | null = null;
/** Forced-probe seam (section 11): a deliberately broken replay the restore probes must catch. Null restores it. */
export function __setPurgeReplayFaultForTests(fault: PurgeReplayFault | null): void { replayFault = fault; }

export interface PurgeMirrorFact { fact_hash: string; visibility: string; subject: string }
export interface PurgeMirrorIntent {
  kind: 'intent'; request: string; request_id: string; source_id: string; source_incarnation: string; scope: 'fact' | 'page';
  recorded_at: string; purge_epoch: number; slug?: string; content_hashes?: string[]; facts: PurgeMirrorFact[]; takes: string[]; lifetimes: string[];
}
export type PurgeMirrorLine = PurgeMirrorIntent | { kind: 'committed'; request: string; recorded_at: string };

export const purgeMirrorPath = (home = configDir()) => join(home, PURGE_MIRROR_FILE);

function writeMirrorLine(line: Record<string, unknown>, home: string): void {
  const path = purgeMirrorPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ ...line, recorded_at: new Date().toISOString() })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(path, 0o600);
}

/**
 * Appends and fsyncs the `intent` line inside the purge transaction, before it commits. A mirror that cannot be
 * written refuses the purge with the typed `purge_mirror_unwritable` (review #22): committing without the line would
 * let a later restore bring the content back silently.
 */
export function appendPurgeIntent(line: Omit<PurgeMirrorIntent, 'recorded_at' | 'kind'>, home = configDir()): void {
  try { writeMirrorLine({ kind: 'intent', ...line }, home); }
  catch (error) {
    throw opError('purge_mirror_unwritable', 'This purge could not record itself in the purge mirror, so nothing was purged.',
      `${purgeMirrorPath(home)} could not be written (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}). Make it a writable file owned by the brain's user (mode 0600), then run the purge again with a new request_id.`);
  }
}

/** Appends the `committed` line after the purge committed (the coordinator's after-commit step for a page purge). Best effort: a missing line reads as `unverified` at restore. */
export function appendPurgeCommitted(request: string, home = configDir()): boolean {
  try { writeMirrorLine({ kind: 'committed', request }, home); return true; } catch { return false; }
}

/**
 * Reads a mirror. Null when it cannot be read: the file is unreadable or
 * corrupt, or neither it nor the brain home it lives in exists. A brain home
 * without the file never purged, so it reads as empty.
 */
export function readPurgeMirror(path: string): PurgeMirrorLine[] | null {
  if (!existsSync(path)) return existsSync(join(dirname(path), 'config.json')) ? [] : null;
  try {
    return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as PurgeMirrorLine);
  } catch { return null; }
}

export type ReplayOutcome = 'complete' | 'partial' | 'unverified';
export interface ReplayRecord { request: string; request_id: string; scope: string; outcome: ReplayOutcome }
export type PurgeReplayState = 'none' | 'complete' | 'partial' | 'unverified' | 'unavailable';

const RANK: Record<PurgeReplayState, number> = { none: 0, complete: 1, partial: 2, unverified: 3, unavailable: 4 };
export const replayState = (records: readonly ReplayRecord[]): PurgeReplayState =>
  records.reduce<PurgeReplayState>((worst, r) => RANK[r.outcome] > RANK[worst] ? r.outcome : worst, 'none');

/**
 * One replayed purge inside the restore transaction. No other process can reach the restored database, so it takes no page keys.
 * `ledger` is false for an archive older than the ledger (schema before v249): tombstones and row removal replay, the ledger passes do not.
 * Rows derived from the purged ones are hidden again and, with a ledger, get their `derived.hidden`; a walk that cannot run
 * (no derivation table) or hits its bound makes the replay `partial`.
 */
async function replayOne(tx: BrainEngine, intent: PurgeMirrorIntent, ledger: boolean): Promise<ReplayOutcome> {
  const src = intent.source_id, actor = 'restore_replay', publicationId = randomUUID();
  await tx.executeRaw("SELECT set_config('gbrain.write_sources', $1, true)", [JSON.stringify([src])]);
  if (ledger) await bumpPurgeEpoch(tx, src);
  for (const f of intent.facts) {
    await tx.executeRaw(`INSERT INTO fact_purges(source_id,visibility,subject,fact_hash,request_id,actor,reason) VALUES ($1,$2,$3,$4,$5::uuid,$6,'restore replay')
      ON CONFLICT DO NOTHING`, [src, f.visibility, f.subject, f.fact_hash, intent.request, actor]);
  }
  const takeHashes = [...new Set([...intent.takes, ...(intent.scope === 'fact' ? intent.facts.map(f => f.fact_hash) : [])])];
  for (const hash of takeHashes) {
    await tx.executeRaw('INSERT INTO take_purges(source_id,subject,claim_hash,request_id) VALUES ($1,$2,$3,$4::uuid) ON CONFLICT DO NOTHING',
      [src, intent.scope === 'page' ? intent.slug : intent.facts[0]?.subject ?? '*', hash, intent.request]);
  }
  if (intent.content_hashes?.length) {
    await tx.executeRaw(`INSERT INTO page_purges(source_id,content_hash,slug,request_id) SELECT $1,h,$3,$4::uuid FROM unnest($2::text[]) AS h
      ON CONFLICT (source_id,content_hash) DO UPDATE SET slug=EXCLUDED.slug,request_id=EXCLUDED.request_id`, [src, intent.content_hashes, intent.slug, intent.request]);
  }
  const fps = [...new Set([...intent.facts.map(f => f.fact_hash), ...intent.takes])];
  let claims: string[] = [];
  let lifetimes = intent.lifetimes;
  let inputs: DerivationRef[] = [];
  let removeRows = async () => {};
  if (intent.scope === 'page' && intent.slug) {
    const [page] = await tx.executeRaw<{ id: number; slug: string }>(`SELECT p.id, p.slug FROM pages p WHERE p.source_id = $1 AND (p.content_hash = ANY($2::text[])
        ${ledger ? 'OR p.id IN (SELECT l.page_id FROM belief_page_lifetimes l WHERE l.source_id = $1 AND l.page_lifetime = ANY($3::uuid[]))' : 'OR $3::uuid[] IS NULL'})
      ORDER BY (p.slug = $4) DESC, p.id LIMIT 1`, [src, intent.content_hashes ?? [], intent.lifetimes, intent.slug]);
    if (page) {
      const restored = { id: Number(page.id), slug: page.slug };
      if (ledger) lifetimes = [...new Set([...lifetimes, ...await pageLifetimesOf(tx, src, restored.slug, restored.id)])];
      claims = (await pagePurgeClaims(tx, { sourceId: src, slug: restored.slug, pageId: restored.id, lifetimes: ledger ? lifetimes : [] })).claims;
      const owned = await tx.executeRaw<{ t: string; id: number }>(`SELECT 'facts' AS t, id FROM facts WHERE source_id = $1 AND source_markdown_slug = $2
        UNION ALL SELECT 'takes', id FROM takes WHERE page_id = $3`, [src, restored.slug, restored.id]);
      inputs = [{ table: 'pages', id: restored.id }, ...owned.map(r => ({ table: r.t, id: Number(r.id) }))];
      removeRows = async () => {
        await tx.executeRaw('DELETE FROM facts WHERE source_id = $1 AND source_markdown_slug = $2', [src, restored.slug]);
        const { deletePageWithSegments } = await import('../persistence/page-purge.ts');
        await deletePageWithSegments(tx, src, restored.slug, restored.id);
      };
    }
  } else {
    const scope = intent.facts[0] ?? { fact_hash: '', visibility: 'world', subject: '*' };
    const rows = await tx.executeRaw<{ id: number; fact: string; slug: string | null }>(`SELECT id, fact, source_markdown_slug AS slug FROM facts WHERE source_id = $1
      AND gbrain_fact_fingerprint(fact) = $2 AND visibility = $3 AND ($4 = '*' OR entity_slug = $4)`, [src, scope.fact_hash, scope.visibility, scope.subject]);
    const takes = await tx.executeRaw<{ id: number; claim: string; page_id: number }>(`SELECT k.id, k.claim, k.page_id FROM takes k JOIN pages p ON p.id = k.page_id
      WHERE p.source_id = $1 AND gbrain_fact_fingerprint(k.claim) = $2 AND ($3 = '*' OR p.slug = $3)`, [src, scope.fact_hash, scope.subject]);
    claims = [...new Set([...rows.map(r => r.fact), ...takes.map(t => t.claim)])];
    inputs = [...rows.map(r => ({ table: 'facts', id: Number(r.id) })), ...takes.map(t => ({ table: 'takes', id: Number(t.id) }))];
    if (claims.length) removeRows = async () => {
      const { rewritePageBodies, redactPageVersions, purgeSegmentStorage, stagingsHoldingClaim } = await import('../facts/purge.ts');
      const pages = await tx.executeRaw<{ slug: string; page_id: number; revision: string }>(`SELECT slug, id AS page_id, knowledge_revision::text AS revision FROM pages
        WHERE source_id = $1 AND (slug = ANY($2::text[]) OR id = ANY($3::int[]))`, [src, rows.map(r => r.slug).filter(Boolean), takes.map(t => Number(t.page_id))]);
      const staged = [];
      for (const claim of claims) staged.push(await stagingsHoldingClaim(tx, src, claim));
      await tx.executeRaw('DELETE FROM takes WHERE id = ANY($1::bigint[])', [takes.map(t => Number(t.id))]);
      await tx.executeRaw('DELETE FROM facts WHERE id = ANY($1::bigint[])', [rows.map(r => Number(r.id))]);
      const bodies = await rewritePageBodies(tx, src, pages.map(p => ({ ...p, page_id: Number(p.page_id) })));
      const segmented = new Set(bodies.segmented), replaced = [...bodies.replaced];
      for (const claim of claims) {
        const versions = await redactPageVersions(tx, src, claim, pages.map(p => Number(p.page_id)));
        for (const id of versions.segmentedPages) segmented.add(id);
        replaced.push(...versions.replaced);
      }
      // As purge_fact does (spec 11): segment texts that held the claim go now, not at GC, with the stagings holding them.
      for (const [i, claim] of claims.entries()) await purgeSegmentStorage(tx, src, claim, staged[i]!, [...segmented], replaced, intent.request);
    };
  }
  const walkable = (await tx.executeRaw<{ present: boolean }>("SELECT to_regclass('derivation_inputs') IS NOT NULL AS present"))[0]?.present === true;
  const purgedHere = new Set(inputs.map(r => `${r.table}:${r.id}`));
  const walk = walkable && inputs.length ? await derivedRowsFrom(tx, inputs) : { rows: [], truncated: false };
  const derivedRows = walk.rows.filter(r => !purgedHere.has(`${r.table}:${r.id}`));
  const targets = ledger ? await derivedBeliefTargets(tx, src, derivedRows) : [];
  await hideDerivedRows(tx, derivedRows, { sourceId: src, requestId: intent.request, reason: 'restore replay' });
  await removeRows();
  const outcome: ReplayOutcome = (claims.length || replayFault === 'always_complete') && walkable && !walk.truncated ? 'complete' : 'partial';
  if (!ledger) return outcome;
  await redactPurgedKeys(tx, { sourceId: src, claimFps: fps, lifetimes });
  if (claims.length) {
    await redactCarryingFields(tx, { sourceId: src, request: intent.request, claims });
    await registerLiveCarriers(tx, { sourceId: src, request: intent.request, claims });
  }
  await appendDerivedHidden(tx, { sourceId: src, request: intent.request, publicationId, op: 'restore_replay', targets, truncated: walk.truncated,
    cause: { cause: 'restore_replay' } });
  await appendBeliefEvents(tx, [await replayDraft(tx, intent, lifetimes, outcome)], { publicationId, origin: 'live', purgesPossible: true });
  return outcome;
}

async function replayDraft(tx: BrainEngine, intent: PurgeMirrorIntent, lifetimes: readonly string[], outcome: ReplayOutcome): Promise<BeliefEventDraft> {
  const cause = { op: 'restore_replay', cause: 'restore_replay', purge_request: intent.request, request_id: intent.request_id, outcome };
  const base = { sourceId: intent.source_id, incarnation: intent.source_incarnation, value: null, purged: true, trustTier: 'unknown', tierBasis: 'unknown' as const,
    visibility: 'world', stateHash: '', cause };
  if (intent.scope === 'page') {
    const lifetime = lifetimes[0] ?? null;
    return { ...base, lifetime, slug: intent.slug ?? '', subjectKind: 'page', subjectKey: lifetime ? pageKey(lifetime) : JSON.stringify(['p', slugRef(intent.source_incarnation, intent.slug ?? '')]),
      eventType: 'page.purged' };
  }
  const f = intent.facts[0]!;
  const [known] = await tx.executeRaw<{ subject_key: string; slug: string; page_lifetime: string | null }>(`SELECT subject_key, slug, page_lifetime::text AS page_lifetime
    FROM belief_events WHERE source_id = $1 AND subject_kind = 'fact' AND claim_fp = $2 ORDER BY id DESC LIMIT 1`, [intent.source_id, f.fact_hash]);
  return { ...base, lifetime: known?.page_lifetime ?? null, slug: known?.slug ?? f.subject, subjectKind: 'fact', claimFp: f.fact_hash, eventType: 'fact.purged',
    subjectKey: known?.subject_key ?? factKey(slugRef(intent.source_incarnation, f.subject), f.fact_hash, f.visibility) };
}

export interface PurgeReplayResult { state: PurgeReplayState; replays: ReplayRecord[]; ledger?: 'absent' }

/**
 * Replays the purges newer than `archivedAt` for the restored database's sources (matching incarnation), in
 * recorded order, then appends `coverage.restored` naming the archive time and the outcome on every source with
 * coverage. `lines` null means no mirror could be read: `purge_replay: 'unavailable'`. An archive older than the
 * ledger (no `belief_events`) replays tombstones and row removal only and reports `ledger: 'absent'`. A purge whose
 * tombstones the restored database already holds (same request) is in the archive and is skipped. `allTimes` drops
 * the archive-time filter: the Postgres path reads a complete pre-restore database, where a purge that started
 * before the dump and committed after it has a `purged_at` below the archive time (review #10).
 */
export async function replayPurgesInRestore(tx: BrainEngine, input: { lines: PurgeMirrorLine[] | null; archivedAt: string; restoreId: string; allTimes?: boolean }):
  Promise<PurgeReplayResult> {
  const ledger = (await tx.executeRaw<{ present: boolean }>("SELECT to_regclass('belief_events') IS NOT NULL AS present"))[0]?.present === true;
  const sources = await tx.executeRaw<{ id: string; incarnation: string }>('SELECT id, incarnation::text AS incarnation FROM sources ORDER BY id');
  const replays: ReplayRecord[] = [];
  if (input.lines) {
    const committed = new Set(input.lines.filter(l => l.kind === 'committed').map(l => l.request));
    const seen = new Set<string>();
    const newer = input.lines.filter((l): l is PurgeMirrorIntent => l.kind === 'intent' && (input.allTimes || l.recorded_at > input.archivedAt)
      && sources.some(s => s.id === l.source_id && s.incarnation === l.source_incarnation));
    for (const intent of newer) {
      if (seen.has(intent.request)) continue;
      seen.add(intent.request);
      const [archived] = await tx.executeRaw<{ present: boolean }>(`SELECT (EXISTS (SELECT 1 FROM fact_purges WHERE request_id = $1::uuid)
        OR EXISTS (SELECT 1 FROM take_purges WHERE request_id = $1::uuid) OR EXISTS (SELECT 1 FROM page_purges WHERE request_id = $1::uuid)) AS present`, [intent.request]);
      if (archived?.present === true) continue;
      if (replayFault === 'skip_replay') continue;
      const outcome = committed.has(intent.request) || replayFault === 'replay_uncommitted' ? await replayOne(tx, intent, ledger) : 'unverified';
      replays.push({ request: intent.request, request_id: intent.request_id, scope: intent.scope, outcome });
    }
  }
  const state: PurgeReplayState = input.lines ? replayState(replays) : 'unavailable';
  if (!ledger) return { state, replays, ledger: 'absent' };
  for (const source of sources) {
    const [covered] = await tx.executeRaw<{ id: number }>(`SELECT id FROM belief_events WHERE source_id = $1 AND source_incarnation = $2::uuid AND subject_kind = 'coverage'
      LIMIT 1`, [source.id, source.incarnation]);
    if (!covered) continue;
    await appendBeliefEvents(tx, [{ sourceId: source.id, incarnation: source.incarnation, lifetime: null, slug: '', subjectKind: 'coverage', subjectKey: COVERAGE_KEY,
      eventType: 'coverage.restored', trustTier: 'unknown', tierBasis: 'unknown', visibility: 'world', value: null, stateHash: '',
      cause: { op: 'coverage.restored', restore_id: input.restoreId, archived_at: input.archivedAt, purge_replay: state,
        replays: replays.filter(r => newerFor(input.lines, r.request, source.id)) } }], { publicationId: randomUUID(), origin: 'live', purgesPossible: false });
  }
  return { state, replays };
}

const newerFor = (lines: PurgeMirrorLine[] | null, request: string, sourceId: string) =>
  !!lines?.some(l => l.kind === 'intent' && l.request === request && l.source_id === sourceId);

/** The last restore's purge replay per source (`coverage.restored`), for the doctor finding: anything but none/complete asks the user. */
export async function readRestorePurgeReplay(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Array<{ source_id: string; archived_at: string; purge_replay: PurgeReplayState;
  replays: ReplayRecord[]; recorded_at: string }>> {
  const rows = await engine.executeRaw<{ source_id: string; cause: unknown; recorded_at: string }>(`SELECT DISTINCT ON (e.source_id) e.source_id, e.cause, e.recorded_at
    FROM belief_events e JOIN sources s ON s.id = e.source_id AND s.incarnation = e.source_incarnation
    WHERE e.subject_kind = 'coverage' AND e.event_type = 'coverage.restored' ORDER BY e.source_id, e.id DESC`);
  return rows.map(r => {
    const cause = (typeof r.cause === 'string' ? JSON.parse(r.cause) : r.cause) as { archived_at: string; purge_replay: PurgeReplayState; replays?: ReplayRecord[] };
    return { source_id: r.source_id, archived_at: cause.archived_at, purge_replay: cause.purge_replay, replays: cause.replays ?? [], recorded_at: new Date(r.recorded_at).toISOString() };
  });
}

/**
 * The text-free intents of every purge a pre-restore database's tombstones (fact_purges, take_purges, page_purges) record,
 * grouped by request, each with its committed line. The database is complete by construction, so `purged_at` bounds nothing.
 */
export async function purgeLinesFromDatabase(preRestore: Pick<BrainEngine, 'executeRaw'>): Promise<PurgeMirrorLine[]> {
  const facts = await preRestore.executeRaw<{ request: string; source_id: string; visibility: string; subject: string; fact_hash: string; at: string }>(`SELECT
      request_id::text AS request, source_id, visibility, subject, fact_hash, purged_at::text AS at FROM fact_purges WHERE request_id IS NOT NULL`);
  const takes = await preRestore.executeRaw<{ request: string; source_id: string; claim_hash: string; at: string }>(`SELECT request_id::text AS request, source_id, claim_hash,
      purged_at::text AS at FROM take_purges WHERE request_id IS NOT NULL`);
  const pages = await preRestore.executeRaw<{ request: string; source_id: string; slug: string; content_hash: string; at: string }>(`SELECT request_id::text AS request,
      source_id, slug, content_hash, purged_at::text AS at FROM page_purges WHERE request_id IS NOT NULL`);
  const incarnations = new Map((await preRestore.executeRaw<{ id: string; incarnation: string }>('SELECT id, incarnation::text AS incarnation FROM sources'))
    .map(s => [s.id, s.incarnation]));
  const intents = new Map<string, PurgeMirrorIntent>();
  const intentFor = (request: string, sourceId: string, at: string) => {
    const existing = intents.get(request);
    if (existing) return existing;
    const created: PurgeMirrorIntent = { kind: 'intent', request, request_id: request, source_id: sourceId, source_incarnation: incarnations.get(sourceId) ?? '',
      scope: 'fact', recorded_at: new Date(at).toISOString(), purge_epoch: 0, facts: [], takes: [], lifetimes: [] };
    intents.set(request, created);
    return created;
  };
  for (const p of pages) { const i = intentFor(p.request, p.source_id, p.at); i.scope = 'page'; i.slug = p.slug; i.content_hashes = [...(i.content_hashes ?? []), p.content_hash]; }
  for (const f of facts) intentFor(f.request, f.source_id, f.at).facts.push({ fact_hash: f.fact_hash, visibility: f.visibility, subject: f.subject });
  for (const t of takes) intentFor(t.request, t.source_id, t.at).takes.push(t.claim_hash);
  return [...intents.values()].sort((a, b) => a.recorded_at < b.recorded_at ? -1 : 1)
    .flatMap(i => [i, { kind: 'committed' as const, request: i.request, recorded_at: i.recorded_at }]);
}

/**
 * Postgres restores happen outside gbrain: `gbrain beliefs replay-purges` replays `lines` (a purge mirror or a pre-restore
 * database's tombstones) into the restored database, every purge the restored database does not already hold, whatever its
 * time; `archivedAt` is the archive time `coverage.restored` names. Without `apply` the same replay runs in a transaction
 * that rolls back, so the preview is exactly what `--apply` writes.
 */
export async function replayPurges(restored: BrainEngine, input: { lines: PurgeMirrorLine[] | null; archivedAt: string; apply: boolean }): Promise<PurgeReplayResult> {
  const preview = new Error('replay preview rolled back');
  let result: PurgeReplayResult | undefined;
  try {
    await restored.transaction(async tx => {
      result = await replayPurgesInRestore(tx, { lines: input.lines, archivedAt: new Date(input.archivedAt).toISOString(), restoreId: randomUUID(), allTimes: true });
      if (!input.apply) throw preview;
    });
  } catch (error) { if (error !== preview) throw error; }
  return result!;
}

/** `replayPurges` from a pre-restore database, applied. */
export async function replayPurgesFromDatabase(restored: BrainEngine, preRestore: Pick<BrainEngine, 'executeRaw'>, archivedAt: string): Promise<PurgeReplayResult> {
  return replayPurges(restored, { lines: await purgeLinesFromDatabase(preRestore), archivedAt, apply: true });
}
