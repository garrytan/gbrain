/**
 * #6729: inexact Git renames a sync could not confirm (see sync-rename-identity.ts) were split into a delete plus an
 * add, so the old page's facts, links and aliases stay on its soft-deleted slug. Each one is recorded here until the
 * pair gets a disposition: `gbrain sync status --json` lists it, doctor `rename_identity_downgrades` names it, the purge
 * leaves its old page alone and the checkpoint sweep keeps the record while it is open, and the report names the
 * restore of the old page. There is no time window: a pair recorded before its remedy exists can still be repaired.
 *
 * One `op_checkpoints` row per old page (op `sync-identity-downgrade`, fingerprint = the old page id);
 * `completed_keys[0]` holds the record. A record is open while it has no `disposition` (set when the pair is remedied
 * or closed without merging) and its old page is still soft-deleted from that sync (`deleted_at` = `old_deleted_at`);
 * a restore, a purge or a later delete of the restored page closes it.
 *
 * Every surface names the remedy per pair (`identityRemedy`): the preview `gbrain repair rename-identity --source <id>
 * --slug <new>`, its apply with the plan hash (destructive consent), and what releases the purge hold. On a managed brain
 * carrying identity is unavailable (`managed_remedy_unavailable`), so the remedy there is `--close`.
 */
import type { BrainEngine } from './engine.ts';
import { isConnectorSourceKind } from './persistence/connector-identity.ts';
import { getWorktreeBinding } from './persistence/ownership.ts';
import { readDatabaseOnlyActivatedSources } from './persistence/unbound-source.ts';
import { readManagedMode } from './persistence/managed-mode.ts';
import { previewHash } from './persistence/preview-approval.ts';
import { canonicalOriginPage, pickCanonicalOrigin } from './persistence/origin-guard.ts';
import { resolveSlugForPath, type DowngradedRename, type RenameDowngradeReason } from './sync.ts';

export const IDENTITY_DOWNGRADE_OP = 'sync-identity-downgrade';

export interface IdentityDowngrade extends DowngradedRename {
  source_id: string;
  /** The soft-deleted page the old file backed, and the page the new file imported to (null when it did not import). */
  old_slug: string; old_page_id: number; new_slug: string | null;
  /** What stays on the old slug: facts keyed to it, links from or to it, and its free-text aliases. */
  facts: number; links: number; aliases: number;
  /** When the old page was soft-deleted (ISO), and that `deleted_at` exactly as Postgres printed it (the open test). */
  recorded_at: string; old_deleted_at: string;
  /** Set when the pair is remedied or closed without merging; the record is then closed. */
  disposition?: { kind: 'remedied' | 'closed'; at: string };
  /** Read live: whether `gbrain restore` can write the old page back on this source (see `identityRestoreAvailable`). */
  restore_available?: boolean;
}

type RestoreProbeEngine = Pick<BrainEngine, 'executeRaw' | 'getConfig' | 'kind'>;

/**
 * Whether a restore of a page that came from a canonical file can be admitted on this source, by the rule page writes
 * follow (decideUnboundWrite): a bound source, a connector source, a source with no checkout, or a PGLite source not
 * activated database-only can; an unbound Postgres source with a checkout refuses `owner_unavailable`, so no surface
 * offers the restore there.
 */
export async function identityRestoreAvailable(engine: RestoreProbeEngine, sourceId: string): Promise<boolean> {
  const [source] = await engine.executeRaw<{ local_path: string | null; kind: string | null }>("SELECT local_path, config->>'kind' AS kind FROM sources WHERE id = $1", [sourceId]);
  if (!source?.local_path || isConnectorSourceKind(source.kind)) return true;
  if (await getWorktreeBinding(engine as never, sourceId, null)) return true;
  return engine.kind === 'pglite' && !(await readDatabaseOnlyActivatedSources(engine)).includes(sourceId);
}

