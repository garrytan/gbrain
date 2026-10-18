import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importManagedFile } from '../src/core/persistence/import-mutations.ts';
import { assertImportPaths } from '../src/core/persistence/import-prepare.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { screeningPath, withScreeningPaths } from '../src/core/persistence/screening-paths.ts';
import { readPageSnapshot } from '../src/core/page-state/snapshot.ts';
import { inspectUnchanged } from '../src/core/persistence/noop-kernel.ts';
import type { PreparedMutation } from '../src/core/persistence/coordinator.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

// GBRA-75 wave 7: the fixed cost of a file the managed import screen skips. A skipped file reads its page
// snapshot once, the snapshot statement computes withdrawal fingerprints only for a page with withdrawals,
// root-level path facts resolve once per screening batch, and a page written after the snapshot is still admitted.

const home = mkdtempSync(join(tmpdir(), 'gbrain-skip-cost-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv(env, async () => { for (const engine of engines) await fn(engine); });
const admissions = async (engine: BrainEngine, sourceId: string) =>
  (await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [sourceId])).length;

async function source(engine: BrainEngine) {
  const sourceId = `skip-${randomUUID().slice(0, 8)}`;
  const root = join(home, sourceId);
  mkdirSync(root);
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await registerLocalWriter(engine, 'cli');
    await claimWorktree(engine, sourceId, root);
  } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
  return { sourceId, root };
}

async function importedNote(engine: BrainEngine) {
  const s = await source(engine);
  const file = join(s.root, 'note.md');
  writeFileSync(file, '---\ntitle: Note\n---\nThe first durable observation.\n');
  const run = () => importManagedFile(engine, file, 'note.md', { sourceId: s.sourceId, noEmbed: true });
  expect((await run()).status).toBe('imported');
  expect((await run()).status).toBe('skipped');
  return { ...s, file, run };
}

describe('skipped-file cost', () => {
  test('an unchanged re-import is skipped after one page snapshot read and no admission', async () => each(async engine => {
    const note = await importedNote(engine);
    const before = await admissions(engine, note.sourceId);
    const reads = spyOn(engine, 'readPageSnapshot');
    try {
      expect((await note.run()).status).toBe('skipped');
      expect(reads).toHaveBeenCalledTimes(1);
    } finally { reads.mockRestore(); }
    expect(await admissions(engine, note.sourceId)).toBe(before);
  }));

  test('a file edited after the screen read it is admitted, not skipped (validate re-checks its bytes)', async () => each(async engine => {
    const note = await importedNote(engine);
    const before = await admissions(engine, note.sourceId);
    const original = engine.readPageSnapshot.bind(engine);
    let edited = false;
    const reads = spyOn(engine, 'readPageSnapshot').mockImplementation(async (slug, opts) => {
      if (!edited) { edited = true; writeFileSync(note.file, '---\ntitle: Note\n---\nAn edit that landed during the screen.\n'); }
      return original(slug, opts);
    });
    try { await note.run().catch(() => undefined); } finally { reads.mockRestore(); }
    expect(edited).toBe(true);
    expect(await admissions(engine, note.sourceId)).toBeGreaterThan(before);
  }), 60_000);

  test('the no-op kernel admits a page written after the snapshot the screen prepared against', async () => each(async engine => {
    const note = await importedNote(engine);
    const snapshot = (await engine.readPageSnapshot('note', { sourceId: note.sourceId, includeDeleted: true }))!;
    const prepared = { noop: true, observedRevision: snapshot.revision, validate: async () => {}, apply: async () => ({}) } as unknown as PreparedMutation;
    const inspect = () => inspectUnchanged(engine, { prepared, snapshot, sourcePath: snapshot.page.source_path ?? null, databaseOnly: true });
    expect((await inspect()).admitReason).toBeUndefined();
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try { await engine.executeRaw("UPDATE pages SET title='Moved' WHERE source_id=$1 AND slug='note'", [note.sourceId]); }
    finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
    expect((await inspect()).admitReason).toBe('revision_moved');
  }));

  test('the snapshot statement computes withdrawal fingerprints only for a page with withdrawals', async () => each(async engine => {
    const note = await importedNote(engine);
    const rows: Array<Record<string, unknown>> = [];
    const query = async <T>(sql: string, params?: unknown[]) => { const r = await engine.executeRaw<T>(sql, params); rows.push(...(r as Array<Record<string, unknown>>)); return r; };
    const plain = await readPageSnapshot(query, 'note', { sourceId: note.sourceId });
    expect(plain?.withdrawals).toEqual([]);
    expect(rows.at(-1)!.fingerprint_body ?? null).toBeNull();
    expect(rows.at(-1)!.fingerprint_timeline ?? null).toBeNull();
    await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash) VALUES($1,'world','note','h-1')", [note.sourceId]);
    const withdrawn = await readPageSnapshot(query, 'note', { sourceId: note.sourceId });
    expect(withdrawn?.withdrawals.map(w => w.fact_hash)).toEqual(['h-1']);
    expect(String(rows.at(-1)!.fingerprint_body)).toContain('the first durable observation.');
    expect(withdrawn?.page.compiled_truth).toBe(plain?.page.compiled_truth);
  }));

  test('inside one screening batch the other sources\' roots resolve once; outside it every check resolves them', async () => each(async engine => {
    const own = await source(engine);
    const others = [await source(engine), await source(engine)];
    const target = join(own.root, 'note.md');
    writeFileSync(target, 'x\n');
    const realpaths = spyOn(fs, 'realpathSync');
    const otherRootCalls = () => realpaths.mock.calls.filter(([path]) => others.some(o => path === o.root)).length;
    try {
      await assertImportPaths(engine, own.sourceId, own.root, target, target);
      const perCheck = otherRootCalls();
      expect(perCheck).toBeGreaterThanOrEqual(others.length);
      realpaths.mockClear();
      for (let i = 0; i < 3; i++) await assertImportPaths(engine, own.sourceId, own.root, target, target);
      expect(otherRootCalls()).toBe(3 * perCheck);
      realpaths.mockClear();
      await withScreeningPaths(async () => { for (let i = 0; i < 3; i++) await assertImportPaths(engine, own.sourceId, own.root, target, target); });
      expect(otherRootCalls()).toBe(others.length);
    } finally { realpaths.mockRestore(); }
    await expect(assertImportPaths(engine, own.sourceId, own.root, join(others[0]!.root, 'x.md'), join(others[0]!.root, 'x.md')))
      .rejects.toMatchObject({ code: 'source_changed' });
  }));
});

describe('screening path memo', () => {
  test('memoizes per open batch, joins nested batches, forgets on exit and never memoizes a throw', async () => {
    let calls = 0;
    const compute = () => ++calls;
    expect(screeningPath('k', compute)).toBe(1);
    expect(screeningPath('k', compute)).toBe(2);
    let escaped: (() => number) | undefined;
    await withScreeningPaths(async () => {
      expect(screeningPath('k', compute)).toBe(3);
      expect(screeningPath('k', compute)).toBe(3);
      await withScreeningPaths(async () => { expect(screeningPath('k', compute)).toBe(3); });
      let failures = 0;
      const failing = () => { failures++; throw new Error('enoent'); };
      expect(() => screeningPath('bad', failing)).toThrow('enoent');
      expect(() => screeningPath('bad', failing)).toThrow('enoent');
      expect(failures).toBe(2);
      escaped = () => screeningPath('k', compute);
    });
    expect(escaped!()).toBe(4);
    expect(screeningPath('k', compute)).toBe(5);
  });
});
