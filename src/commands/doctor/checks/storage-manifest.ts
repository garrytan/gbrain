/**
 * GST-1943: `storage_manifest`, read-only health of the storage shelf. Warns on
 *   - cards on the shelf that fail the current card schema (or pages there that hold no card);
 *   - interim `stored-object` pages under `storage-manifest/` outside the shelf that are not adopted yet (the fix is
 *     the read-only `gbrain storage adopt` preview);
 *   - a hosted shelf (source `storage` with role storage_manifest) whose worktree or repository directory is gone.
 * Reports not_applicable when there is no shelf and no interim page. Values are never echoed: findings name ids.
 */
import { existsSync } from 'node:fs';
import type { Check } from '../../doctor.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Action } from '../../../core/agent-output.ts';
import { ADOPT_DEFAULT_PREFIX, ADOPTED_TAG } from '../../../core/storage-manifest/adopt.ts';
import { readShelfCards } from '../../../core/storage-manifest/find.ts';
import { cardContent, ORIGINS, STORED_OBJECT_TYPE } from '../../../core/storage-manifest/schema.ts';
import { isStorageRole, STORAGE_SOURCE_ID } from '../../../core/storage-manifest/source.ts';
import { parseSourceConfig } from '../../../core/sources-load.ts';
import { agentFix, checkError, infoCheck } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const NAME = 'storage_manifest';
const DOCS = 'docs/guides/storage-manifest.md#doctor';

export async function storageManifestCheck(engine: BrainEngine): Promise<Check> {
  try {
    const [source] = await engine.executeRaw<{ local_path: string | null; config: unknown }>('SELECT local_path, config FROM sources WHERE id = $1 AND archived IS NOT TRUE', [STORAGE_SOURCE_ID]);
    const interim = await engine.executeRaw<{ source_id: string; n: number }>(`
      SELECT p.source_id, count(*)::int AS n FROM pages p
      WHERE p.type = $1 AND p.source_id <> $2 AND left(p.slug, length($3)) = $3 AND p.slug <> $3 || 'index' AND p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.page_id = p.id AND t.tag = $4)
      GROUP BY p.source_id ORDER BY p.source_id`, [STORED_OBJECT_TYPE, STORAGE_SOURCE_ID, ADOPT_DEFAULT_PREFIX, ADOPTED_TAG]);
    const shelf = !!source && isStorageRole(source.config);
    if (!shelf && !interim.length) return infoCheck(NAME, 'No storage shelf and no interim storage records on this brain.', 'not_applicable', undefined, { docs: DOCS });
    const invalid = shelf ? (await readShelfCards(engine)).filter((row) => !row.card || !cardContent(row.card) || typeof row.card.registered_by !== 'string'
      || !(ORIGINS as readonly string[]).includes(row.card.origin)).map((row) => row.id) : [];
    const hosted = shelf ? parseSourceConfig(source!.config).hosted_repo as { repository?: string; worktree?: string } | undefined : undefined;
    const missingDirs = shelf ? [...new Set([source!.local_path, hosted?.worktree, hosted?.repository].filter((dir): dir is string => !!dir && !existsSync(dir)))] : [];
    const pending = interim.reduce((sum, row) => sum + Number(row.n), 0);
    const details = { shelf, invalid_cards: invalid, interim_pending: interim.map((row) => ({ source_id: row.source_id, count: Number(row.n) })), missing_dirs: missingDirs, docs: DOCS };
    const problems: string[] = [];
    if (missingDirs.length) problems.push(`the hosted shelf's directory is gone (${missingDirs.join(', ')}), so cards cannot be committed`);
    if (invalid.length) problems.push(`${invalid.length} card(s) fail the current card schema: ${invalid.slice(0, 10).join(', ')}${invalid.length > 10 ? ', and more' : ''}`);
    if (pending) problems.push(`${pending} interim storage record(s) under ${ADOPT_DEFAULT_PREFIX} are not adopted yet (${interim.map((row) => `${row.source_id}: ${row.n}`).join(', ')})`);
    if (!problems.length) return { name: NAME, status: 'ok', message: 'Every card on the storage shelf passes the card schema, and no interim storage record waits to be adopted.', details };
    const first = interim[0]?.source_id;
    const fix: Action = missingDirs.length
      ? { ask_user: true, consent: [], actor: 'user', requires_exclusive: false, docs: DOCS, why: 'Only the user knows where the shelf repository went (moved, deleted, or on another machine).',
        user_message: `The storage shelf's Git directory is missing: ${missingDirs.join(', ')}. Restore it from its push remote or a backup to the same path, then run gbrain doctor --only storage_manifest again.` }
      : invalid.length
        ? agentFix(['gbrain', 'storage-get', invalid[0]!, '--json'], 'Read-only: names what the card breaks and its revision, so it can be fixed with gbrain storage-update.', NAME, { docs: DOCS })
        : agentFix(['gbrain', 'storage', 'adopt', ...(first && first !== 'default' ? ['--source', first] : []), '--json'], 'Read-only preview: the card each interim record maps to and the fields a card refuses; it writes nothing.', NAME, { docs: DOCS });
    return { name: NAME, status: 'warn', message: `Storage shelf: ${problems.join('; ')}.`, details, fix };
  } catch (error) {
    return checkError(NAME, 'read the storage shelf', error, { details: { docs: DOCS } });
  }
}

async function runStorageManifest(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push(await storageManifestCheck(connectedEngine(ctx)));
  return checks;
}

export const storageManifestEntry: DoctorEntry = {
  name: 'storage_manifest',
  emits: ['storage_manifest'],
  run: runStorageManifest,
};