/** SQL: the downgrade record `dg` is open for the page aliased `alias` (no disposition, old page still soft-deleted by that sync). */
export const identityDowngradeOpen = (alias: string): string =>
  `dg.completed_keys->0->>'disposition' IS NULL AND ${alias}.deleted_at = (dg.completed_keys->0->>'old_deleted_at')::timestamptz`;

/** SQL predicate for a purge scan over `pages` aliased `alias`: the page has no open downgrade record. */
export function identityDowngradePurgeHold(alias: string): string {
  return `NOT EXISTS (SELECT 1 FROM op_checkpoints dg WHERE dg.op = '${IDENTITY_DOWNGRADE_OP}' AND dg.fingerprint = ${alias}.id::text
    AND ${identityDowngradeOpen(alias)})`;
}

const REASON_TEXT: Record<RenameDowngradeReason, string> = {
  id_conflict: 'the two files carry different frontmatter ids',
  id_shared: 'their frontmatter id is also carried by another file or page',
  id_one_side: 'only one side carries a frontmatter id',
  title_not_unique: 'their shared title is not unique',
  slug_not_unique: 'their shared slug: line is not unique',
  no_identity_signal: 'no frontmatter id, slug: or title matches',
};
export const identityDowngradeReasonText = (reason: RenameDowngradeReason): string => REASON_TEXT[reason];

/**
 * Records the downgraded pairs of a finished sync (paths in the source's origin form). A pair whose old page is not
 * soft-deleted (the delete did not land, or the old file never imported) has nothing to carry and is not recorded.
 */
export async function recordIdentityDowngrades(engine: BrainEngine, sourceId: string, pairs: DowngradedRename[]): Promise<IdentityDowngrade[]> {
  const records: IdentityDowngrade[] = [];
  for (const pair of pairs) {
    const [old] = await engine.executeRaw<{ id: number | string; slug: string; deleted_at: string }>(
      `SELECT id, slug, deleted_at::text AS deleted_at FROM pages WHERE source_id = $1 AND deleted_at IS NOT NULL
        AND (source_path = $2 OR (source_path IS NULL AND slug = $3)) ORDER BY deleted_at DESC LIMIT 1`,
      [sourceId, pair.from, resolveSlugForPath(pair.from)]);
    if (!old) continue;
    const owner = await canonicalOriginPage(engine, sourceId, pair.to);
    const fresh = owner && !('ambiguous' in owner) ? owner : null;
    const [counts] = await engine.executeRaw<{ facts: number | string; links: number | string; aliases: number | string }>(`SELECT
        (SELECT count(*) FROM facts WHERE source_id = $1 AND entity_slug = $2) AS facts,
        (SELECT count(*) FROM links WHERE from_page_id = $3 OR to_page_id = $3) AS links,
        (SELECT count(*) FROM page_aliases WHERE source_id = $1 AND slug = $2) AS aliases`, [sourceId, old.slug, Number(old.id)]);
    const recorded = new Date(old.deleted_at);
    const record: IdentityDowngrade = { source_id: sourceId, from: pair.from, to: pair.to, similarity: pair.similarity, reason: pair.reason, ...(pair.read ? { read: pair.read } : {}),
      old_slug: old.slug, old_page_id: Number(old.id), new_slug: fresh?.slug ?? null,
      facts: Number(counts?.facts ?? 0), links: Number(counts?.links ?? 0), aliases: Number(counts?.aliases ?? 0),
      recorded_at: recorded.toISOString(), old_deleted_at: old.deleted_at };
    await engine.executeRaw(`INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at) VALUES ($1, $2, $3::text::jsonb, now())
      ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = now()`,
      [IDENTITY_DOWNGRADE_OP, String(record.old_page_id), JSON.stringify([record])]);
    records.push(record);
  }
  return records;
}

/**
 * Open records (no disposition, old page still soft-deleted by that sync), oldest first; every source when `sourceIds` is omitted.
 * `new_slug` is read live: the live page at the new path now (a held new file that was fixed later counts once it imports).
 */
