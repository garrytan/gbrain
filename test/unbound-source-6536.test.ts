/**
 * #6536: doctor `unbound_source` counted every page carrying the #5254
 * marker, while persistence (`isDatabaseOnlyPage`) only treats a marked page
 * with no recorded origin as database-only. A page whose canonical file sync
 * had recorded kept warning forever. Doctor now uses the persistence
 * predicate's SQL form, and a managed sync that records a page's origin
 * clears the marker.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { checkUnboundSource } from '../src/commands/doctor/checks/unbound-source.ts';
import { databaseOnlyPageSql, isDatabaseOnlyPage } from '../src/core/persistence/unbound-pages.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { dropOriginIndex } from './helpers/origin-index.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const dirs: string[] = [];
beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  // The parity fixture gives two live pages one origin, which only a brain whose pages_live_origin_key is pending holds (#6948).
  for (const engine of engines) await dropOriginIndex(engine);
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const ORIGINS: Array<{ source_path: string | null; source_uri: string | null }> = [
  { source_path: null, source_uri: null }, { source_path: '', source_uri: '' }, { source_path: ' \t\n', source_uri: null },
  { source_path: 'notes/a.md', source_uri: null }, { source_path: null, source_uri: 'file:///x/notes/a.md' }, { source_path: '  notes/a.md ', source_uri: ' ' },
];

for (const backend of backends) {
  test(`${backend}: doctor counts exactly the pages isDatabaseOnlyPage matches (#6536)`, async () => {
    const engine = engines[backends.indexOf(backend)];
    const sourceId = `parity-${backend}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    for (const [i, origin] of ORIGINS.entries()) {
      for (const marker of ['unbound_source', null]) {
        const slug = `notes/p${i}-${marker ?? 'none'}`;
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'x', timeline: '' }, { sourceId });
        await engine.executeRaw('UPDATE pages SET database_only_reason=$3,source_path=$4,source_uri=$5 WHERE source_id=$1 AND slug=$2',
          [sourceId, slug, marker, origin.source_path, origin.source_uri]);
      }
    }
    const rows = await engine.executeRaw<{ slug: string; source_path: string | null; source_uri: string | null; database_only_reason: string | null; matched: boolean }>(
      `SELECT slug,source_path,source_uri,database_only_reason,(${databaseOnlyPageSql('p')}) AS matched FROM pages p WHERE source_id=$1`, [sourceId]);
    for (const row of rows) expect({ slug: row.slug, matched: row.matched }).toEqual({ slug: row.slug, matched: isDatabaseOnlyPage(row) });
    const expected = rows.filter(row => isDatabaseOnlyPage(row)).length;
    expect(expected).toBe(3);
    const check = await checkUnboundSource(engine);
    expect((check.details as { sources: Array<{ source_id: string; pages: number }> }).sources.find(s => s.source_id === sourceId)?.pages).toBe(expected);
  }, 120_000);
}

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

for (const backend of backends) {
  test(`${backend}: a managed sync that records a marked page's origin clears the unbound_source marker (#6536)`, async () => {
    const engine = engines[backends.indexOf(backend)];
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-unbound-6536-')); dirs.push(dir);
    const root = join(dir, 'brain'); mkdirSync(join(root, 'notes'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    const commit = (body: string) => { writeFileSync(join(root, 'notes/adopted.md'), `---\ntitle: Adopted\ntype: note\n---\n${body}\n`); git(root, 'add', '.'); git(root, 'commit', '-qm', body); };
    commit('First.');
    const sourceId = `synced-${backend}`;
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      try {
        await performSync(engine, { repoPath: root, sourceId, noPull: true, noEmbed: true });
        await engine.executeRaw("UPDATE pages SET database_only_reason='unbound_source' WHERE source_id=$1 AND slug='notes/adopted'", [sourceId]);
        commit('Second.');
        await performSync(engine, { repoPath: root, sourceId, noPull: true, noEmbed: true });
        const [page] = await engine.executeRaw<{ source_path: string | null; database_only_reason: string | null; compiled_truth: string }>(
          "SELECT source_path,database_only_reason,compiled_truth FROM pages WHERE source_id=$1 AND slug='notes/adopted'", [sourceId]);
        expect(page.compiled_truth).toContain('Second.');
        expect({ source_path: page.source_path, database_only_reason: page.database_only_reason }).toEqual({ source_path: 'notes/adopted.md', database_only_reason: null });
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
    });
  }, 120_000);
}
