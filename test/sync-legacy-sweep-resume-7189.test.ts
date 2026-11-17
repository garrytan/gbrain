/**
 * #7189: a source whose legacy pages differ from their files never finished its first managed full round. The first full
 * round screened every legacy page before the round's real changes, and a page that differs gets no record, so a pass
 * stopped by its deadline mid-sweep kept nothing: the next pass screened the same pages from the top, stopped again, and
 * the commits waiting behind the sweep were never imported (each 3,600 s pass ended partial with 0 changes).
 *
 * Protects:
 * - a pass screens at most PASS_LEGACY_SWEEP_MAX legacy pages, then imports the round's real changes;
 * - the next full round resumes the sweep where the last one stopped (`obligations.legacy_sweep.cursor`), so the first
 *   full sweep finishes even when no page it screens can be recorded, and records `first_full_at` once it reaches the end.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { drainProjections } from '../src/core/page-state/projections.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { LEGACY_SWEEP_SLICE, PASS_LEGACY_SWEEP_MAX } from '../src/core/persistence/sync-pass-apply.ts';
import { MANAGED_SYNC_PASS_OP } from '../src/core/persistence/sync-pass-row.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const TOTAL = PASS_LEGACY_SWEEP_MAX + 20;
const names = Array.from({ length: TOTAL }, (_, i) => `n${String(i).padStart(3, '0')}`);
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const name of names) writeFileSync(join(root, `notes/${name}.md`), `---\ntype: concept\ntitle: notes/${name}\n---\n\nThe committed body of notes/${name}.\n`);
  commit(root, 'notes');
};

const passRow = async (engine: BrainEngine) => (await engine.executeRaw<{ value: any }>('SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1', [MANAGED_SYNC_PASS_OP]))[0]?.value ?? null;
const page = async (engine: BrainEngine, slug: string) => (await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', ['default', slug])).length > 0;

/** Turns the synced pages into pages an older foresights imported whose body no longer matches the file: no import record, no pass row. */
async function differingLegacyPages(engine: BrainEngine): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    const cols = 'source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_path';
    const rows = await engine.executeRaw<Record<string, unknown>>(`SELECT ${cols} FROM pages WHERE source_id='default'`);
    await engine.executeRaw("DELETE FROM pages WHERE source_id='default'");
    for (const row of rows) await engine.executeRaw(`INSERT INTO pages(${cols}) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [row.source_id, row.slug, row.type, row.title, `${row.compiled_truth} An edit the brain kept.`, row.timeline, JSON.stringify(row.frontmatter), `${row.content_hash}-older`, row.source_path]);
  } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op IN ($1,$2)', [SYNC_IMPORT_PROVENANCE_OP, MANAGED_SYNC_PASS_OP]);
  while ((await drainProjections(engine, { limit: 100 })).rebuilt > 0);
}

/** Every pass is stopped once it starts screening past PASS_LEGACY_SWEEP_MAX pages, as a deadline would stop it. */
function deadlinePastBudget(): void {
  let slices = 0;
  installFaultHook(async (point, context) => {
    if (point === 'sync:round_start' && (context as { round?: number }).round === 1) slices = 0;
    if (point === 'sync:legacy_slice' && ++slices > PASS_LEGACY_SWEEP_MAX / LEGACY_SWEEP_SLICE) throw new Error('deadline mid-sweep');
  });
}

afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  describe(`#7189: a first full round over legacy pages that differ (${backend})`, () => {
    test('a pass screens a bounded slice of the sweep, imports the waiting commit, and the next pass resumes the sweep', () => managedBrain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      await differingLegacyPages(engine);
      writeFileSync(join(root, 'notes/fresh.md'), '---\ntype: concept\ntitle: notes/fresh\n---\n\nA commit waiting behind the sweep.\n');
      commit(root, 'fresh');
      deadlinePastBudget();

      const first = await performManagedSync(engine, OPTS).then(result => result.status, (error: Error) => error.message);
      expect(first).not.toBe('deadline mid-sweep');
      expect(await page(engine, 'notes/fresh')).toBe(true);
      let row = await passRow(engine);
      expect(row.telemetry.counts).toMatchObject({ legacy_swept: PASS_LEGACY_SWEEP_MAX, legacy_recorded: 0 });
      expect(row.obligations.legacy_sweep).toEqual({ cursor: `notes/${names[PASS_LEGACY_SWEEP_MAX - 1]}.md` });

      // The first pass converged, so the next full round (here an explicit one) resumes the sweep at the cursor.
      await performManagedSync(engine, { ...OPTS, full: true });
      row = await passRow(engine);
      expect(row.telemetry.counts).toMatchObject({ legacy_swept: TOTAL - PASS_LEGACY_SWEEP_MAX, legacy_recorded: 0 });
      expect(row.obligations.legacy_sweep).toMatchObject({ first_full_at: expect.any(String) });
    }, { databaseUrl, setup }), 600_000);
  });
}
