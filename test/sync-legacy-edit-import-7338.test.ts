/**
 * #7338: a managed source activated over pages an older gbrain imported (no import record) sweeps those pages a bounded
 * number per pass (#7189). Before the fix, a Git edit to a page the sweep had not reached yet classified `drift` with an
 * unknown side and was held `file_drift`, so the edit never became searchable. That's what turned the managed serve-watch
 * freshness cells red. A page that still holds its file at the baseline commit changed only in Git, so the edit imports.
 * The sweep itself also ran before the round's imports, adding its cost to every commit's latency until it finished; a
 * round with imports now sweeps after them.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { drainProjections } from '../src/core/page-state/projections.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { MANAGED_SYNC_PASS_OP } from '../src/core/persistence/sync-pass-row.ts';
import { PASS_LEGACY_SWEEP_MAX } from '../src/core/persistence/sync-pass-apply.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const N = PASS_LEGACY_SWEEP_MAX + 40;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const name = (i: number) => `n${String(i).padStart(4, '0')}`;
const body = (i: number, text: string) => `---\ntype: concept\ntitle: notes/${name(i)}\n---\n\n${text}\n`;

/** Turns the synced pages into pages an older gbrain imported: the same rows with no import record, and no pass row. */
async function legacyPages(engine: BrainEngine): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    const cols = 'source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_path';
    const rows = await engine.executeRaw<Record<string, unknown>>(`SELECT ${cols} FROM pages WHERE source_id='default'`);
    await engine.executeRaw("DELETE FROM pages WHERE source_id='default'");
    for (const row of rows) await engine.executeRaw(`INSERT INTO pages(${cols}) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [row.source_id, row.slug, row.type, row.title, row.compiled_truth, row.timeline, JSON.stringify(row.frontmatter), row.content_hash, row.source_path]);
  } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op IN ($1,$2)', [SYNC_IMPORT_PROVENANCE_OP, MANAGED_SYNC_PASS_OP]);
  while ((await drainProjections(engine, { limit: 100 })).rebuilt > 0);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`#7338 [${backend}]: a Git edit to a legacy page the sweep has not reached imports instead of being held file_drift`, () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toMatch(/^(first_sync|synced)$/);
    await legacyPages(engine);
    // The activation pass sweeps at most PASS_LEGACY_SWEEP_MAX legacy pages in path order, so the last pages stay unrecorded.
    await performManagedSync(engine, OPTS);
    const last = N - 1, slug = `notes/${name(last)}`;
    const unrecorded = await engine.executeRaw("SELECT 1 FROM op_checkpoints c JOIN pages p ON p.id=(c.completed_keys->0->>'page_id')::int WHERE c.op=$1 AND p.slug=$2", [SYNC_IMPORT_PROVENANCE_OP, slug]);
    expect(unrecorded).toHaveLength(0);

    writeFileSync(join(root, `notes/${name(last)}.md`), body(last, 'An edited body naming acme-example.'));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'edit');
    // The bounded legacy sweep runs after the round's import, so it never delays the edit becoming visible.
    const seenAtSlice: boolean[] = [];
    installFaultHook(async point => {
      if (point === 'sync:legacy_slice') seenAtSlice.push(((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth ?? '').includes('acme-example'));
    });
    const result = await performManagedSync(engine, OPTS).finally(() => installFaultHook(undefined));
    expect(seenAtSlice.length).toBeGreaterThan(0);
    expect(seenAtSlice.every(Boolean)).toBe(true);
    expect(result.status).toBe('synced');
    const holds = await engine.executeRaw<{ code: string }>("SELECT completed_keys->0->>'code' AS code FROM op_checkpoints WHERE op='sync-hold' AND completed_keys->0->>'path'=$1", [`notes/${name(last)}.md`]);
    expect(holds).toEqual([]);
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toContain('acme-example');

    // A database edit to another unrecorded page still holds its Git edit: the database side moved since the baseline.
    const other = N - 2, otherSlug = `notes/${name(other)}`;
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try {
      await engine.executeRaw("UPDATE pages SET compiled_truth=compiled_truth || ' A database-only line.', knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug=$1", [otherSlug]);
    } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
    writeFileSync(join(root, `notes/${name(other)}.md`), body(other, 'A second Git edit.'));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'edit 2');
    await performManagedSync(engine, OPTS);
    const held = await engine.executeRaw<{ code: string }>("SELECT completed_keys->0->>'code' AS code FROM op_checkpoints WHERE op='sync-hold' AND completed_keys->0->>'path'=$1", [`notes/${name(other)}.md`]);
    expect(held.map(row => row.code)).toEqual(['file_drift']);
  }, { databaseUrl, setup: ({ root }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (let i = 0; i < N; i++) writeFileSync(join(root, `notes/${name(i)}.md`), body(i, `The committed body of notes/${name(i)}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  } }), 300_000);
}
