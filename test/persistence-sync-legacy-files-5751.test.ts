import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { inspectUnchanged } from '../src/core/persistence/noop-kernel.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { printManagedSyncNotes } from '../src/commands/sync-diagnostics.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

// #5751: on a managed brain, working-tree sync re-admitted the same unchanged
// legacy (pre-activation) files on every run, spending a permanent request ID
// each time, because their admit reason is one a no-op publication can never
// resolve: an embedded page with no contextual retrieval mode, or file bytes
// that differ from what gbrain reads but parse to the same page.

const home = mkdtempSync(join(tmpdir(), 'gbrain-5751-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content'); };
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv(env, async () => { for (const engine of engines) await fn(engine); });

const LEGACY = {
  embedded: Buffer.from('---\ntitle: Embedded\n---\nA legacy reflection embedded before activation.\n'),
  latin: Buffer.concat([Buffer.from('---\ntitle: Latin\n---\nA legacy caf'), Buffer.from([0xe9]), Buffer.from(' note.\n')]),
  hand: Buffer.from('---\ntitle:   "Hand Formatted"\ntags: [b, a]\n---\n\nA hand formatted legacy note.   \n\n\n'),
};

/** Untracked files whose pages were written classically before the writer was activated. */
async function legacyFixture(engine: BrainEngine) {
  const id = `wt-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  writeFileSync(join(root, 'seed.md'), '---\ntitle: seed\n---\nThe only committed file.\n');
  commit(root);
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  for (const [slug, bytes] of Object.entries(LEGACY)) {
    writeFileSync(join(root, `${slug}.md`), bytes);
    await importFromContent(engine, slug, bytes.toString('utf8'), { sourceId: id, noEmbed: true, sourcePath: `${slug}.md` });
  }
  // Embedded before activation, without a contextual retrieval mode (as a `--no-embed` import followed by `embed` left it).
  const [{ dim }] = await engine.executeRaw<{ dim: number }>("SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
  await engine.executeRaw(`UPDATE content_chunks c SET embedding=$2::text::vector FROM pages p WHERE p.id=c.page_id AND p.source_id=$1 AND p.slug='embedded'`,
    [id, `[${Array(Number(dim)).fill(0.01).join(',')}]`]);
  await engine.executeRaw('UPDATE pages SET contextual_retrieval_mode=NULL WHERE source_id=$1', [id]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, working: { sourceId: id, noPull: true, noEmbed: true, noExtract: true, workingTree: true, explicitProcessing: [] } };
}
const admitted = async (engine: BrainEngine, id: string) =>
  (await engine.executeRaw<{ slug: string }>("SELECT slug FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_import' ORDER BY sequence", [id])).map(r => r.slug);
const notes = (result: Parameters<typeof printManagedSyncNotes>[0]) => { const lines: string[] = []; printManagedSyncNotes(result, line => lines.push(line)); return lines; };

test('#5751 unchanged legacy working-tree files admit nothing on any run, and the summary names the repair', async () => each(async engine => {
  const f = await legacyFixture(engine);
  for (let run = 0; run < 3; run++) {
    const result = await performManagedSync(engine, f.working);
    await disposePersistenceConsumer(engine);
    expect(result.status === 'first_sync' || result.status === 'synced').toBe(true);
    expect(result.legacySkips).toEqual({ contextualMode: 1, canonicalBytes: 1 });
    expect(notes(result)).toEqual([
      '  1 legacy file(s) skipped because they parse to the same page but have no contextual retrieval mode, which a skipped import cannot stamp; to stamp it: gbrain repair contextual-mode',
      '  1 legacy file(s) skipped because they parse to the same page but their bytes are not what gbrain reads back (for example, not valid UTF-8); re-save them as UTF-8 to publish them exactly.',
    ]);
  }
  expect((await admitted(engine, f.id)).filter(slug => slug in LEGACY)).toEqual([]);
  for (const [slug, bytes] of Object.entries(LEGACY)) expect(readFileSync(join(f.root, `${slug}.md`)).equals(bytes)).toBe(true);
  // The printed command stamps the mode without an admission; the next run no longer needs that waiver.
  const runner = await repairRunner(engine, { apply: true, noEmbed: true });
  expect((await runner.run('contextual-mode', await resolveRepairScope(engine, f.id), { sourceFlag: f.id })).applied).toBeGreaterThanOrEqual(1);
  const after = await performManagedSync(engine, f.working);
  await disposePersistenceConsumer(engine);
  expect(after.legacySkips).toEqual({ contextualMode: 0, canonicalBytes: 1 });
  expect((await admitted(engine, f.id)).filter(slug => slug in LEGACY)).toEqual([]);
}), 180_000);

test('#5751 a run mixing skipped legacy files and a new file commits its checkpoint', async () => each(async engine => {
  const f = await legacyFixture(engine);
  writeFileSync(join(f.root, 'fresh.md'), '---\ntitle: Fresh\n---\nA new untracked observation.\n');
  const result = await performManagedSync(engine, f.working);
  await disposePersistenceConsumer(engine);
  expect(result).toMatchObject({ status: 'first_sync', added: 2, legacySkips: { contextualMode: 1, canonicalBytes: 1 } });
  expect((await admitted(engine, f.id)).sort()).toEqual(['fresh', 'seed']);
  expect((await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [f.id]))[0].last_commit).toBe(git(f.root, 'rev-parse', 'HEAD'));
  expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state<>'committed'", [f.id])).toEqual([]);
}), 180_000);

test('#5751 the waiver is scoped to managed working-tree imports: commit-driven sync and the kernel default still admit', async () => each(async engine => {
  const f = await legacyFixture(engine);
  await performManagedSync(engine, f.working);
  await disposePersistenceConsumer(engine);
  // Committing the legacy files puts them on the commit-driven path, which keeps today's admission.
  commit(f.root);
  const committed = await performManagedSync(engine, { ...f.working, workingTree: false });
  await disposePersistenceConsumer(engine);
  expect(committed.legacySkips).toBeUndefined();
  expect((await admitted(engine, f.id)).filter(slug => slug in LEGACY).sort()).toEqual(['embedded', 'latin']);
  // Without a waiver the kernel still reports each reason for every other writer.
  const snapshot = await engine.readPageSnapshot('latin', { sourceId: f.id });
  const prepared = { noop: true, observedRevision: snapshot!.revision, apply: async () => ({}),
    file: { root: f.root, path: join(f.root, 'latin.md'), content: LEGACY.latin.toString('utf8') } };
  expect(await inspectUnchanged(engine, { prepared, snapshot, sourcePath: 'latin.md', databaseOnly: false })).toMatchObject({ admitReason: 'canonical_file_differs' });
  expect(await inspectUnchanged(engine, { prepared, snapshot, sourcePath: 'latin.md', databaseOnly: false, waive: ['canonical_file_differs'] }))
    .toMatchObject({ waived: ['canonical_file_differs'] });
  // A missing file is never waived.
  rmSync(join(f.root, 'latin.md'));
  expect(await inspectUnchanged(engine, { prepared, snapshot, sourcePath: 'latin.md', databaseOnly: false, waive: ['canonical_file_differs'] }))
    .toMatchObject({ admitReason: 'canonical_file_differs' });
}), 180_000);