export async function listIdentityDowngrades(engine: RestoreProbeEngine, sourceIds?: readonly string[]): Promise<IdentityDowngrade[]> {
  const rows = await engine.executeRaw<{ record: IdentityDowngrade | string; new_slugs: string[] | null }>(
    `SELECT dg.completed_keys->0 AS record, np.slugs AS new_slugs FROM op_checkpoints dg JOIN pages p ON p.id::text = dg.fingerprint
      LEFT JOIN LATERAL (SELECT array_agg(slug ORDER BY slug) AS slugs FROM pages WHERE source_id = p.source_id AND deleted_at IS NULL AND source_path = dg.completed_keys->0->>'to') np ON true
      WHERE dg.op = $1 AND p.deleted_at IS NOT NULL AND ${identityDowngradeOpen('p')}
        AND p.source_id = dg.completed_keys->0->>'source_id' AND ($2::text[] IS NULL OR p.source_id = ANY($2::text[]))
      ORDER BY dg.completed_keys->0->>'recorded_at', dg.fingerprint`, [IDENTITY_DOWNGRADE_OP, sourceIds ? [...sourceIds] : null]);
  const records = rows.map(row => {
    const record = typeof row.record === 'string' ? JSON.parse(row.record) as IdentityDowngrade : row.record;
    const owner = pickCanonicalOrigin((row.new_slugs ?? []).map(slug => ({ slug })), record.to);
    return { ...record, new_slug: owner && !('ambiguous' in owner) ? owner.slug : null };
  });
  const restorable = new Map<string, boolean>();
  for (const sourceId of new Set(records.map(record => record.source_id))) restorable.set(sourceId, await identityRestoreAvailable(engine, sourceId));
  return records.map(record => ({ ...record, restore_available: restorable.get(record.source_id)! }));
}

/** What the remedy does with a pair: carry the old page's identity onto the new slug (default), or close the record. */
export type IdentityRemedyDisposition = 'carry' | 'close';
export const IDENTITY_HOLD_RELEASE = 'the remedy carries or closes the pair, or the old page is restored or purged';
/** A carry is a classic-source maintenance transaction; on a managed brain the remedy can only close the pair. */
export const MANAGED_REMEDY_UNAVAILABLE = 'managed_remedy_unavailable';

/** One page side of a pair as the remedy binds it: id, slug, revision and whether it is soft-deleted. */
export interface IdentityRemedySide { page_id: number; slug: string; revision: string; deleted: boolean }

/** The per-pair remedy every surface prints (sync report, `sync status --json`, doctor). */
export interface IdentityRemedy {
  /** `carry`, or `close` when the new file did not import or carrying is unavailable. */
  disposition: IdentityRemedyDisposition;
  /** `managed_remedy_unavailable` on a managed brain (the pair can only be closed there), else null. */
  carry_unavailable: typeof MANAGED_REMEDY_UNAVAILABLE | null;
  plan_hash: string; preview_argv: string[]; argv: string[]; consent: ['destructive'];
  hold_releases: string;
}

export type IdentityDowngradeEntry = IdentityDowngrade & { remedy: IdentityRemedy };

async function remedySide(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, where: string, value: string | number): Promise<IdentityRemedySide | null> {
  const [row] = await engine.executeRaw<{ id: number | string; slug: string; revision: string | null; deleted: boolean }>(
    `SELECT id, slug, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id = $1 AND ${where} = $2 LIMIT 1`, [sourceId, value]);
  return row ? { page_id: Number(row.id), slug: row.slug, revision: row.revision ?? '', deleted: row.deleted === true } : null;
}

/**
 * The state a remedy preview binds: the brain, the pair, both page ids and revisions, and the disposition. The old page
 * is read by id (it may have moved since), the new page by its live slug. Every surface hashes these same parts, so the
 * hash a sync report or doctor prints is the one the preview saves.
 */
