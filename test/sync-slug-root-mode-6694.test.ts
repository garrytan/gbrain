/**
 * #6694: a managed-sync checkpoint and the source's pinned slug-root mode (`sources.config.slug_root_mode`).
 *
 * Protects: a source rooted at its repository root checkpoints under either pin (both modes give it identical slugs)
 * and keeps the pin it has; a subdirectory source checkpoints under its pin; a pin that changes under a run of a
 * subdirectory source is refused as `slug_root_mode_mismatch`, not as a concurrent-writer `revision_conflict`; and a
 * plain `gbrain sync --no-pull` recovers a checkpoint that already failed that way.
 * Regression it catches: discovery hardcodes `git-root` at an empty scope while the guard compares the pin, so a
 * `source-root` pin on a root source never checkpoints. No existing test syncs a root source with a pin.
 * Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readManagedSyncFailures } from '../src/core/persistence/sync-failures.ts';
import { classifyManagedSyncOrphans, retireManagedSyncOrphan } from '../src/core/persistence/managed-sync-orphans.ts';
import { classifySyncFault } from '../src/core/persistence/sync-fault-class.ts';
import { CODES } from '../src/core/error-registry.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

type Mode = 'git-root' | 'source-root';
const home = mkdtempSync(join(tmpdir(), 'gbrain-slug-mode-6694-'));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (repo: string, message: string) => { git(repo, 'add', '-A'); git(repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(repo, 'rev-parse', 'HEAD'); };
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation about ${title}.\n`;

describe('#6694 managed-sync checkpoint under a pinned slug_root_mode', () => {
  const engines: BrainEngine[] = [];
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (testBackends().includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
    if (testBackends().includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
    await closePostgres?.(); rmSync(home, { recursive: true, force: true });
  });
  const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined },
    async () => { for (const engine of engines) await fn(engine); });

  async function fixture(engine: BrainEngine, scope: string, pin: Mode | null) {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const id = `slugmode-${randomUUID().slice(0, 12)}`, repo = join(home, id), root = scope ? join(repo, scope) : repo;
    mkdirSync(root, { recursive: true }); git(repo, 'init', '-q');
    if (scope) writeFileSync(join(repo, 'README.md'), 'Repository text outside the source.\n');
    for (const name of ['alpha', 'beta', 'gamma']) { const file = join(root, 'notes', `${name}.md`); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, note(name)); }
    const head = commit(repo, 'seed');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, JSON.stringify(pin ? { slug_root_mode: pin } : {})]);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
    return { id, repo, root, head, opts };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const source = async (engine: BrainEngine, f: Fixture) => (await engine.executeRaw<{ last_commit: string | null; mode: string | null }>(
    "SELECT last_commit, config->>'slug_root_mode' AS mode FROM sources WHERE id=$1", [f.id]))[0]!;
  const slugs = async (engine: BrainEngine, f: Fixture) => (await engine.executeRaw<{ slug: string }>(
    'SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [f.id])).map(row => row.slug);
  /** Runs until every page committed and stops before the checkpoint publishes. */
  async function beforeCheckpoint(engine: BrainEngine, f: Fixture, pages: number) {
    const abort = new AbortController();
    const partial = await performManagedSync(engine, { ...f.opts, signal: abort.signal, onProgress: p => { if (p.bankedFiles === pages) abort.abort(); } });
    expect(partial).toMatchObject({ status: 'partial', filesImported: pages });
  }
  /** A checkpoint column only the owner publishes; the test edits it with managed persistence switched off for the statement. */
  async function unmanaged(engine: BrainEngine, fn: () => Promise<unknown>) {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    try { await fn(); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
  }
  const outcome = (run: Promise<unknown>) => run.then(value => value as Record<string, unknown>, error => ({ thrown: error as { code?: string; message?: string } }));
  const checkpoint = async (engine: BrainEngine, f: Fixture) => (await engine.executeRaw<{ state: string; error_code: string | null; error_message: string | null }>(
    `SELECT state, error_code, error_message FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_checkpoint' ORDER BY sequence DESC LIMIT 1`, [f.id]))[0];

  test.each([['source-root'], ['git-root']] as const)('a source rooted at its repository root, pinned %s, checkpoints and keeps its pin', async pin => each(async engine => {
    const f = await fixture(engine, '', pin);
    expect(await outcome(performManagedSync(engine, f.opts))).toMatchObject({ status: 'first_sync' });
    expect(await source(engine, f)).toEqual({ last_commit: f.head, mode: pin });
    expect(await slugs(engine, f)).toEqual(['notes/alpha', 'notes/beta', 'notes/gamma']);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
  }), 120_000);

  test('an unpinned root source still pins git-root at its first checkpoint', async () => each(async engine => {
    const f = await fixture(engine, '', null);
    expect(await outcome(performManagedSync(engine, f.opts))).toMatchObject({ status: 'first_sync' });
    expect(await source(engine, f)).toEqual({ last_commit: f.head, mode: 'git-root' });
  }), 120_000);

  test.each([['source-root', ['notes/alpha', 'notes/beta', 'notes/gamma']], ['git-root', ['brain/notes/alpha', 'brain/notes/beta', 'brain/notes/gamma']]] as const)(
    'a subdirectory source pinned %s checkpoints under its pin', async (pin, expected) => each(async engine => {
      const f = await fixture(engine, 'brain', pin);
      expect(await outcome(performManagedSync(engine, f.opts))).toMatchObject({ status: 'first_sync' });
      expect(await source(engine, f)).toEqual({ last_commit: f.head, mode: pin });
      expect(await slugs(engine, f)).toEqual([...expected]);
    }), 120_000);

  test('a pin changed under a run of a subdirectory source is refused as slug_root_mode_mismatch; restoring the pin lets a plain sync finish', async () => each(async engine => {
    const f = await fixture(engine, 'brain', 'source-root');
    await beforeCheckpoint(engine, f, 3);
    await engine.executeRaw(`UPDATE sources SET config=jsonb_set(config,'{slug_root_mode}','"git-root"') WHERE id=$1`, [f.id]);
    const refused = await outcome(performManagedSync(engine, f.opts));
    expect(JSON.stringify(refused)).toContain('slug_root_mode_mismatch');
    expect(await checkpoint(engine, f)).toMatchObject({ error_code: 'slug_root_mode_mismatch' });
    expect((await checkpoint(engine, f))!.error_message).toContain('pins slug_root_mode=git-root, but this sync ran under source-root');
    expect(await source(engine, f)).toEqual({ last_commit: null, mode: 'git-root' });
    expect(classifySyncFault({ code: 'slug_root_mode_mismatch' })).toMatchObject({ class: 'systemic', needs_human: true });
    expect(CODES.slug_root_mode_mismatch.fix?.argv).toEqual(['gbrain', 'sync', 'status', '--source', '{source_id}', '--json']);
    // Still mismatched: a plain rerun stays refused under the named code.
    expect(JSON.stringify(await outcome(performManagedSync(engine, f.opts)))).toContain('slug_root_mode_mismatch');
    await engine.executeRaw(`UPDATE sources SET config=jsonb_set(config,'{slug_root_mode}','"source-root"') WHERE id=$1`, [f.id]);
    expect(await outcome(performManagedSync(engine, f.opts))).toMatchObject({ status: 'first_sync' });
    expect(await source(engine, f)).toEqual({ last_commit: f.head, mode: 'source-root' });
    expect(await slugs(engine, f)).toEqual(['notes/alpha', 'notes/beta', 'notes/gamma']);
  }), 120_000);

  // #6712 PR 3 (L7): --retry-failed is a plain sync now, so keeping the pin is the orphan repair's preview-first retirement.
  test('keeping a changed pin: no sync rediscovers it, and retiring the slug_mode_refused cursor discovers the subdirectory source again under it, beside the pages the refused run wrote', async () => each(async engine => {
    const f = await fixture(engine, 'brain', 'source-root');
    await beforeCheckpoint(engine, f, 3);
    await engine.executeRaw(`UPDATE sources SET config=jsonb_set(config,'{slug_root_mode}','"git-root"') WHERE id=$1`, [f.id]);
    expect(JSON.stringify(await outcome(performManagedSync(engine, f.opts)))).toContain('slug_root_mode_mismatch');
    for (const retryFailed of [false, true]) expect(JSON.stringify(await outcome(performManagedSync(engine, { ...f.opts, retryFailed })))).toContain('slug_root_mode_mismatch');
    expect(await source(engine, f)).toEqual({ last_commit: null, mode: 'git-root' });
    const [refused] = (await classifyManagedSyncOrphans(engine, [f.id])).orphans;
    expect(refused).toMatchObject({ kind: 'unfinished_cursor', reason: 'slug_mode_refused' });
    expect((await retireManagedSyncOrphan(engine, refused!)).cursor).toBe(true);
    const retried = await outcome(performManagedSync(engine, f.opts));
    expect(retried).not.toHaveProperty('thrown');
    expect(await source(engine, f)).toEqual({ last_commit: f.head, mode: 'git-root' });
    // The pages the refused run wrote under source-root keep their slugs beside the git-root ones; that is the cost the user accepts.
    expect(await slugs(engine, f)).toEqual(['brain/notes/alpha', 'brain/notes/beta', 'brain/notes/gamma', 'notes/alpha', 'notes/beta', 'notes/gamma']);
  }), 120_000);

  test('a plain sync recovers a root source whose checkpoint already failed revision_conflict under a source-root pin', async () => each(async engine => {
    const f = await fixture(engine, '', 'source-root');
    await beforeCheckpoint(engine, f, 3);
    // The receipt older releases left: the checkpoint guard refused with the moved-checkpoint revision_conflict.
    await unmanaged(engine, () => engine.executeRaw("UPDATE sources SET last_commit='0000000000000000000000000000000000000000' WHERE id=$1", [f.id]));
    expect(JSON.stringify(await outcome(performManagedSync(engine, f.opts)))).toContain('revision_conflict');
    expect(await checkpoint(engine, f)).toMatchObject({ error_code: 'revision_conflict', error_message: 'The source checkpoint changed during this sync.' });
    await unmanaged(engine, () => engine.executeRaw('UPDATE sources SET last_commit=NULL WHERE id=$1', [f.id]));
    const recovered = await outcome(performManagedSync(engine, f.opts));
    expect(recovered).toMatchObject({ status: 'first_sync' });
    expect(await source(engine, f)).toEqual({ last_commit: f.head, mode: 'source-root' });
    expect(await checkpoint(engine, f)).toMatchObject({ state: 'committed', error_code: null });
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
  }), 120_000);
});
