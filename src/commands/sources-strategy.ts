/**
 * `gbrain sources set-strategy <id> <markdown|code|auto>` (#4899, PR #5955):
 * persist `sources.config.strategy`, the file strategy every sync of the
 * source uses when its caller passes no `--strategy` (`sync --all`, autopilot,
 * the dream cycle and the MCP `sync` op read it). Unset means `markdown`, under
 * which a changed code file's page is deleted rather than re-imported, so a
 * code repository needs `code` or `auto` recorded once. One writer, on
 * purpose: the stored key is the setting, `gbrain sources list --json` reads
 * it back, and an explicit `gbrain sync --strategy` still wins for that run.
 *
 * Refuses while the source has an unfinished managed sync run ([R26]): that
 * run froze a manifest classified under the old strategy, and changing the
 * key under it would make the resumed run and the next full sync disagree
 * about which files are pages. The write is updateSourceConfig's single-key
 * merge, so every other config key survives. Follows `mirror-readonly`.
 * #6712 PR 4b (design v3.2 §3.7): a non-company source has no cursor, so it
 * also refuses while a sync holds the source's drain lease (a pass classifies
 * under the strategy it pinned) or while a `--full` episode is open (its
 * selection, strategy included, is what the episode closes over).
 *
 * Contributed by @rokas-tarasevicius (PR #5955); the surface here is the
 * reviewed minimum of that PR.
 */
import type { BrainEngine } from '../core/engine.ts';
import { parseSourceConfig } from '../core/sources-load.ts';
import { isSyncStrategy, SYNC_STRATEGIES } from '../core/sync.ts';

/** The unfinished managed sync cursors of this source's current incarnation (read-only). */
export async function unfinishedManagedSyncRuns(engine: BrainEngine, sourceId: string): Promise<Array<{ cursor_key: string; run_id: string | null; index: number | null }>> {
  return engine.executeRaw<{ cursor_key: string; run_id: string | null; index: number | null }>(`
    SELECT c.fingerprint AS cursor_key,c.completed_keys->0->>'runId' AS run_id,(c.completed_keys->0->>'index')::int AS index
      FROM op_checkpoints c JOIN sources s ON s.id=c.completed_keys->0->>'sourceId' AND s.incarnation::text=c.completed_keys->0->>'incarnation'
     WHERE c.op='managed-sync' AND COALESCE(c.completed_keys->0->>'done','false')<>'true' AND s.id=$1 ORDER BY c.updated_at`, [sourceId]);
}

/** Why a strategy change would cut under a running or unfinished pass: a live drain lease, or an open episode (read-only). */
export async function unfinishedManagedSyncPass(engine: BrainEngine, sourceId: string): Promise<{ lease: string | null; episode: { opened_at: string; full_id: string | null } | null }> {
  const [{ readDrainHolder }, { readPassRow }] = await Promise.all([import('../core/persistence/sync-lease.ts'), import('../core/persistence/sync-pass-row.ts')]);
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
  const holder = await readDrainHolder(engine, sourceId);
  const episode = source ? (await readPassRow(engine, sourceId, source.incarnation))?.value.obligations.episode : undefined;
  return { lease: holder ? `${holder.kind}${holder.started_at ? ` since ${holder.started_at}` : ''}` : null, episode: episode ? { opened_at: episode.opened_at, full_id: episode.full_id ?? null } : null };
}

export async function runSetStrategy(engine: BrainEngine, args: string[]): Promise<void> {
  const [id, strategy] = args;
  if (!id || id.startsWith('-') || !strategy) {
    console.error(`Usage: gbrain sources set-strategy <id> <${SYNC_STRATEGIES.join('|')}>`);
    process.exit(2);
  }
  if (!isSyncStrategy(strategy)) {
    console.error(`Error: invalid strategy "${strategy}". Valid: ${SYNC_STRATEGIES.join(', ')}.`);
    process.exit(2);
  }
  const [src] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [id]);
  if (!src) {
    console.error(`Source "${id}" not found. List sources with: gbrain sources list`);
    process.exit(4);
  }
  const config = parseSourceConfig(src.config);
  if (typeof config.kind === 'string') {
    console.error(`Source "${id}" is a ${config.kind} connector source; a sync strategy applies to Git-backed sources only.`);
    process.exit(2);
  }
  const unfinished = await unfinishedManagedSyncRuns(engine, id);
  if (unfinished.length && config.strategy !== strategy) {
    const run = unfinished[0]!;
    console.error(`Error [sync_run_unfinished]: source "${id}" has ${unfinished.length} unfinished managed sync run(s) (cursor ${run.cursor_key.slice(0, 12)}${run.run_id ? `, run ${run.run_id.slice(0, 8)}` : ''}${run.index !== null ? `, at index ${run.index}` : ''}).`);
    console.error(`  Its frozen manifest was classified under the current strategy; changing it now would make the resumed run and the next full sync disagree about which files are pages.`);
    console.error(`  Finish the run first (gbrain sync --source ${id} --no-pull resumes it; gbrain sync status --source ${id} --json shows what holds it), or retire a run nothing can resume (gbrain repair managed-sync-orphans --source ${id}), then set the strategy.`);
    process.exit(1);
  }
  const pass = config.strategy !== strategy ? await unfinishedManagedSyncPass(engine, id) : { lease: null, episode: null };
  if (pass.lease || pass.episode) {
    console.error(`Error [sync_run_unfinished]: source "${id}" has ${pass.lease ? `a sync running (${pass.lease})` : `an open full re-import (opened ${pass.episode!.opened_at})`}.`);
    console.error(pass.lease ? `  It classifies the checkout under the current strategy; changing it now would make the running pass and the next one disagree about which files are pages.`
      : `  It re-imports the source under the selection it was opened with, strategy included; changing the strategy now would leave it unable to close.`);
    console.error(`  ${pass.lease ? 'Wait for the sync to finish' : `Finish it first (gbrain sync --source ${id} --no-pull continues it)`}; gbrain sync status --source ${id} --json shows where it stands. Then set the strategy.`);
    process.exit(1);
  }
  await engine.updateSourceConfig(id, { strategy });
  console.log(`Source "${id}" now syncs with strategy ${strategy}.`);
  if (config.strategy !== strategy) {
    console.log(`  Files unchanged since the last sync are re-classified only by a full sync: gbrain sync --source ${id} --full`);
  }
}
