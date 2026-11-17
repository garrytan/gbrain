/**
 * `foresights pages status <slug...>` (#7179): one read-only answer per page to "is this page searchable, and if not, why?".
 * Each state of the `sources resolve-path` vocabulary a page can be in, the large-page embedding hold (still
 * pending_embedding, fixed by the held approval and never a spend), the Git sync hold on the page's file (code exactly
 * as `readGitHold` returns it, with its own fix), strict arguments, and the `slugs` filter on `listEmbeddingStateRows`.
 * Red on master: the subcommand, the module and the `slugs` option do not exist there. PGLite, plus the Postgres arm
 * when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPages } from '../src/commands/pages.ts';
import { readPagesStatus, type PagesStatus } from '../src/commands/pages-status.ts';
import { EMBEDDING_STATES } from '../src/core/embedding-state.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { gitHoldFix, readGitHold } from '../src/core/persistence/sync-holds.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { makeDoctorHome, runGbrain } from './helpers/doctor-json-golden.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-pages-status-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const VECTOR = 'array_fill(0.1::real, ARRAY[1536])::vector';

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function each(run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  await withEnv(env, async () => {
    for (const engine of engines) {
      try { await run(engine); } finally { await disposePersistenceConsumer(engine); }
    }
  });
}

async function newSource(engine: BrainEngine): Promise<string> {
  const id = `pst-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [id]);
  return id;
}

/** A page with chunk rows written directly: `vectors[i]` says whether chunk i has a vector in the active column. */
async function page(engine: BrainEngine, source: string, slug: string, opts: { body?: string; frontmatter?: Record<string, unknown>; vectors?: boolean[] } = {}): Promise<number> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: opts.body ?? `${slug} body` }, { sourceId: source });
  const [row] = await engine.executeRaw<{ id: number }>('UPDATE pages SET frontmatter = $3::text::jsonb WHERE slug = $1 AND source_id = $2 RETURNING id',
    [slug, source, JSON.stringify(opts.frontmatter ?? {})]);
  await engine.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [row!.id]);
  for (const [i, vector] of (opts.vectors ?? []).entries()) {
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, embedding) VALUES ($1, $2, 'abcd', ${vector ? VECTOR : 'NULL'})`, [row!.id, i]);
  }
  return Number(row!.id);
}

async function cli(engine: BrainEngine, args: string[]): Promise<string> {
  const lines: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
  try { await runPages(engine as never, ['status', ...args]); } finally { log.mockRestore(); }
  return lines.join('\n');
}

describe('foresights pages status: embedding states', () => {
  test('embedded, pending (worst chunk wins), chunkless with body, quarantined, missing and soft-deleted pages each read their state and fix', () => each(async engine => {
    const source = await newSource(engine);
    await page(engine, source, 'notes/alice-example', { vectors: [true, true] });
    await page(engine, source, 'notes/acme-example', { vectors: [true, false, false] });
    await page(engine, source, 'notes/stub-with-body');
    await page(engine, source, 'notes/junk-example', { vectors: [true], frontmatter: { quarantine: { reason: 'junk_pattern' } } });
    await page(engine, source, 'notes/gone-example', { vectors: [true] });
    await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE slug = $1 AND source_id = $2', ['notes/gone-example', source]);
    const out = JSON.parse(await cli(engine, ['notes/alice-example', 'notes/acme-example', 'notes/stub-with-body', 'notes/junk-example', 'notes/nobody-example',
      'notes/gone-example', '--source', source, '--json'])) as PagesStatus;
    expect(out).toMatchObject({ source_id: source, last_commit: null, head: null, at_head: null, embeddings_enabled: true });
    const [alice, acme, stub, junk, nobody, gone] = out.pages;
    expect(alice).toMatchObject({ slug: 'notes/alice-example', source_id: source, state: 'searchable', searchable: true, embedding_hold: null, hold: null,
      in_synced_commit: null, fix: null, page: { slug: 'notes/alice-example', deleted: false, chunks: 2, unembedded: 0 } });
    expect(acme).toMatchObject({ state: 'pending_embedding', searchable: 'keyword', page: { chunks: 3, unembedded: 2 },
      fix: { argv: ['gbrain', 'embed', '--stale', '--catch-up', '--source', source, '--yes'], consent: ['paid'],
        verify: { argv: ['gbrain', 'pages', 'status', 'notes/acme-example', '--source', source, '--json'] } } });
    expect(acme!.why).toContain('2 chunk(s) still wait for a vector');
    expect(stub).toMatchObject({ state: 'chunkless', searchable: false, page: { chunks: 0, unembedded: 0 }, fix: { argv: ['gbrain', 'embed', '--stale', '--catch-up', '--source', source, '--yes'] } });
    expect(junk).toMatchObject({ state: 'quarantined', searchable: false, fix: { ask_user: true, argv: ['gbrain', 'quarantine', 'clear', 'notes/junk-example', '--source-id', source, '--force'] } });
    expect(junk!.why).toContain('junk_pattern');
    expect(nobody).toMatchObject({ slug: 'notes/nobody-example', state: 'missing', searchable: false, page: null, source_path: null, fix: null });
    expect(gone).toMatchObject({ state: 'page_deleted', searchable: false, page: { deleted: true, chunks: 1 }, fix: null });
  }), 120_000);

  test('a held large page stays pending_embedding with the hold set; its fix is the held approval, asked first, and nothing is spent', () => each(async engine => {
    const source = await newSource(engine);
    const big = 'x'.repeat(1024 ** 2 + 4096);
    const held = await page(engine, source, 'notes/large-example', { body: big, vectors: [true, false, false] });
    const small = await page(engine, source, 'notes/small-example', { vectors: [false] });
    for (const id of [held, small]) {
      await engine.executeRaw("INSERT INTO page_embedding_budget (page_id, state, reason) VALUES ($1, 'held', 'upgrade_backfill')", [id]);
    }
    const out = await readPagesStatus(engine, source, ['notes/large-example', 'notes/small-example']);
    const [large, edited] = out.pages;
    expect(large).toMatchObject({ state: 'pending_embedding', searchable: 'keyword', page: { chunks: 3, unembedded: 2 },
      embedding_hold: { state: 'held', reason: 'upgrade_backfill', updated_at: expect.any(String) } });
    expect(large!.fix).toMatchObject({ ask_user: true, consent: ['paid', 'egress'], preview_argv: ['gbrain', 'embed', '--held', '--dry-run', '--source', source, '--json'] });
    expect(large!.fix!.argv!.slice(0, 5)).toEqual(['gbrain', 'embed', '--slugs', 'notes/large-example', '--source']);
    expect(large!.fix!.argv).toContain('--max-usd');
    expect(large!.why).toContain('wait for embedding approval');
    expect(edited).toMatchObject({ state: 'pending_embedding', embedding_hold: null, fix: { argv: ['gbrain', 'embed', '--stale', '--catch-up', '--source', source, '--yes'] } });
    const [budget] = await engine.executeRaw<{ state: string; spent_usd: number }>('SELECT state, spent_usd FROM page_embedding_budget WHERE page_id = $1', [held]);
    expect(budget).toMatchObject({ state: 'held', spent_usd: 0 });
    const [left] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE page_id = $1 AND embedding IS NULL', [held]);
    expect(Number(left!.n)).toBe(2);
  }), 120_000);

  test('the slugs filter narrows both halves of listEmbeddingStateRows', () => each(async engine => {
    const source = await newSource(engine);
    await page(engine, source, 'notes/alice-example', { vectors: [true] });
    await page(engine, source, 'notes/acme-example', { vectors: [false] });
    await page(engine, source, 'notes/stub-with-body');
    await page(engine, source, 'notes/other-example');
    const opts = { sourceIds: [source], states: EMBEDDING_STATES, limit: 100, purgeWindowHours: 72 };
    const all = await engine.listEmbeddingStateRows(opts);
    expect(all.map(r => r.slug).sort()).toEqual(['notes/acme-example', 'notes/alice-example', 'notes/other-example', 'notes/stub-with-body']);
    const some = await engine.listEmbeddingStateRows({ ...opts, slugs: ['notes/acme-example', 'notes/stub-with-body'] });
    expect(some.map(r => [r.slug, r.state])).toEqual([['notes/stub-with-body', 'chunkless_healable'], ['notes/acme-example', 'pending']]);
    expect(await engine.listEmbeddingStateRows({ ...opts, slugs: [] })).toEqual([]);
  }), 120_000);
});

describe('foresights pages status: Git', () => {
  const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content'); return git(root, 'rev-parse', 'HEAD'); };

  test('a page whose file sync holds names the hold (code exactly as readGitHold returns it) and uses its fix; a synced page reads in_synced_commit', () => each(async engine => {
    const id = `pst-${randomUUID().replace(/-/g, '').slice(0, 20)}`, repo = join(home, id);
    const write = (path: string, content: string) => { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), content); };
    mkdirSync(repo, { recursive: true }); git(repo, 'init', '-q');
    write('notes/alice-example.md', '---\ntitle: Alice Example\n---\nA synthetic observation.\n');
    write('notes/beta-example.md', '---\ntitle: Beta Example\n---\nAnother synthetic observation.\n');
    commit(repo);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, repo, '{}']);
    await claimWorktree(engine, id, repo);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const sync = () => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
    await sync();
    write('notes/beta-example.md', '---\ntitle: Beta Example\nslug: notes/acme-example\n---\nAnother synthetic observation, edited.\n');
    const head = commit(repo);
    await sync();
    const [src] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
    const record = await readGitHold(engine, id, src!.incarnation, 'notes/beta-example.md');
    expect(record).toMatchObject({ code: 'frontmatter_slug_conflict', page_id: expect.any(Number) });
    const out = await readPagesStatus(engine, id, ['notes/alice-example', 'notes/beta-example']);
    expect(out).toMatchObject({ source_id: id, last_commit: head, head, at_head: true });
    const [alice, beta] = out.pages;
    expect(alice).toMatchObject({ source_path: 'notes/alice-example.md', in_synced_commit: true, hold: null });
    expect(beta).toMatchObject({ source_path: 'notes/beta-example.md', in_synced_commit: true, hold: { code: record!.code, message: record!.message } });
    expect(beta!.page).toMatchObject({ slug: 'notes/beta-example', deleted: false });
    expect(beta!.why).toContain(`Sync holds its file notes/beta-example.md (${record!.code})`);
    expect(beta!.fix).toEqual(gitHoldFix(record!));
    write('notes/alice-example.md', '---\ntitle: Alice Example\n---\nA synthetic observation, edited after the sync.\n');
    const ahead = commit(repo);
    expect(await readPagesStatus(engine, id, ['notes/alice-example'])).toMatchObject({ last_commit: head, head: ahead, at_head: false });
  }), 240_000);
});

describe('foresights pages status: arguments', () => {
  test('no slug, an unknown option, or --source without a value is invalid_params before any read', async () => {
    const engine = engines[0]!;
    await expect(cli(engine, ['--json'])).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(cli(engine, ['notes/alice-example', '--state', 'pending'])).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(cli(engine, ['notes/alice-example', '--source'])).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(cli(engine, ['notes/alice-example', '--source', '--json'])).rejects.toMatchObject({ code: 'invalid_params' });
  });

  test('CLI: a missing page exits 0 with its state; no slug exits 2 with one invalid_params envelope', async () => {
    const h = makeDoctorHome('pages-status');
    try {
      expect((await runGbrain(h, ['init', '--pglite', '--no-embedding'])).exitCode).toBe(0);
      const missing = await runGbrain(h, ['pages', 'status', 'notes/nobody-example', '--json']);
      expect(missing.exitCode).toBe(0);
      expect(missing.json).toMatchObject({ source_id: 'default', pages: [{ slug: 'notes/nobody-example', state: 'missing', searchable: false }] });
      const bad = await runGbrain(h, ['pages', 'status', '--json']);
      expect(bad.exitCode).toBe(2);
      expect(bad.json).toMatchObject({ code: 'invalid_params' });
    } finally {
      h.cleanup();
    }
  }, 120_000);
});
