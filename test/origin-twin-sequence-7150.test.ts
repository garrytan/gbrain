/**
 * #7150: the production sequence behind #6948, replayed end to end on a managed source against current master. A legacy
 * page with no recorded origin sits beside the page that records a file, with the same body; the source is trust-claimed
 * (the `trust_claim` channel the second page's history showed), a writer then tries to give the legacy page the held
 * origin, file repair targets the file, and finally the twin state an older foresights left behind meets a sync. Before #6948
 * the twin stopped every managed sync of the source with `page_identity_changed` naming one slug. Now:
 *
 * - the trust claim re-tiers rows and assigns no origin;
 * - every origin-assigning writer refuses a second live claimant and names the page that records the file;
 * - file repair resolves the file to the page its path names and refuses the twin;
 * - a sync holds only the twin-claimed file, names every claimant, syncs the rest, and the sync-time heal merges a
 *   same-body twin into the canonical page with an `origin_twin_resolved` receipt; a twin whose body differs stays a per-file
 *   hold for a person and never stops the source.
 *
 * PGLite and, with DATABASE_URL, Postgres. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { canonicalOriginPage } from '../src/core/persistence/origin-guard.ts';
import { prepareDriftPage } from '../src/core/repair/file-drift.ts';
import { liftClaimedSources, recordSourceClaims } from '../src/core/trust/claim.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { dropOriginIndex } from './helpers/origin-index.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'synthetic content'); };
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;
const FILE = 'projects/note-example.md', CANONICAL = 'projects/note-example', TWIN = 'ideas/note-example';

async function refusal(run: () => Promise<unknown>): Promise<Error & { code?: string; detail?: string }> {
  try { await run(); } catch (error) { return error as Error & { code?: string; detail?: string }; }
  throw new Error('expected the write to be refused, but it succeeded');
}

for (const backend of testBackends()) describe(`[${backend}] #7150 the origin-twin sequence cannot stop a managed source`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), `gbrain-7150-${backend}-`));
  const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GBRAIN_INTERACTIVE: '0', CI: '1' };
  const sync = (opts: Record<string, unknown>) => withEnv(env, () => performSync(engine, opts as Parameters<typeof performSync>[1]));
  const page = async (sourceId: string, slug: string) => (await engine.executeRaw<{ deleted_at: string | null; compiled_truth: string; source_path: string | null }>(
    'SELECT deleted_at, compiled_truth, source_path FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]))[0] ?? null;
  const write = (sourceId: string, fn: (tx: BrainEngine) => Promise<unknown>) => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => fn(tx), TEST_WRITE_ATTRIBUTION));

  /** The canonical page synced from FILE, plus a legacy page with no origin carrying the same body. */
  async function shape(twinBody?: string) {
    const id = `ot7150-${randomUUID().replace(/-/g, '').slice(0, 12)}`, root = join(home, id);
    mkdirSync(join(root, 'projects'), { recursive: true }); mkdirSync(join(root, 'notes'));
    git(root, 'init', '-q');
    writeFileSync(join(root, FILE), note('A synthetic project note.'));
    writeFileSync(join(root, 'notes/other.md'), note('Another note, version one.'));
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
    const canonical = (await engine.executeRaw<{ compiled_truth: string; timeline: string; trust_tier: string }>(
      'SELECT compiled_truth, timeline, trust_tier FROM pages WHERE source_id=$1 AND slug=$2', [id, CANONICAL]))[0]!;
    await write(id, async tx => {
      await tx.executeRaw("SELECT set_config('gbrain.write_trust_tier', $1, true)", [canonical.trust_tier]);
      await tx.putPage(TWIN, { type: 'note', title: 'Example', compiled_truth: twinBody ?? canonical.compiled_truth, timeline: canonical.timeline ?? '', frontmatter: {},
        content_hash: randomUUID() }, { sourceId: id });
    });
    expect((await page(id, TWIN))!.source_path).toBeNull();
    return { id, root, opts };
  }

  /** What an older foresights left: the legacy page records the held file too (no current writer can, so it is set directly). */
  async function legacyTwin(sourceId: string) {
    await dropOriginIndex(engine);
    await write(sourceId, tx => tx.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [sourceId, TWIN, FILE]));
  }

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => {
    await withEnv(env, async () => { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); });
    await engine.disconnect(); await closePostgres?.();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('trust claim, then an origin assignment, then file repair, then sync: no step creates a twin, and a legacy twin heals with a receipt while the rest syncs', async () => {
    const f = await shape();
    // 1. The trust claim re-tiers the source's legacy rows and assigns no origin.
    await withEnv(env, async () => { await recordSourceClaims(engine, [f.id]); await liftClaimedSources(engine); });
    expect((await page(f.id, TWIN))!.source_path).toBeNull();
    // 2. A writer giving the legacy page the held origin is refused and names the page that records the file.
    const assigned = await refusal(() => write(f.id, tx => tx.putPage(TWIN, { type: 'note', title: 'Example', compiled_truth: 'Moved.', source_path: FILE }, { sourceId: f.id })));
    expect(assigned).toMatchObject({ code: 'page_identity_changed', detail: 'origin_already_claimed' });
    expect(assigned.message + String((assigned as { hint?: string }).hint ?? '')).toContain(FILE);
    expect((await page(f.id, TWIN))!.source_path).toBeNull();
    // 3. The state an older foresights left. File repair resolves the file to the page its path names and refuses the twin.
    await legacyTwin(f.id);
    expect(await canonicalOriginPage(engine, f.id, FILE)).toMatchObject({ slug: CANONICAL });
    expect(await refusal(() => prepareDriftPage(engine, f.id, TWIN, 'file', new Date().toISOString()))).toMatchObject({ code: 'page_identity_changed', detail: 'origin_conflict' });
    // 4. A sync with an unrelated edit: the source syncs, and the heal merges the same-body twin with a receipt.
    writeFileSync(join(f.root, 'notes/other.md'), note('Another note, version two.'));
    commit(f.root);
    const result = await sync(f.opts);
    expect(result.status).toBe('synced');
    expect((await page(f.id, 'notes/other'))!.compiled_truth).toContain('version two');
    expect(result.origin_twins_resolved).toMatchObject({ resolved: 1, failed: 0, resolved_paths: [FILE] });
    expect(result.origin_twins_resolved!.receipts[0]).toMatchObject({ status: 'origin_twin_resolved', survivor_slug: CANONICAL, twin_slug: TWIN,
      restore_argv: ['gbrain', 'restore', TWIN, '--source-id', f.id] });
    expect((await page(f.id, TWIN))!.deleted_at).not.toBeNull();
    expect((await page(f.id, CANONICAL))!.deleted_at).toBeNull();
  }, 180_000);

  test('a legacy twin whose body differs is held for that file alone, naming every claimant, and never stops the source', async () => {
    const f = await shape('A different body the file does not carry.');
    await legacyTwin(f.id);
    writeFileSync(join(f.root, 'notes/other.md'), note('Another note, version two.'));
    commit(f.root);
    const result = await withEnv(env, () => performManagedSync(engine, f.opts));
    expect(result.status).toBe('synced');
    expect((await page(f.id, 'notes/other'))!.compiled_truth).toContain('version two');
    const held = ((await readGitSourceHolds(engine, { sourceIds: [f.id] }))[0]?.holds ?? []).filter(hold => hold.code === 'origin_conflict');
    expect(held.map(hold => [hold.path, hold.meta.reason, hold.meta.canonical_slug, (hold.meta.origin_claimants ?? []).map(claimant => claimant.slug).sort()]))
      .toEqual([[FILE, 'content_differs', CANONICAL, [TWIN, CANONICAL].sort()]]);
    expect((await page(f.id, TWIN))!.deleted_at).toBeNull();
  }, 180_000);
});
