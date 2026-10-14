/**
 * #6643: the `source_changed` conflict pile, made visible and kept from growing.
 *
 * A canonical file that diverged from its database row refuses every
 * coordinated write to it (`page-prepare.ts` `prepareFileTarget`, detail
 * `file_database_drift`) until someone reconciles it. Three readers share this
 * module:
 *
 *   - the audit (`gbrain sources reconcile <source> --audit --conflicts`, MCP
 *     `list_write_conflicts`): conflict receipts grouped by slug, read through a
 *     bounded window of request sequences (the request table's unique sequence
 *     index), paginated by slug with a completeness flag. Remote callers get
 *     database-derived fields only, filtered by source grant, slug fence and page
 *     visibility in the SQL that aggregates; the live file check runs only for a
 *     trusted local caller on the source's canonical owner host;
 *   - the maintenance producers (`prepared-maintenance.ts`, `synthesize_concepts`),
 *     which check `liveFileDrift` before admission or spend; the concept phase
 *     records each skip in `dream.concepts.drift_skips` with per-entry atomic
 *     updates and releases it once the file and database agree again;
 *   - doctor `maintenance_write_drift` and `gbrain repair file-drift`.
 */
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { normalizeSlugPrefix } from '../ops/context.ts';
import { resolveSourceLocalFilePath } from '../markdown.ts';
import { recordedPathFromFileUri, scannerSlugRootMode } from '../write-through.ts';
import { hardenedGitSync, hardenedPathDirty } from '../hardened-git.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { isValidSourceId } from '../source-id.ts';
import { validateSlug } from '../utils.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { sha256 } from './digest.ts';
import { existingLocalHostId } from './identity.ts';
import { getWorktreeBinding } from './ownership.ts';
import { prepareFileTarget } from './page-prepare.ts';
import { readReconcileState } from './reconcile-state.ts';
import { reconcileCanonical } from './reconcile-merge.ts';
import { classifyDrift } from './reconcile-additive.ts';

/** The refusal message `prepareFileTarget` stores on a drift conflict receipt (the detail is not kept on the row). */
export const FILE_DRIFT_MESSAGE = 'The canonical file contains an uncoordinated local edit.';
/** Separate from `dream.concepts.failed_attempts` (#6260): `{ "<source>:<slug>": { file_hash, db_revision, at } }`. */
export const DRIFT_SKIPS_KEY = 'dream.concepts.drift_skips';
export const CONFLICT_WINDOW_DEFAULT = 100_000;
export const CONFLICT_WINDOW_MAX = 1_000_000;

export const auditConflictsCommand = (sourceId: string) => `gbrain sources reconcile ${sourceId} --brain host --audit --conflicts`;
export const fileDriftRepairCommand = (sourceId: string) => `gbrain repair file-drift --source ${sourceId} --all-drifted --prefer file`;

/** The drift classes `--all-drifted` groups by (reconcile-additive.ts verdicts; `no_drift` reads as formatting only). */
export const DRIFT_CLASSES = ['structurally_additive', 'additive_with_suggestions', 'review_required', 'formatting_only', 'error'] as const;
export type DriftClass = typeof DRIFT_CLASSES[number];

/**
 * `still_present`: true when the canonical file still differs from the database
 * row, false when they agree (or the page publishes database-only), null when
 * this caller or host cannot tell; `reason` says which.
 */
export interface LiveDrift {
  still_present: boolean | null;
  reason: string;
  file_hash?: string;
  db_revision?: string;
  /** Source-relative path of the canonical file the check compared (trusted callers only). */
  path?: string;
}

/**
 * The live file/database comparison `prepareFileTarget` runs before a write,
 * without writing: a trusted local check on the source's active canonical owner
 * host. Honors database-only and read-only mirror policies (no file target: the
 * page cannot drift).
 */
