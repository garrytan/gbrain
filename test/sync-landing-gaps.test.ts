/**
 * GBRA-150: `foresights sync status --detail` names, per page, what a managed sync committed more than the freshness target
 * ago that search still cannot fully see, with the reason and the fix: chunks with no vector (found by keyword only), a
 * page a write outside sync removed after it synced, and on a brain keyless by choice nothing for missing vectors. A plain
 * status does not read it and says so. Red on master: there is no `landing` block.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { readLandingGaps } from '../src/core/persistence/landing-gaps.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-landing-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content'); };
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation about ${title}.\n`;

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function managedSource(engine: BrainEngine) {
  const id = `land-${randomUUID().replace(/-/g, '').slice(0, 20)}`, repo = join(home, id);
  mkdirSync(join(repo, 'notes'), { recursive: true }); git(repo, 'init', '-q');
  writeFileSync(join(repo, 'notes/a.md'), note('A'));
  commit(repo);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, repo]);
  await claimWorktree(engine, id, repo);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = () => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
  await sync();
  for (const name of ['b', 'c']) writeFileSync(join(repo, `notes/${name}.md`), note(name.toUpperCase()));
  commit(repo);
  await sync();
  return { id, repo, sync };
}

const each = (run: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const engine of engines) { try { await run(engine); } finally { await disposePersistenceConsumer(engine); } }
});

test('pages synced past the target with no vectors are named per page with the paid catch-up fix; a page removed outside sync is page_missing; younger pages are not gaps', () => each(async engine => {
  await engine.setConfig('embedding_disabled', 'false');
  const s = await managedSource(engine);
  expect((await readLandingGaps(engine, s.id, { afterSeconds: 3600 }))).toMatchObject({ status: 'ok', gaps: 0, checked: 0 });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug=$2', [s.id, 'notes/c']); }
  finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
  const gaps = await readLandingGaps(engine, s.id, { afterSeconds: 0 });
  expect(gaps).toMatchObject({ status: 'ok', complete: true, after_seconds: 0 });
  if (gaps.status !== 'ok') throw new Error('unreachable');
  const bySlug = Object.fromEntries(gaps.pages.map(page => [page.slug, page]));
  expect(bySlug['notes/b']).toMatchObject({ state: 'pending_embedding', searchable: 'keyword', fix: { argv: ['gbrain', 'embed', '--stale', '--catch-up', '--source', s.id, '--yes'], consent: ['paid'] } });
  expect(bySlug['notes/c']).toMatchObject({ state: 'page_missing', searchable: false, fix: null });
  expect(gaps.by_state).toMatchObject({ page_missing: 1 });
  expect(gaps.by_state.pending_embedding).toBeGreaterThanOrEqual(2);

  const detail = await readSyncStatus(engine, s.id);
  expect(detail.landing_read).toEqual({ status: 'read' });
  expect(detail.landing).toMatchObject({ status: 'ok', after_seconds: 300, gaps: 0 });
  const plain = await readSyncStatus(engine, s.id, { detail: false });
  expect(plain.landing).toBeNull();
  expect(plain.landing_read).toMatchObject({ status: 'not_read', fix: { argv: ['gbrain', 'sync', 'status', '--source', s.id, '--detail', '--json'] } });
}), 240_000);

test('on a brain keyless by choice, chunks without vectors are not gaps (keyword search is the configured retrieval)', () => each(async engine => {
  await engine.setConfig('embedding_disabled', 'true');
  try {
    const s = await managedSource(engine);
    expect(await readLandingGaps(engine, s.id, { afterSeconds: 0 })).toMatchObject({ status: 'ok', gaps: 0, pages: [] });
  } finally { await engine.setConfig('embedding_disabled', 'false'); }
}), 240_000);

test('a source with no managed binding is not applicable', () => each(async engine => {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES('land-classic-example','land-classic-example','{}') ON CONFLICT DO NOTHING"); }
  finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
  expect(await readLandingGaps(engine, 'land-classic-example')).toEqual({ status: 'not_applicable', reason: 'no_managed_binding' });
}), 60_000);