export async function identityRemedyParts(engine: Pick<BrainEngine, 'executeRaw'>, record: IdentityDowngrade, disposition: IdentityRemedyDisposition) {
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1').catch(() => []);
  const old = await remedySide(engine, record.source_id, 'id', record.old_page_id);
  const fresh = record.new_slug ? await remedySide(engine, record.source_id, 'slug', record.new_slug) : null;
  return { kind: 'rename-identity-v1', brain_id: brain?.brain_id ?? 'host', source_id: record.source_id, from: record.from, to: record.to,
    recorded_at: record.recorded_at, disposition, old, new: fresh && !fresh.deleted ? fresh : null };
}
export type IdentityRemedyParts = Awaited<ReturnType<typeof identityRemedyParts>>;

/** `gbrain repair rename-identity --source <id> --slug <new>` (`--from <old>` when another open pair shares the new slug). */
export function renameIdentityPreviewArgv(record: Pick<IdentityDowngrade, 'source_id' | 'new_slug' | 'old_slug'>, opts: { from?: boolean; close?: boolean } = {}): string[] {
  return ['gbrain', 'repair', 'rename-identity', '--source', record.source_id, ...(record.new_slug ? ['--slug', record.new_slug] : []),
    ...(opts.from || !record.new_slug ? ['--from', record.old_slug] : []), ...(opts.close ? ['--close'] : [])];
}

/** The remedy one pair names: its preview, the apply bound to the current plan hash, consent, and the hold release. */
export async function identityRemedy(engine: Pick<BrainEngine, 'executeRaw'>, record: IdentityDowngrade, opts: { from?: boolean; managed?: boolean } = {}): Promise<IdentityRemedy> {
  const close = !!opts.managed || !record.new_slug;
  const plan_hash = previewHash(await identityRemedyParts(engine, record, close ? 'close' : 'carry'));
  const preview_argv = renameIdentityPreviewArgv(record, { from: opts.from, close });
  return { disposition: close ? 'close' : 'carry', carry_unavailable: opts.managed && record.new_slug ? MANAGED_REMEDY_UNAVAILABLE : null,
    plan_hash, preview_argv, argv: [...preview_argv, '--apply', '--expect', plan_hash, '--yes'], consent: ['destructive'], hold_releases: IDENTITY_HOLD_RELEASE };
}

/** Each record with its remedy; `--from` is named only where two open pairs share a new slug. */
export async function withIdentityRemedies(engine: Pick<BrainEngine, 'executeRaw'>, records: readonly IdentityDowngrade[]): Promise<IdentityDowngradeEntry[]> {
  if (!records.length) return [];
  const managed = await readManagedMode(engine);
  const shared = (record: IdentityDowngrade) => records.filter(other => other.source_id === record.source_id && other.new_slug === record.new_slug).length > 1;
  return Promise.all(records.map(async record => ({ ...record, remedy: await identityRemedy(engine, record, { from: shared(record), managed }) })));
}

/** How the remedy settled a pair: its identity was carried (`remedied`) or its record closed (`closed`). */
export type IdentityDowngradeSettlement = 'remedied' | 'closed';

/**
 * Settles one open record (disposition still unset) with `completed_keys[0].disposition = { kind, at }`, so the purge no
 * longer waits for its old page and no surface lists it. Returns the rows settled (0 when already settled or gone).
 */
export async function settleIdentityDowngrade(engine: Pick<BrainEngine, 'executeRaw'>, oldPageId: number, kind: IdentityDowngradeSettlement): Promise<number> {
  return (await engine.executeRaw(
    `UPDATE op_checkpoints SET completed_keys = jsonb_set(completed_keys, '{0,disposition}', jsonb_build_object('kind', $3::text, 'at', $4::text))
      WHERE op = $1 AND fingerprint = $2 AND completed_keys->0->>'disposition' IS NULL RETURNING 1`,
    [IDENTITY_DOWNGRADE_OP, String(oldPageId), kind, new Date().toISOString()])).length;
}