export async function liveFileDrift(engine: BrainEngine, sourceId: string, slug: string, snapshot?: PageSnapshot | null): Promise<LiveDrift> {
  const hostId = existingLocalHostId();
  const binding = hostId ? await getWorktreeBinding(engine, sourceId, hostId) : null;
  if (!binding?.local_path || binding.owner_host_id !== hostId || binding.state !== 'active') return { still_present: null, reason: 'not_owner_host' };
  const page = snapshot === undefined ? await engine.readPageSnapshot(slug, { sourceId }) : snapshot;
  if (!page || page.page.deleted_at) return { still_present: null, reason: 'page_missing' };
  const root = join(binding.local_path, binding.relative_path);
  try {
    const file = await prepareFileTarget(engine, { source_id: sourceId, worktree_id: binding.worktree_id, slug }, page, null, hostId!);
    if (!file) return { still_present: false, reason: 'database_only', db_revision: page.revision };
    return { still_present: false, reason: 'agrees', db_revision: page.revision, path: relative(root, file.path).split(sep).join('/'),
      ...(file.expectedBeforeHash ? { file_hash: file.expectedBeforeHash } : {}) };
  } catch (error) {
    if (!(error instanceof OperationError)) return { still_present: null, reason: 'error' };
    if (error.detail !== 'file_database_drift') {
      return { still_present: null, reason: error.code === 'source_changed' ? 'file_missing' : error.code };
    }
    const path = await canonicalFilePath(engine, sourceId, root, page, slug);
    let file_hash: string | undefined;
    try { file_hash = sha256(readFileSync(path)); } catch { /* the hash is advisory */ }
    return { still_present: true, reason: 'file_database_drift', db_revision: page.revision, path: relative(root, path).split(sep).join('/'),
      ...(file_hash ? { file_hash } : {}) };
  }
}

/** The path `prepareFileTarget` compares, resolved the same way (recorded source path, captured file URI, then the slug path). */
async function canonicalFilePath(engine: BrainEngine, sourceId: string, root: string, snapshot: PageSnapshot, slug: string): Promise<string> {
  const mode = snapshot.page.source_path ? await scannerSlugRootMode(engine, sourceId, root) : undefined;
  const captured = recordedPathFromFileUri(snapshot.page.source_uri, root);
  return resolveSourceLocalFilePath(root, snapshot.page.source_path, slug, mode) ?? (captured ? join(root, captured) : join(root, `${slug}.md`));
}

/** Whether Git tracks the canonical file and whether its bytes equal the last commit (null: Git cannot say). */
function gitState(root: string, rel: string): { tracked: boolean | null; committed: boolean | null } {
  const listed = hardenedGitSync(root, ['ls-files', '-z', '--', `:(literal)${rel}`], { timeoutMs: 10_000, maxBytes: 1024 * 1024 });
  if (!listed.ok) return { tracked: null, committed: null };
  const tracked = listed.stdout.length > 0;
  if (!tracked) return { tracked, committed: false };
  const dirty = hardenedPathDirty(root, rel);
  return { tracked, committed: dirty === null ? null : !dirty };
}

/** The B0 class of one drifted page: its structural drift verdict, never values. */
export async function driftClass(engine: BrainEngine, sourceId: string, slug: string, adoptSlugPath = false): Promise<DriftClass> {
  try {
    const state = await readReconcileState(engine, sourceId, slug, undefined, { adoptSlugPath });
    const verdict = classifyDrift(state.file, reconcileCanonical(state.snapshot.page, state.snapshot.tags)).verdict;
    return verdict === 'no_drift' ? 'formatting_only' : verdict;
  } catch { return 'error'; }
}

export interface ConflictAuditAccess {
  /** `ctx.remote === false`: the live file check and local paths are allowed. */
  trusted: boolean;
  /** Sources this caller may read (undefined: every source). */
  sourceIds?: string[];
  /** Slug prefixes this caller is fenced to (undefined: unfenced). */
  slugPrefixes?: string[];
  /** Hide pages private to this caller. */
  excludePrivate: boolean;
}

export interface ConflictRow extends Record<string, unknown> {
  slug: string;
  receipts: number;
  drift_receipts: number;
  first_seen: string;
  last_seen: string;
  producers: string[];
  last_conflict_request_id?: string;
  last_committed: { request_id?: string; completed_at: string } | null;
  source_path?: string | null;
  git?: { tracked: boolean | null; committed: boolean | null };
  file_hash?: string;
  db_revision?: string;
  still_present: { value: boolean | null; reason: string };
  class?: DriftClass;
}

export interface ConflictAuditReport extends Record<string, unknown> {
  source_id: string;
  group_by: 'slug';
  window: { from_sequence: string; through_sequence: string; covers_history: boolean };
  conflicts: ConflictRow[];
  next: string | null;
  complete: boolean;
  totals: { slugs: number; receipts: number; still_present: number; checked: number };
  next_actions: string[];
}

