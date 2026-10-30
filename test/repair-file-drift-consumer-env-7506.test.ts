/**
 * #7506: a held file-drift apply refused items as "Reconciliation preview is stale: policy_digest" although no reconcile
 * policy input had changed.
 *   - Any persistence consumer on the owner host may claim, prepare and publish an admitted reconcile request (a resident
 *     serve or jobs worker as well as the applying CLI). Each one recomputes the preview's policy digest, and the digest
 *     folded in that process's whole environment (credentials, database URLs, model choices), so a request prepared by a
 *     consumer whose environment differed from the previewing process's read stale. On a diverged checkout the applying
 *     CLI's own consumer is held by its keep-checkout publishes, so its requests fell to the resident consumers.
 *   - After: the digest covers what a reconcile reads (the database config plane, the config file, the content-sanity
 *     overrides the environment sets, the operator literals, GBRAIN_NO_SANITY and the source row), so an environment that
 *     differs only in credentials and model choices applies every item, and a real policy change still refuses.
 * Real PGLite (and Postgres when DATABASE_URL is set), a claimed canonical Git worktree whose remote diverged (its Git
 * effects park on integrate_conflict through the real keep-checkout publish child), real files; the apply runs under a
 * different process environment, as a resident consumer does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { reconcilePolicyDigest } from '../src/core/persistence/reconcile-state.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { git } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import type { ProgressReporter } from '../src/core/progress.ts';
import { heapStats } from 'bun:jsc';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const logger = { info() {}, warn() {}, error() {} };
const page = (title: string, body: string) => `---\ntype: note\ntitle: ${title}\n---\n${body}\n`;
/** The environment a resident consumer may run with: other credentials and model choices, nothing a reconcile reads. */
const RESIDENT_ENV = { OPENAI_API_KEY: 'sk-resident-example', ANTHROPIC_API_KEY: 'sk-ant-resident-example', GBRAIN_CHAT_MODEL: 'anthropic:resident-example',
  GBRAIN_EXPANSION_MODEL: 'openai:resident-example' };
const PREVIEW_ENV = { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GBRAIN_CHAT_MODEL: undefined, GBRAIN_EXPANSION_MODEL: undefined,
  GBRAIN_PAGE_WARN_BYTES: undefined, GBRAIN_NO_SANITY: undefined };