/** A recorded downgrade (as opposed to a raw pair a sync has not recorded yet). */
export const isRecordedDowngrade = (entry: DowngradedRename): entry is IdentityDowngrade => 'old_page_id' in entry;

/**
 * After a sync that committed (synced or first sync, not a dry run): records its downgraded pairs, prints the report
 * lines, and returns the result with the recorded entries in place of the raw pairs. A recording failure is one line
 * and never fails the sync.
 */
export async function noteIdentityDowngrades<T extends { status: string; identityDowngrades?: DowngradedRename[] }>(engine: BrainEngine, sourceId: string,
  result: T, write: (line: string) => void): Promise<T> {
  const pairs = (result.identityDowngrades ?? []).filter(pair => !isRecordedDowngrade(pair));
  if (!pairs.length || !['synced', 'first_sync'].includes(result.status)) return result;
  try {
    const restore_available = await identityRestoreAvailable(engine, sourceId);
    const records = await withIdentityRemedies(engine, (await recordIdentityDowngrades(engine, sourceId, pairs)).map(record => ({ ...record, restore_available })));
    for (const line of identityDowngradeLines(records)) write(line);
    return { ...result, identityDowngrades: records };
  } catch (error) {
    write(`  Could not record ${pairs.length} rename(s) whose identity was not kept: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
}

/**
 * Restores one old page with its facts, links and aliases, beside the new page. Where the restore cannot re-create the
 * old file, it refuses `canonical_file_absent` and names `--detach` (database-only) as the user's choice.
 */
export const identityRestoreArgv = (record: Pick<IdentityDowngrade, 'source_id' | 'old_slug'>): string[] =>
  ['gbrain', 'restore', record.old_slug, '--source-id', record.source_id, '--force'];
/** The read-only listing of a source's open records. */
export const identityStatusArgv = (sourceId: string): string[] => ['gbrain', 'sync', 'status', '--source', sourceId, '--json'];

/** What the remedy of one pair does, for the report line and doctor. */
export function remedyAction(record: IdentityDowngradeEntry): string {
  if (record.remedy.disposition === 'carry') return `Carry ${record.old_slug}'s identity onto ${record.new_slug} (asks the user first: destructive)`;
  if (record.remedy.carry_unavailable) return `Carrying ${record.old_slug}'s identity onto ${record.new_slug} is unavailable on a managed source (${record.remedy.carry_unavailable}); `
    + 'release the purge hold without carrying it (asks the user first: destructive)';
  return 'Release the purge hold (asks the user first: destructive)';
}

/** The sync report's lines for the downgraded pairs of one run, each naming its remedy. */
export function identityDowngradeLines(records: readonly IdentityDowngradeEntry[]): string[] {
  if (!records.length) return [];
  return [
    ...records.flatMap(record => [`  Identity not kept: ${record.from} -> ${record.to} (git similarity ${record.similarity}%; ${REASON_TEXT[record.reason]}). `
      + `${record.facts} fact(s), ${record.links} link(s) and ${record.aliases} alias(es) stay on the soft-deleted ${record.old_slug}; `
      + `${record.new_slug ? `${record.new_slug} starts fresh.` : 'the new file did not import.'} The purge holds ${record.old_slug} until ${record.remedy.hold_releases}.`,
    `    ${remedyAction(record)}: preview ${record.remedy.preview_argv.join(' ')}, then apply ${record.remedy.argv.join(' ')}`
      + (record.restore_available === false ? '' : `; or keep ${record.old_slug} as its own page: ${identityRestoreArgv(record).join(' ')}`)]),
    '  A move keeps its page when the files share a frontmatter id: (or a unique slug: line or title); to move and rewrite a page, move, commit and sync, then edit.',
  ];
}