const cursorPattern = /^(\d{1,19}):([A-Za-z0-9_-]*)$/;
function parseCursor(value: unknown): { through: bigint; after: string } | null {
  if (value === undefined) return null;
  const match = typeof value === 'string' ? cursorPattern.exec(value) : null;
  const after = match ? Buffer.from(match[2], 'base64url').toString('utf8') : '';
  if (!match || BigInt(match[1]) > 9_223_372_036_854_775_807n || (after && !validSlug(after))) {
    throw opError('invalid_params', 'Invalid conflict audit cursor.',
      "Pass the cursor exactly as the previous page's `next` value, or omit it to start from the first slug.");
  }
  return { through: BigInt(match[1]), after };
}
function validSlug(slug: string): boolean { try { validateSlug(slug); return true; } catch { return false; } }
const likeEscape = (value: string) => value.replace(/[\\%_]/g, char => `\\${char}`);

/**
 * Conflict receipts of one source grouped by slug. The rows scanned are the
 * newest `window` request sequences (through the first page's high-water mark,
 * which the cursor carries so later pages read the same window); `complete` is
 * true only when the window reaches the oldest receipt and no slug is left.
 */
export async function auditDriftConflicts(engine: BrainEngine, sourceId: string, access: ConflictAuditAccess,
  options: { limit?: number; cursor?: string; window?: number } = {}): Promise<ConflictAuditReport> {
  const limit = options.limit ?? 25;
  const window = options.window ?? CONFLICT_WINDOW_DEFAULT;
  if (!isValidSourceId(sourceId) || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(window) || window < 1 || window > CONFLICT_WINDOW_MAX) {
    throw opError('invalid_params', 'The conflict audit needs one source, a limit from 1 to 100 and a window from 1 to 1,000,000 request sequences.',
      `Pass a registered source id, limit 1-100 (default 25) and window 1-${CONFLICT_WINDOW_MAX} (default ${CONFLICT_WINDOW_DEFAULT}).`,
      { fix: readFix('Lists the registered sources and their IDs.', { argv: ['gbrain', 'sources', 'list', '--json'] }) });
  }
  const cursor = parseCursor(options.cursor);
  const [bounds] = await engine.executeRaw<{ top: string | null; bottom: string | null }>(
    'SELECT (SELECT max(sequence) FROM persistence_requests)::text AS top, (SELECT min(sequence) FROM persistence_requests)::text AS bottom');
  const through = cursor?.through ?? BigInt(bounds?.top ?? '0');
  const floor = through - BigInt(window);
  const coversHistory = bounds?.bottom == null || BigInt(bounds.bottom) > floor;
  const report: ConflictAuditReport = { source_id: sourceId, group_by: 'slug',
    window: { from_sequence: String(floor > 0n ? floor + 1n : 1n), through_sequence: String(through), covers_history: coversHistory },
    conflicts: [], next: null, complete: false, totals: { slugs: 0, receipts: 0, still_present: 0, checked: 0 }, next_actions: [] };
  if (access.sourceIds && !access.sourceIds.includes(sourceId)) { report.complete = true; return report; }
  const params: unknown[] = [sourceId, String(floor), String(through)];
  const where = [`r.source_id=$1`, `r.sequence > $2::bigint`, `r.sequence <= $3::bigint`, `r.state='conflict'`, `r.error_code='source_changed'`];
  const prefixes = access.slugPrefixes?.map(normalizeSlugPrefix).filter(Boolean);
  if (prefixes) {
    if (!prefixes.length) { report.complete = true; return report; }
    const alternatives = prefixes.map(base => {
      params.push(base.endsWith('/') ? `${likeEscape(base)}%` : likeEscape(base));
      const at = params.length;
      return base.endsWith('/') ? `lower(r.slug) LIKE $${at}` : `(lower(r.slug) = $${at} OR lower(r.slug) LIKE $${at} || '/%')`;
    });
    where.push(`(${alternatives.join(' OR ')})`);
  }
  if (!access.trusted || access.excludePrivate) {
    where.push(`EXISTS (SELECT 1 FROM pages p WHERE p.source_id=r.source_id AND p.slug=r.slug AND p.deleted_at IS NULL${access.excludePrivate ? ` AND ${privatePagesFilterFragment('p')}` : ''})`);
  }
  const filtered = where.join(' AND ');
  const [totals] = await engine.executeRaw<{ slugs: number; receipts: number }>(
    `SELECT count(DISTINCT r.slug)::int AS slugs, count(*)::int AS receipts FROM persistence_requests r WHERE ${filtered}`, params);
  report.totals.slugs = Number(totals?.slugs ?? 0);
  report.totals.receipts = Number(totals?.receipts ?? 0);
  params.push(cursor?.after ?? '', limit + 1, FILE_DRIFT_MESSAGE);
  const rows = await engine.executeRaw<{ slug: string; receipts: number; drift_receipts: number; first_seen: string; last_seen: string; producers: string[]; last_request_id: string }>(
    `SELECT r.slug, count(*)::int AS receipts, count(*) FILTER (WHERE r.error_message=$${params.length})::int AS drift_receipts,
        to_char(min(r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS first_seen,
        to_char(max(r.created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen,
        array_agg(DISTINCT r.operation || COALESCE(':' || (r.intent->>'kind'), '') ORDER BY r.operation || COALESCE(':' || (r.intent->>'kind'), '')) AS producers,
        (array_agg(r.request_id::text ORDER BY r.sequence DESC))[1] AS last_request_id
      FROM persistence_requests r WHERE ${filtered} AND r.slug > $${params.length - 2}
      GROUP BY r.slug ORDER BY r.slug LIMIT $${params.length - 1}`, params);
  const page = rows.slice(0, limit);
  const slugs = page.map(row => row.slug);
  // The newest committed receipt per slug, read through the slug intent index (receipts within retention).
  const committed = slugs.length ? await engine.executeRaw<{ slug: string; request_id: string; completed_at: string }>(
    `SELECT DISTINCT ON (r.slug) r.slug, r.request_id::text, to_char(r.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS completed_at
       FROM persistence_requests r WHERE r.source_id=$1 AND r.slug=ANY($2::text[]) AND r.intent IS NOT NULL AND NOT r.compacted AND r.state='committed'
      ORDER BY r.slug, r.sequence DESC`, [sourceId, slugs]) : [];
  const recorded = access.trusted && slugs.length ? await engine.executeRaw<{ slug: string; source_path: string | null; source_uri: string | null }>(
    'SELECT slug, source_path, source_uri FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL', [sourceId, slugs]) : [];
  const hostId = access.trusted ? existingLocalHostId() : null;
  const binding = hostId ? await getWorktreeBinding(engine, sourceId, hostId) : null;
  const owner = !!binding?.local_path && binding.owner_host_id === hostId && binding.state === 'active';
  const root = owner ? join(binding!.local_path!, binding!.relative_path) : null;
  for (const row of page) {
    const last = committed.find(entry => entry.slug === row.slug);
    const result: ConflictRow = { slug: row.slug, receipts: Number(row.receipts), drift_receipts: Number(row.drift_receipts),
      first_seen: row.first_seen, last_seen: row.last_seen, producers: row.producers ?? [],
      last_committed: last ? { ...(access.trusted ? { request_id: last.request_id } : {}), completed_at: last.completed_at } : null,
      still_present: { value: null, reason: access.trusted ? 'not_owner_host' : 'remote_caller' } };
    if (access.trusted) {
      const page = recorded.find(entry => entry.slug === row.slug);
      result.last_conflict_request_id = row.last_request_id;
      result.source_path = page?.source_path ?? null;
      if (root) {
        const live = await liveFileDrift(engine, sourceId, row.slug);
        report.totals.checked++;
        result.still_present = { value: live.still_present, reason: live.reason };
        if (live.file_hash) result.file_hash = live.file_hash;
        if (live.db_revision) result.db_revision = live.db_revision;
        if (live.path) result.git = gitState(root, live.path);
        if (live.still_present) {
          report.totals.still_present++;
          result.class = await driftClass(engine, sourceId, row.slug, !page?.source_path && !page?.source_uri);
        }
      }
    }
    report.conflicts.push(result);
  }
  const more = rows.length > limit;
  report.next = more ? `${through}:${Buffer.from(page[page.length - 1].slug, 'utf8').toString('base64url')}` : null;
  report.complete = !more && coversHistory;
  if (report.totals.slugs) {
    report.next_actions.push(access.trusted
      ? `Preview the resolution of every drifted page with ${fileDriftRepairCommand(sourceId)} (or --prefer database); it previews by default and writes nothing.`
      : 'The brain host operator resolves drifted pages with gbrain repair file-drift on the brain host; relay the slugs to the user.');
  }
  if (!coversHistory) report.next_actions.push(`Older receipts lie outside the ${window}-sequence window; widen it with --window (at most ${CONFLICT_WINDOW_MAX}).`);
  return report;
}

