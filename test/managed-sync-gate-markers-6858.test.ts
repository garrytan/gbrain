/**
 * #6858 ask 4: gbrain's own oversized-page screen must not rewrite a canonical file just to stamp its assessment.
 * The gate's markers (`embed_skip`, `content_flag`, `quarantine`) are re-derived from the bytes on every import and
 * `assessed_at` changes whenever the body does, so on master every managed sync import of an oversized page that agents
 * append to became a canonical writeback: a file publication with a recovery record, the window an agent's own edit of
 * the same hot file collides with (`unexpected_file_bytes`, the source's writer lane halted). The markers are database
 * state now: the import leaves the file as committed, and a file whose marker is missing or stale is not file/database
 * drift. Synthetic content only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { fileMatchesSnapshot } from '../src/core/persistence/page-prepare.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-6858-markers-'));
const engines: BrainEngine[] = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const line = 'An example observation appended by an agent to a busy page.\n';
const page = (n: number) => '---\ntitle: Hot Example\ntype: person\n---\n\n' + line.repeat(n);
const SLUG = 'people/hot-example';

async function managedSource(engine: BrainEngine) {
  const id = `markers-${randomUUID().replace(/-/g, '').slice(0, 16)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'people'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'people/hot-example.md'), page(60));
  commit(root, 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, file: join(root, 'people/hot-example.md'), opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true } };
}
const fileRecoveries = (engine: BrainEngine, id: string) => engine.executeRaw<{ n: number }>(
  "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND publication_started", [id, SLUG]).then(rows => rows[0]!.n);

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  for (const engine of engines) await engine.setConfig('content_sanity.bytes_block', '2000');
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]); await engine.disconnect(); }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('#6858: a managed sync of an oversized page stores embed_skip in the database and never rewrites the canonical file for it', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const engine of engines) {
    const s = await managedSource(engine);
    const committed = readFileSync(s.file, 'utf8');
    expect((await performManagedSync(engine, s.opts)).status).toBe('first_sync');
    expect(readFileSync(s.file, 'utf8')).toBe(committed);
    expect(git(s.root, 'status', '--porcelain')).toBe('');
    const first = (await engine.readPageSnapshot(SLUG, { sourceId: s.id }))!;
    expect((first.page.frontmatter as Record<string, { reason?: string }>).embed_skip?.reason).toBe('oversized');
    expect(await fileRecoveries(engine, s.id)).toBe(0);
    // An agent appends to the hot page and commits: the import re-assesses it (new bytes, new assessed_at) with no file publication.
    writeFileSync(s.file, committed + line); const appended = readFileSync(s.file, 'utf8');
    commit(s.root, 'agent append');
    expect((await performManagedSync(engine, s.opts)).status).toBe('synced');
    expect(readFileSync(s.file, 'utf8')).toBe(appended);
    expect(git(s.root, 'status', '--porcelain')).toBe('');
    expect(await fileRecoveries(engine, s.id)).toBe(0);
    const second = (await engine.readPageSnapshot(SLUG, { sourceId: s.id }))!;
    expect(second.page.compiled_truth.split(line.trim()).length - 1).toBe(61);
    expect((second.page.frontmatter as Record<string, { reason?: string }>).embed_skip?.reason).toBe('oversized');
    // A file that carries no marker, or one with another assessed_at, still matches its page: neither is file/database drift.
    expect(await fileMatchesSnapshot(engine, SLUG, appended, second, 'people/hot-example.md')).toBe(true);
    const stale = appended.replace('type: person\n', "type: person\nembed_skip:\n  reason: oversized\n  bytes: 1\n  assessed_at: '2026-10-15T21:27:12.000Z'\n");
    expect(await fileMatchesSnapshot(engine, SLUG, stale, second, 'people/hot-example.md')).toBe(true);
    expect(await fileMatchesSnapshot(engine, SLUG, appended + 'A real edit.\n', second, 'people/hot-example.md')).toBe(false);
  }
}), 240_000);