for (const backend of testBackends()) describe(`#7506: a held file-drift apply over a diverged checkout (${backend})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    if (backend === 'pglite') {
      const pglite = new PGLiteEngine();
      await pglite.connect({}); await pglite.initSchema(); engine = pglite;
    } else {
      const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
      engine = pg.engine; closePostgres = pg.close;
    }
    await registerLocalWriter(engine, 'cli');
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    if (closePostgres) await closePostgres(); else await engine.disconnect();
  });

  interface Fixture { home: string; root: string; sourceId: string; slugs: string[] }
  /**
   * `count` pages whose canonical files were then edited and committed on this host, each held as unknown-side file drift,
   * in a checkout whose remote moved under a page this host also changed: every Git effect's keep-checkout publish refuses
   * with integrate_conflict, as on a diverged brain.
   */
  async function fixture(count: number, run: (f: Fixture) => Promise<void>, padding = ''): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-7506-'));
    const cli = join(home, 'gbrain-child');
    writeFileSync(cli, `#!/bin/sh\nexec '${process.execPath}' '${resolve(import.meta.dir, '../src/cli.ts')}' "$@"\n`);
    chmodSync(cli, 0o700);
    const sourceId = `d7506-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ ...PREVIEW_ENV, GBRAIN_HOME: join(home, 'home'), GBRAIN_AUDIT_DIR: join(home, 'audit'), GBRAIN_SOURCE: undefined,
        GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', GBRAIN_JOB_CHILD_CLI: cli }, async () => {
        // An installed brain has a config file, so every process folds its own environment over it.
        mkdirSync(join(home, 'home', '.gbrain'), { recursive: true });
        writeFileSync(join(home, 'home', '.gbrain', 'config.json'), JSON.stringify({ engine: engine.kind }));
        const remote = join(home, 'remote.git'), root = join(home, 'brain'), other = join(home, 'other');
        git(home, 'init', '-q', '--bare', '-b', 'main', remote);
        mkdirSync(join(root, 'notes'), { recursive: true });
        git(root, 'init', '-q', '-b', 'main');
        git(root, 'config', 'user.name', 'Example Writer'); git(root, 'config', 'user.email', 'writer@example.invalid');
        writeFileSync(join(root, 'initial.md'), 'Initial\n');
        git(root, 'add', 'initial.md'); git(root, 'commit', '-q', '-m', 'Initial');
        git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', '-u', 'origin', 'main');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        const binding = await claimWorktree(engine, sourceId, root, localHostId());
        await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled' WHERE worktree_id=$1::uuid", [binding.worktree_id]);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
        const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
        const put = async (slug: string, body: string) => {
          const live = await engine.readPageSnapshot(slug, { sourceId });
          await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: page(slug, body), request_id: randomUUID(), ...(live ? { expected_revision: live.revision } : {}) } });
        };
        const slugs = Array.from({ length: count }, (_, i) => `notes/drift-${String(i).padStart(3, '0')}`);
        await put('notes/shared', 'This host, first.');
        for (const slug of slugs) await put(slug, `The database side of ${slug}.${padding}`);
        await waitForEffects(sourceId, 0);
        git(home, 'clone', '-q', remote, other);
        git(other, 'config', 'user.name', 'Other Machine'); git(other, 'config', 'user.email', 'other@example.invalid');
        writeFileSync(join(other, 'notes/shared.md'), page('notes/shared', 'The other machine.'));
        git(other, 'commit', '-q', '-am', 'Other machine edits the shared page'); git(other, 'push', '-q');
        await put('notes/shared', 'This host, second.');
        await waitForEffects(sourceId, 1);
        for (const slug of slugs) writeFileSync(join(root, `${slug}.md`), page(slug, `The file side of ${slug}.${padding}`));
        git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'Local edits');
        for (const slug of slugs) {
          const live = (await engine.readPageSnapshot(slug, { sourceId }))!;
          await engine.transaction(tx => writeGitHold(tx, { source_id: sourceId, incarnation: source!.incarnation, path: `${slug}.md`, source_path: `${slug}.md`, slug,
            page_id: Number(live.page.id), code: 'file_drift', message: `${slug}.md is held: file drift (unknown)`, upstream_version: null, observed_at: new Date().toISOString(),
            run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, side: 'unknown', page_revision: live.revision } }));
        }
        await run({ home, root, sourceId, slugs });
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
      rmSync(home, { recursive: true, force: true });
    }
  }
  const gitEffects = (sourceId: string) => engine.executeRaw<{ state: string; error_code: string | null }>(
    "SELECT e.state,e.error_code FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='git' AND r.source_id=$1", [sourceId]);
  /** Waits until the Git effects have settled: every one committed except `conflicts` held on integrate_conflict. */
  async function waitForEffects(sourceId: string, conflicts: number): Promise<void> {
    for (let i = 0; i < 300; i++) {
      const rows = await gitEffects(sourceId);
      if (rows.filter(row => row.error_code === 'integrate_conflict').length === conflicts && rows.every(row => row.state === 'committed' || row.error_code === 'integrate_conflict')) return;
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error('the Git effects did not settle');
  }
  const run = async (sourceId: string, expectHash?: string, progress?: ProgressReporter) => (await repairRunner(engine, { apply: expectHash !== undefined, logger })).run('file-drift',
    await resolveRepairScope(engine, sourceId), { explicit: true, sourceFlag: sourceId, prefer: 'file', held: true, side: 'unknown', ...(expectHash ? { expect: expectHash } : {}),
      ...(progress ? { progress } : {}) });
  /** The live heap after a full collection at each applied item, in MB. */
  async function applyHeap(sourceId: string, expectHash: string, env: Record<string, string | undefined>): Promise<{ result: Awaited<ReturnType<typeof run>>; heap: number[] }> {
    const heap: number[] = [];
    const progress = { start() {}, tick() { Bun.gc(true); heap.push(heapStats().heapSize / 1e6); }, heartbeat() {}, finish() {}, child: () => progress } as unknown as ProgressReporter;
    const result = await withEnv(env, () => run(sourceId, expectHash, progress));
    return { result, heap };
  }
  const outcomes = (result: Awaited<ReturnType<typeof run>>) => (result.outcome_items ?? []).map(item => `${item.outcome}${item.detail?.message ? `: ${item.detail.message}` : ''}`);

  test('a consumer whose environment differs only in credentials and model choices applies every held item', () => fixture(4, async f => {
    const preview = await run(f.sourceId);
    expect(preview.affected).toBe(4);
    const applied = await withEnv(RESIDENT_ENV, () => run(f.sourceId, preview.preview_hash!));
    expect(outcomes(applied)).toEqual(['repaired', 'repaired', 'repaired', 'repaired']);
    for (const slug of f.slugs) expect((await engine.readPageSnapshot(slug, { sourceId: f.sourceId }))!.page.compiled_truth).toContain(`The file side of ${slug}.`);
    // The checkout is still diverged: its Git effects hold on the parked conflict, and every file keeps the file side.
    expect((await gitEffects(f.sourceId)).filter(row => row.error_code === 'integrate_conflict').length).toBeGreaterThanOrEqual(1);
    for (const slug of f.slugs) expect(readFileSync(join(f.root, `${slug}.md`), 'utf8')).toContain(`The file side of ${slug}.`);
  }), 240_000);

  test('a content-sanity override the applying environment sets still refuses every item as stale', () => fixture(2, async f => {
    const preview = await run(f.sourceId);
    const applied = await withEnv({ ...RESIDENT_ENV, GBRAIN_PAGE_WARN_BYTES: '4096' }, () => run(f.sourceId, preview.preview_hash!));
    expect(outcomes(applied)).toEqual(['changed_since_preview: Reconciliation preview is stale: policy_digest.', 'changed_since_preview: Reconciliation preview is stale: policy_digest.']);
    for (const slug of f.slugs) expect((await engine.readPageSnapshot(slug, { sourceId: f.sourceId }))!.page.compiled_truth).toContain(`The database side of ${slug}.`);
  }), 240_000);

  test('the policy digest still moves with every reconcile input, and not with credentials or model choices', () => fixture(1, async f => {
    const base = await reconcilePolicyDigest(engine, f.sourceId);
    const same = async (env: Record<string, string | undefined>) => withEnv(env, () => reconcilePolicyDigest(engine, f.sourceId));
    expect(await same(RESIDENT_ENV)).toBe(base);
    expect(await same({ GBRAIN_DATABASE_URL: 'postgresql://resident.example.invalid/brain', GBRAIN_EMBEDDING_MODEL: 'openai:resident-example' })).toBe(base);
    expect(await same({ GBRAIN_NO_SANITY: '1' })).not.toBe(base);
    expect(await same({ GBRAIN_PAGE_BLOCK_BYTES: '65536' })).not.toBe(base);
    const configDir = join(f.home, 'home', '.gbrain');
    writeFileSync(join(configDir, 'junk-substrings.txt'), 'acme-example placeholder\n');
    const literal = await reconcilePolicyDigest(engine, f.sourceId);
    expect(literal).not.toBe(base);
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ engine: engine.kind, content_sanity: { bytes_warn: 8192 } }));
    const file = await reconcilePolicyDigest(engine, f.sourceId);
    expect(file).not.toBe(literal);
    await engine.setConfig('content_sanity.junk_disposition', 'reject');
    const database = await reconcilePolicyDigest(engine, f.sourceId);
    expect(database).not.toBe(file);
    await engine.unsetConfig('content_sanity.junk_disposition');
    await engine.executeRaw(`UPDATE sources SET config=COALESCE(config,'{}'::jsonb)||'{"trust":{"owner_default":"external"}}'::jsonb WHERE id=$1`, [f.sourceId]);
    expect(await reconcilePolicyDigest(engine, f.sourceId)).not.toBe(file);
  }), 240_000);

  // The apply's live heap stays flat across its items, whether they land or go stale: nothing an item reads (its preview
  // page, preimages, request, receipt) is kept once the item settles.
  test('the apply holds no memory per item, landed or stale', () => fixture(8, async f => {
    const preview = await run(f.sourceId);
    const stale = await applyHeap(f.sourceId, preview.preview_hash!, { GBRAIN_PAGE_WARN_BYTES: '4096' });
    expect(stale.result.outcomes).toEqual({ changed_since_preview: 8 });
    const again = await run(f.sourceId);
    const landed = await applyHeap(f.sourceId, again.preview_hash!, RESIDENT_ENV);
    expect(landed.result.outcomes).toEqual({ repaired: 8 });
    for (const { heap } of [stale, landed]) {
      expect(heap).toHaveLength(8);
      expect(Math.min(...heap.slice(-2)) - Math.max(...heap.slice(0, 2))).toBeLessThan(24);
    }
  }, 'x'.repeat(64 * 1024)), 240_000);
});