/** One drift skip entry: the file bytes and database revision the skip was recorded against. */
export interface DriftSkip { file_hash: string | null; db_revision: string | null; at: string }

/**
 * Records one skip with a single-statement update of its own key inside the JSON
 * object, so concurrent cycles never overwrite each other's entries. A stored
 * value that is not a JSON object is replaced.
 */
export async function recordDriftSkip(engine: BrainEngine, sourceId: string, slug: string, entry: Omit<DriftSkip, 'at'>): Promise<void> {
  const key = `${sourceId}:${slug}`;
  const value = JSON.stringify({ ...entry, at: new Date().toISOString() });
  try {
    await engine.executeRaw(`INSERT INTO config(key,value) VALUES($1, jsonb_build_object($2::text, $3::text::jsonb)::text)
      ON CONFLICT (key) DO UPDATE SET value = ((CASE WHEN jsonb_typeof(config.value::jsonb)='object' THEN config.value::jsonb ELSE '{}'::jsonb END)
        || jsonb_build_object($2::text, $3::text::jsonb))::text`, [DRIFT_SKIPS_KEY, key, value]);
  } catch {
    await engine.setConfig(DRIFT_SKIPS_KEY, JSON.stringify({ [key]: JSON.parse(value) }));
  }
}

/** Releases one skip (the file and database agree again, or the page left the phase); a no-op when absent. */
export async function releaseDriftSkip(engine: BrainEngine, sourceId: string, slug: string): Promise<void> {
  try {
    await engine.executeRaw(`UPDATE config SET value = (value::jsonb - $2::text)::text
      WHERE key=$1 AND jsonb_typeof(value::jsonb)='object' AND value::jsonb ? $2::text`, [DRIFT_SKIPS_KEY, `${sourceId}:${slug}`]);
  } catch { await engine.unsetConfig(DRIFT_SKIPS_KEY); }
}

