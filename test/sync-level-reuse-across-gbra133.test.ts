/**
 * GBRA-133 wave 4: `I⋈P` across passes (GBRA-108's conditions). A pass that ends synced keeps its last round's pages
 * table and mark (S1) in its process; the next pass's first round proves, in its own snapshot, which pages and import
 * records changed since S1, from any writer, re-reads only those, and checks the page and record counts.
 *   - Equivalence oracle (GBRAIN_SYNC_LEVEL_REUSE_VERIFY=1 on every test): each reused table is compared with a whole read
 *     in the same snapshot and a difference fails the pass.
 *   - Taken: a commit, and a page written by another writer between passes, are re-read; the level matches.
 *   - Forced probes: a writer in another session in flight at S1 and committed before the next pass (Postgres: one
 *     connection cannot have one on PGLite) is re-read; a page deleted outside any write path, caught only by the count,
 *     reads whole (`counts`); a restart (a new process: nothing kept), a failed pass and `sync.level_reuse false` read whole.
 * Before: every pass's first round read `I⋈P` whole.
 * Real PGLite (and Postgres when DATABASE_URL is set), real managed syncs and real Git.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { __resetTreeReuseForTests } from '../src/core/persistence/sync-tree-reuse.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
type Confirm = { taken: boolean; reason: string | null; rows: number; across?: true } | null;

afterEach(() => { installFaultHook(undefined); __resetTreeReuseForTests(); });

for (const backend of testBackends()) describe(`[${backend}] GBRA-133: I⋈P across passes`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  let url: string | undefined;
  const open = databaseUrl ? async () => { const pg = await isolatedPersistencePostgres(databaseUrl); url = pg.databaseUrl; return pg; } : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${name}.md`), note(name, `The body of ${name}.`));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };
  /** Each sync's first-round confirm (null: no reuse attempted). */
  const firstRounds = (): Confirm[] => {
    const seen: Confirm[] = [];
    installFaultHook((point, detail) => { if (point === 'sync:level_read' && detail.round === 1) seen.push(detail.level?.confirm ?? null); });
    return seen;
  };
  const edit = (root: string, name: string, body: string) => { writeFileSync(join(root, `notes/${name}.md`), note(name, body)); git(root, 'add', '-A'); git(root, 'commit', '-qm', `edit ${name}`); };
  const coordinated = (engine: BrainEngine, sql: string, params: unknown[] = []) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
  const titles = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string; title: string }>(
    "SELECT slug, title FROM pages WHERE source_id='default' AND deleted_at IS NULL AND slug LIKE 'notes/%' ORDER BY slug")).map(row => `${row.slug}=${row.title}`);
  const brain = (run: Parameters<typeof managedBrain>[0]) => withEnv({ GBRAIN_SYNC_LEVEL_REUSE_VERIFY: '1' }, () => managedBrain(run, { databaseUrl, ...(open ? { open } : {}), setup }));

  test('the next pass patches the last pass\'s I⋈P: a commit and another writer\'s page are re-read', () => brain(async ({ engine, root }) => {
    const seen = firstRounds();
    await performManagedSync(engine, OPTS);
    edit(root, 'a', 'The edited body of a.');
    await performManagedSync(engine, OPTS);
    expect(seen.at(-1)).toMatchObject({ taken: true, across: true });
    // Another writer between passes: a page row the pass did not write.
    await coordinated(engine, "UPDATE pages SET title = 'Retitled b', knowledge_revision = $1::uuid WHERE source_id='default' AND slug='notes/b'", [randomUUID()]);
    edit(root, 'c', 'The edited body of c.');
    await performManagedSync(engine, OPTS);
    expect(seen.at(-1)).toMatchObject({ taken: true, across: true });
    expect(seen.at(-1)!.rows).toBeGreaterThanOrEqual(1);
    expect(await titles(engine)).toContain('notes/b=Retitled b');
  }), 300_000);

  test('a page deleted outside any write path is caught by the count alone and reads whole', () => brain(async ({ engine, root }) => {
    const seen = firstRounds();
    await performManagedSync(engine, OPTS);
    edit(root, 'a', 'Edited once.');
    await performManagedSync(engine, OPTS);
    // No row of the source changes: the deleted row leaves no xmin, only the count moves.
    await coordinated(engine, "DELETE FROM pages WHERE source_id='default' AND slug='notes/b'");
    edit(root, 'c', 'Edited once.');
    await performManagedSync(engine, OPTS);
    expect(seen.at(-1)).toMatchObject({ taken: false, reason: 'counts', across: true });
  }), 300_000);

  test('a restart, a failed pass and sync.level_reuse false read whole', () => brain(async ({ engine, root }) => {
    const seen = firstRounds();
    await performManagedSync(engine, OPTS);
    // A restart: a new process keeps nothing.
    __resetTreeReuseForTests();
    edit(root, 'a', 'After a restart.');
    await performManagedSync(engine, OPTS);
    expect(seen.at(-1)).toBeNull();
    // A pass that fails keeps nothing.
    edit(root, 'b', 'Before a failed pass.');
    installFaultHook((point, detail) => { if (point === 'sync:level_read' && detail.round === 1) throw new Error('synthetic pass failure'); });
    await expect(performManagedSync(engine, OPTS)).rejects.toThrow('synthetic pass failure');
    const again = firstRounds();
    await performManagedSync(engine, OPTS);
    expect(again.at(-1)).toBeNull();
    // Off: the next pass reads whole, and keeps nothing for the one after.
    await engine.setConfig('sync.level_reuse', 'false');
    edit(root, 'c', 'Reuse off.');
    await performManagedSync(engine, OPTS);
    expect(again.at(-1)).toBeNull();
    await engine.setConfig('sync.level_reuse', 'true');
    edit(root, 'a', 'Reuse on again.');
    await performManagedSync(engine, OPTS);
    expect(again.at(-1)).toBeNull();
    edit(root, 'b', 'Reused.');
    await performManagedSync(engine, OPTS);
    expect(again.at(-1)).toMatchObject({ taken: true, across: true });
  }), 300_000);

  test.skipIf(backend !== 'postgres')('a write in flight in another session at S1 and committed before the next pass is re-read', () => brain(async ({ engine, root }) => {
    const seen = firstRounds();
    await performManagedSync(engine, OPTS);
    const other = new PostgresEngine();
    await other.connect({ database_url: url!, poolSize: 1 });
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let started!: () => void;
      const written = new Promise<void>(resolve => { started = resolve; });
      // The writer's transaction holds its id (and no lock) across S1, then writes the row with that id as its xmin.
      const writer = other.transaction(async tx => {
        await tx.executeRaw('SELECT txid_current()');
        started();
        await gate;
        await withCoordinatedWrite(tx, ['default'], () => tx.executeRaw("UPDATE pages SET title = 'Written in flight', knowledge_revision = $1::uuid WHERE source_id='default' AND slug='notes/b'",
          [randomUUID()]), TEST_WRITE_ATTRIBUTION);
      });
      await written;
      edit(root, 'a', 'Synced while another session writes.');
      // The pass's last round marks S1 while the write is in flight; it commits once the pass has read its level.
      // Round 2 is the pass's last (its confirm round): its read is S1.
      let rounds = 0;
      installFaultHook((point, detail) => {
        if (point !== 'sync:level_read') return;
        rounds = detail.round!;
        if (detail.round === 1) seen.push(detail.level?.confirm ?? null);
        if (detail.round === 2) release();
      });
      await performManagedSync(engine, OPTS);
      expect(rounds).toBe(2);
      await writer;
      edit(root, 'c', 'The next pass.');
      await performManagedSync(engine, OPTS);
      // The in-flight row's xmin is in S1's in-progress list: the proof re-reads it (a commit and that page).
      expect(seen.at(-1)).toMatchObject({ taken: true, across: true });
      expect(seen.at(-1)!.rows).toBeGreaterThanOrEqual(2);
      expect(await titles(engine)).toContain('notes/b=Written in flight');
    } finally { await other.disconnect(); }
  }), 300_000);
});
