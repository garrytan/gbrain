/**
 * #6948: duplicate-origin twins no longer abort a source's managed sync. Through the public sync entry point
 * (`performSync`): only the twin file is held `origin_conflict`, the rest of the source syncs, and the sync-time heal
 * merges verified duplicates into the page the path names (links moved, slug kept as an alias, the twin soft-deleted
 * without touching the file, an `origin_twin_resolved` receipt with the restore command). Anything else stays a per-file
 * hold a person decides (`gbrain repair origin-twins` lists it; `--slug` only detaches). The kill switch, three
 * claimants, a tombstone beside a live claimant, deletion and dry runs, the merged twin's restore and purge, and the
 * `pages_live_origin_key` migration with and without twins. Master threw `page_identity_changed` for the whole source.
 *
 * PGLite and, with DATABASE_URL, Postgres. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { holdVerdict } from '../../src/core/persistence/sync-status.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { originIndexState } from '../../src/core/persistence/origin-index.ts';
import { v257 } from '../../src/core/schema-migrations/v257-pages-live-origin-key.ts';
import { originTwinsEntry } from '../../src/commands/doctor/checks/origin-twins.ts';
import { runRepairCommand } from '../../src/commands/repair.ts';
import { _resetCliExitVerdictForTests } from '../../src/core/cli-force-exit.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { dropOriginIndex } from '../helpers/origin-index.ts';
import { withEnv } from '../helpers/with-env.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message = 'synthetic content') => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); };
const note = (body: string, extra = '') => `---\ntitle: Example\n${extra}---\n${body}\n`;

async function capture(fn: () => Promise<void>): Promise<string> {
  let printed = '';
  const original = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try { await fn(); } finally { console.log = original; process.stdout.write = write; }
  return printed;
}

for (const backend of testBackends()) describe(`[${backend}] #6948 duplicate-origin twins in managed sync`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-6948-e2e-${backend}-`));
  const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GBRAIN_INTERACTIVE: '0', CI: '1' };
  const sync = (opts: Record<string, unknown>) => withEnv(env, () => performSync(engine, opts as Parameters<typeof performSync>[1]));
  const row = async (sourceId: string, slug: string) => (await engine.executeRaw<{ id: number; deleted_at: string | null; compiled_truth: string; source_path: string | null; database_only_reason: string | null }>(
    'SELECT id,deleted_at,compiled_truth,source_path,database_only_reason FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0] ?? null;
  const holds = async (sourceId: string) => (await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? [];
  const write = (sourceId: string, fn: (tx: BrainEngine) => Promise<unknown>) => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => fn(tx), TEST_WRITE_ATTRIBUTION));
  const context = (sourceId: string): OperationContext => ({ engine, config: { engine: backend, embedding_disabled: true } as never, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId });

  /** A managed git source: `alpha.md` synced into page `alpha`, `beta.md` into `beta`, plus extra live pages recording alpha.md. */
  async function source(twins: Array<{ slug: string; same?: boolean; frontmatter?: Record<string, unknown> }>) {
    const id = `ot-${randomUUID().replace(/-/g, '').slice(0, 12)}`, root = join(home, id);
    mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
    writeFileSync(join(root, 'alpha.md'), note('Alpha, version one.'));
    writeFileSync(join(root, 'beta.md'), note('Beta, version one.'));
    commit(root);
    await withEnv(env, async () => {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
      await claimWorktree(engine, id, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    });
    const opts = { sourceId: id, noPull: true, noEmbed: true, noExtract: true };
    expect((await sync(opts)).status).toBe('first_sync');
    const alpha = (await engine.executeRaw<{ compiled_truth: string; timeline: string; trust_tier: string }>('SELECT compiled_truth, timeline, trust_tier FROM pages WHERE source_id=$1 AND slug=$2', [id, 'alpha']))[0]!;
    for (const twin of twins) {
      // A twin sync imported under another slug carries the tier sync gave its file.
      await write(id, async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.write_trust_tier', $1, true)", [alpha.trust_tier]);
        await tx.putPage(twin.slug, { type: 'note', title: 'Example', compiled_truth: twin.same === false ? 'A different body.' : alpha.compiled_truth,
          timeline: alpha.timeline ?? '', frontmatter: twin.frontmatter ?? {}, content_hash: randomUUID() }, { sourceId: id });
        // Legacy data: no writer records a held origin on a second page any more, so the twin's origin is set directly.
        await tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [id, twin.slug, 'alpha.md']);
      });
    }
    return { id, root, opts };
  }

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
    // Twins exist only on brains written before this release, whose index is pending.
    await dropOriginIndex(engine);
  }, 120_000);
  afterAll(async () => {
    await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); });
    await engine.disconnect(); await closePostgres?.();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('contract: verified twins plus an unrelated edit sync without refusing; the heal merges the twin and the next sync imports the file', async () => {
    const f = await source([{ slug: 'alpha-copy', frontmatter: { aliases: ['Alpha Example'], tags: ['from-twin'], confirmed_by: 'alice-example' } }]);
    await write(f.id, async tx => {
      const [beta, twin] = await Promise.all(['beta', 'alpha-copy'].map(async slug => Number((await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [f.id, slug]))[0]!.id)));
      await tx.executeRaw("INSERT INTO links (from_page_id,to_page_id,link_type,link_source,context) VALUES ($1,$2,'cites','manual','beta cites the copy')", [beta, twin]);
    });
    writeFileSync(join(f.root, 'alpha.md'), note('Alpha, version two.'));
    writeFileSync(join(f.root, 'beta.md'), note('Beta, version two.'));
    commit(f.root, 'edit both');
    const result = await sync(f.opts);
    expect(result.status).toBe('synced');
    expect((await row(f.id, 'beta'))!.compiled_truth).toContain('version two');
    const heal = result.origin_twins_resolved!;
    expect(heal).toMatchObject({ resolved: 1, twins_merged: 1, failed: 0, resolved_paths: ['alpha.md'] });
    const receipt = heal.receipts[0] as Record<string, any>;
    expect(receipt).toMatchObject({ status: 'origin_twin_resolved', survivor_slug: 'alpha', twin_slug: 'alpha-copy', links_moved: 1,
      restore_argv: ['gbrain', 'restore', 'alpha-copy', '--source-id', f.id] });
    expect(receipt.dropped_frontmatter).toEqual({ aliases: ['Alpha Example'], tags: ['from-twin'], confirmed_by: 'alice-example' });
    const twin = (await row(f.id, 'alpha-copy'))!;
    expect(twin.deleted_at).not.toBeNull();
    expect(twin).toMatchObject({ source_path: null, database_only_reason: 'origin_twin' });
    expect(readFileSync(join(f.root, 'alpha.md'), 'utf8')).toBe(note('Alpha, version two.'));
    expect(existsSync(join(f.root, 'alpha-copy.md'))).toBe(false);
    const alphaId = (await row(f.id, 'alpha'))!.id;
    expect(await engine.executeRaw('SELECT context FROM links WHERE to_page_id=$1', [alphaId])).toEqual([{ context: 'beta cites the copy' }]);
    // The next sync re-screens the hold and imports the file into the survivor.
    const next = await sync(f.opts);
    expect(next.status).not.toBe('blocked_by_failures');
    expect((await row(f.id, 'alpha'))!.compiled_truth).toContain('version two');
    expect((await holds(f.id)).filter(h => h.code === 'origin_conflict')).toEqual([]);
    // gbrain get alpha-copy resolves to the survivor through the alias.
    const resolved = await engine.executeRaw<{ canonical_slug: string }>('SELECT canonical_slug FROM slug_aliases WHERE source_id=$1 AND alias_slug=$2', [f.id, 'alpha-copy']);
    expect(resolved).toEqual([{ canonical_slug: 'alpha' }]);
  }, 180_000);

  test('a merged twin restores as a database-only page (no file written) and an owner purge is refused', async () => {
    const f = await source([{ slug: 'alpha-copy' }]);
    expect((await sync({ ...f.opts, full: true })).origin_twins_resolved).toMatchObject({ resolved: 1 });
    const gone = (await engine.readPageSnapshot('alpha-copy', { sourceId: f.id, includeDeleted: true }))!;
    const restored = await withEnv(env, () => op('restore_page').handler(context(f.id), { slug: 'alpha-copy', source_id: f.id, request_id: randomUUID(), expected_revision: gone.revision })) as Record<string, any>;
    expect(restored.state ?? 'committed').toBe('committed');
    expect((await row(f.id, 'alpha-copy'))).toMatchObject({ deleted_at: null, source_path: null, database_only_reason: 'origin_twin' });
    expect(existsSync(join(f.root, 'alpha-copy.md'))).toBe(false);
    const snapshot = (await engine.readPageSnapshot('alpha-copy', { sourceId: f.id }))!;
    const purge = await withEnv(env, () => op('delete_page').handler(context(f.id), { slug: 'alpha-copy', source_id: f.id, request_id: randomUUID(), expected_revision: snapshot.revision, purge: true }))
      .then(() => null, error => error as OperationError);
    expect(purge?.code).toBe('source_changed');
    expect(purge?.message).toContain('merged into a duplicate that holds the same content');
    expect((await row(f.id, 'alpha'))!.deleted_at).toBeNull();
  }, 180_000);

  test('three verified claimants merge into the canonical page in one sync', async () => {
    const f = await source([{ slug: 'alpha-copy' }, { slug: 'archive/alpha' }]);
    const result = await sync({ ...f.opts, full: true });
    expect(result.origin_twins_resolved).toMatchObject({ resolved: 1, twins_merged: 2 });
    for (const slug of ['alpha-copy', 'archive/alpha']) expect((await row(f.id, slug))!.deleted_at).not.toBeNull();
    expect((await row(f.id, 'alpha'))).toMatchObject({ deleted_at: null, source_path: 'alpha.md' });
  }, 180_000);

  test('the kill switch off: the twin file stays held, the rest syncs, sync status lists the hold and nothing is deleted', async () => {
    const f = await source([{ slug: 'alpha-copy' }]);
    await engine.setConfig('sync.origin_twins.auto_resolve', 'false');
    try {
      writeFileSync(join(f.root, 'beta.md'), note('Beta, version two.')); commit(f.root, 'edit beta');
      const result = await sync({ ...f.opts, full: true });
      expect(result.status).toBe('synced');
      expect((await row(f.id, 'beta'))!.compiled_truth).toContain('version two');
      expect(result.origin_twins_resolved).toMatchObject({ skipped: 'disabled', resolved: 0 });
      expect((await row(f.id, 'alpha-copy'))!.deleted_at).toBeNull();
      const held = (await holds(f.id)).filter(h => h.code === 'origin_conflict');
      expect(held.map(h => [h.path, h.meta.reason ?? null, h.meta.canonical_slug])).toEqual([['alpha.md', null, 'alpha']]);
      expect(holdVerdict(held[0]!, undefined).needs_human).toBe(false);
    } finally { await engine.setConfig('sync.origin_twins.auto_resolve', 'true'); }
  }, 180_000);

  test('twins whose bodies differ are a decision: held with the reason, never merged; --slug only detaches, then the file imports', async () => {
    const f = await source([{ slug: 'alpha-copy', same: false }]);
    writeFileSync(join(f.root, 'alpha.md'), note('Alpha, version two.')); commit(f.root, 'edit alpha');
    const result = await sync(f.opts);
    expect(result.status).toBe('synced');
    expect(result.origin_twins_resolved).toMatchObject({ resolved: 0, left_by_reason: { content_differs: 1 } });
    const held = (await holds(f.id)).find(h => h.code === 'origin_conflict')!;
    expect(held.meta.reason).toBe('content_differs');
    expect(holdVerdict(held, undefined)).toMatchObject({ needs_human: true });
    expect((await row(f.id, 'alpha-copy'))!.deleted_at).toBeNull();
    _resetCliExitVerdictForTests();
    const preview = JSON.parse(await withEnv(env, () => capture(() => runRepairCommand(engine, ['origin-twins', '--source', f.id, '--json'])))).results[0];
    expect(preview.details.decisions.map((g: { reason: string }) => g.reason)).toEqual(['content_differs']);
    expect(preview.listing.map((l: { class: string }) => l.class)).toEqual(['decision:content_differs']);
    const keep = JSON.parse(await withEnv(env, () => capture(() => runRepairCommand(engine, ['origin-twins', '--source', f.id, '--slug', 'alpha', '--json'])))).results[0];
    expect(keep.listing.map((l: { class: string }) => l.class)).toEqual(['detach']);
    const applied = JSON.parse(await withEnv(env, () => capture(() => runRepairCommand(engine, ['origin-twins', '--source', f.id, '--slug', 'alpha', '--apply', '--expect', keep.preview_hash, '--yes', '--json'])))).results[0];
    expect(applied).toMatchObject({ applied: 1, failed: [] });
    expect((await row(f.id, 'alpha-copy'))).toMatchObject({ deleted_at: null, source_path: null, database_only_reason: 'origin_twin', compiled_truth: 'A different body.' });
    await sync(f.opts);
    expect((await row(f.id, 'alpha'))!.compiled_truth).toContain('version two');
    expect((await holds(f.id)).filter(h => h.code === 'origin_conflict')).toEqual([]);
  }, 180_000);

  test('trust tiers that differ hold trust_tier_differs; a merge never raises a tier', async () => {
    const f = await source([{ slug: 'alpha-copy' }]);
    await write(f.id, async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.write_trust_tier', 'unknown', true)");
      await tx.executeRaw("UPDATE pages SET trust_tier='unknown', title='Lowered' WHERE source_id=$1 AND slug='alpha-copy'", [f.id]);
    });
    expect((await engine.executeRaw<{ t: string }>("SELECT trust_tier AS t FROM pages WHERE source_id=$1 AND slug IN ('alpha','alpha-copy') ORDER BY slug", [f.id])).map(r => r.t)[0])
      .not.toBe((await engine.executeRaw<{ t: string }>("SELECT trust_tier AS t FROM pages WHERE source_id=$1 AND slug='alpha-copy'", [f.id]))[0]!.t);
    const result = await sync({ ...f.opts, full: true });
    expect(result.origin_twins_resolved).toMatchObject({ resolved: 0, left_by_reason: { trust_tier_differs: 1 } });
    expect((await row(f.id, 'alpha-copy'))!.deleted_at).toBeNull();
  }, 180_000);

  test('a live claimant beside a tombstone is no conflict; deleting a twin-held file and a dry run never refuse the source', async () => {
    const f = await source([{ slug: 'alpha-copy' }]);
    await write(f.id, tx => tx.executeRaw('UPDATE pages SET deleted_at=now() WHERE source_id=$1 AND slug=$2', [f.id, 'alpha-copy']));
    writeFileSync(join(f.root, 'alpha.md'), note('Alpha, version two.')); commit(f.root, 'edit alpha');
    expect((await sync(f.opts)).status).toBe('synced');
    expect((await row(f.id, 'alpha'))!.compiled_truth).toContain('version two');
    const g = await source([{ slug: 'alpha-copy' }]);
    rmSync(join(g.root, 'alpha.md')); commit(g.root, 'remove alpha');
    const dry = await sync({ ...g.opts, dryRun: true });
    expect(dry.status).toBe('dry_run');
    expect((await row(g.id, 'alpha-copy'))!.deleted_at).toBeNull();
    await engine.setConfig('sync.origin_twins.auto_resolve', 'false');
    try {
      const deleted = await sync(g.opts);
      expect(deleted.status).toBe('synced');
      expect((await holds(g.id)).filter(h => h.code === 'origin_conflict').map(h => h.path)).toEqual(['alpha.md']);
      expect((await row(g.id, 'alpha'))!.deleted_at).toBeNull();
    } finally { await engine.setConfig('sync.origin_twins.auto_resolve', 'true'); }
  }, 180_000);

  test('the migration with twins writes nothing and leaves the index pending (doctor says so); the repair apply then builds it', async () => {
    const f = await source([{ slug: 'alpha-copy' }]);
    const pages = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NULL'))[0]!.n;
    const before = await pages();
    await v257.handler!(engine);
    expect(await originIndexState(engine)).toBe('missing');
    expect(await pages()).toBe(before);
    const pending = ((await originTwinsEntry.run({ engine } as never)) as Array<{ name: string; status: string; message: string }>)[0]!;
    expect(pending).toMatchObject({ name: 'origin_twins', status: 'warn' });
    expect(pending.message).toContain('Index pending');
    expect(pending.message).toContain(`source ${f.id} has 1 file(s) recorded by several live pages`);
    expect(pending.message).toContain('Preview the fix with gbrain repair origin-twins --source ');
    // Resolve every source's twins with the repair (earlier tests left groups only where a person decides; resolve them by keeping alpha).
    const sources = await engine.executeRaw<{ source_id: string }>(`SELECT DISTINCT source_id FROM pages WHERE deleted_at IS NULL AND source_path IS NOT NULL
      GROUP BY source_id, source_path HAVING count(*) > 1`);
    for (const { source_id } of sources) {
      for (const args of [[], ['--slug', 'alpha']]) {
        const preview = JSON.parse(await withEnv(env, () => capture(() => runRepairCommand(engine, ['origin-twins', '--source', source_id, ...args, '--json'])))).results[0];
        if (!preview.listing?.some((l: { class: string }) => !l.class.startsWith('decision'))) continue;
        await withEnv(env, () => capture(() => runRepairCommand(engine, ['origin-twins', '--source', source_id, ...args, '--apply', '--expect', preview.preview_hash, '--yes', '--json'])));
      }
    }
    expect(await originIndexState(engine)).toBe('present');
    expect(((await originTwinsEntry.run({ engine } as never)) as Array<{ status: string }>)[0]).toMatchObject({ status: 'ok' });
    // With the index present, a second live claim on an origin is refused: by the writer guard, and by the database
    // for a statement that skips the guard.
    const refused = await write(f.id, tx => tx.putPage('alpha-third', { type: 'note', title: 'x', compiled_truth: 'x', timeline: '', frontmatter: {}, content_hash: 'x', source_path: 'alpha.md' }, { sourceId: f.id }))
      .then(() => 'written', () => 'refused');
    expect(refused).toBe('refused');
    const unguarded = await engine.executeRaw("UPDATE pages SET source_path='alpha.md' WHERE source_id=$1 AND slug='beta'", [f.id])
      .then(() => 'written', (error: { code?: unknown }) => String(error.code));
    expect(unguarded).toBe('23505');
    // The migration on a clean brain builds it (and is idempotent).
    await v257.handler!(engine);
    expect(await originIndexState(engine)).toBe('present');
  }, 300_000);
});