/** Every recorded skip, keyed `<source>:<slug>`; a malformed value reads as none. */
export async function readDriftSkips(engine: BrainEngine): Promise<Record<string, DriftSkip>> {
  try {
    const parsed = JSON.parse(await engine.getConfig(DRIFT_SKIPS_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, Partial<DriftSkip>>).filter(([, entry]) => entry && typeof entry === 'object')
      .map(([key, entry]) => [key, { file_hash: entry.file_hash ?? null, db_revision: entry.db_revision ?? null, at: String(entry.at ?? '') }]));
  } catch { return {}; }
}

/**
 * One `synthesize_concepts` run's view of the drift skips (B1): `skip` checks a
 * concept live before any spend and records or releases its entry; `finish`
 * re-checks recorded skips this run did not reach and returns the next actions.
 * Inactive (never skips) without a managed binding.
 */
export class ConceptDriftSkips {
  readonly skipped: string[] = [];
  private constructor(private engine: BrainEngine, private sourceId: string, private active: boolean, private dryRun: boolean,
    private recorded: Record<string, DriftSkip>) {}

  static async load(engine: BrainEngine, sourceId: string, active: boolean, dryRun: boolean): Promise<ConceptDriftSkips> {
    return new ConceptDriftSkips(engine, sourceId, active, dryRun, active ? await readDriftSkips(engine) : {});
  }

  async skip(slug: string, snapshot: PageSnapshot | null | undefined): Promise<boolean> {
    if (!this.active || !snapshot) return false;
    const drift = await liveFileDrift(this.engine, this.sourceId, slug, snapshot);
    if (drift.still_present === true) {
      this.skipped.push(slug);
      if (!this.dryRun) await recordDriftSkip(this.engine, this.sourceId, slug, { file_hash: drift.file_hash ?? null, db_revision: drift.db_revision ?? null });
      return true;
    }
    const key = `${this.sourceId}:${slug}`;
    if (this.recorded[key] && drift.still_present === false) {
      delete this.recorded[key];
      if (!this.dryRun) await releaseDriftSkip(this.engine, this.sourceId, slug);
    }
    return false;
  }

  async finish(): Promise<string[]> {
    if (this.active && !this.dryRun) {
      for (const key of Object.keys(this.recorded)) {
        const slug = key.startsWith(`${this.sourceId}:`) ? key.slice(this.sourceId.length + 1) : null;
        if (!slug || this.skipped.includes(slug)) continue;
        if ((await liveFileDrift(this.engine, this.sourceId, slug)).still_present !== true) await releaseDriftSkip(this.engine, this.sourceId, slug);
      }
    }
    return this.skipped.length ? [`List them: ${auditConflictsCommand(this.sourceId)}`,
      `Preview the resolution: ${fileDriftRepairCommand(this.sourceId)} (or --prefer database); apply with the --expect hash it prints.`] : [];
  }
}
