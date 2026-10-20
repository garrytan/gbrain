/**
 * #6712 PR 4b (design v3.2 §4, §8): storage.keep_db is an admission of the managed sync pass, bound to the bytes it froze.
 *
 * Probes (pr4-design v3.2 §12): 26, a dirty or two-sided page with a concept skip and a conflict receipt gets no DB-wins
 * write; 27, an edit or a revision change at the freeze seam fails closed (and after it: at admission and at publication);
 * 47 (keep_db half), on a durability-off brain the published DB-wins write leaves the disk hashing to its Git effect's
 * `expected_hash`; 51 (keep_db half), `sync.admission` toggled between admission and publication cancels the request with
 * `admission_paused` and writes nothing, and a paused path is admitted again once admission is normal.
 *
 * Runs on PGLite, and on Postgres when DATABASE_URL is set (test/e2e/keep-db-pass-admission-postgres.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import { DRIFT_SKIPS_KEY, liveFileDrift, readDriftSkips, recordDriftSkip } from '../src/core/persistence/drift-conflicts.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { SYNC_ADMISSION_KEY } from '../src/core/persistence/sync-admission.ts';
import { admitKeepDbReconcile, freezeKeepDbReconcile, releaseMatchedDriftSkips, type KeepDbArtifact, type KeepDbFreeze } from '../src/core/repair/keep-db-policy.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const logger = { info() {}, warn() {}, error() {} };
const CONCEPT = 'concepts/alpha-example';
const PERSON = 'people/alice-example';
const FILE_LINE = 'A line added in the file only.';
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=keepdb-test', '-c', 'user.email=keepdb-test@example.com', ...args], { cwd: root });

for (const backend of testBackends()) describe(`#6712 PR 4b keep_db pass admission (${backend})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-keepdb-db-'));

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    if (backend === 'pglite') {
      const pglite = new PGLiteEngine();
      await pglite.connect({ database_path: dataDir }); await pglite.initSchema(); engine = pglite;
    } else {
      const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
      engine = pg.engine; closePostgres = pg.close;
    }
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    if (closePostgres) await closePostgres(); else await engine.disconnect();
    resetGateway(); rmSync(dataDir, { recursive: true, force: true });
  });

  /**
   * A source with `keep_db: concepts/`, a concept and a person page written through, then both files edited in the
   * file only and committed: each page drifts on a clean committed file, with a drift conflict receipt.
   */
  async function fixture(run: (input: { root: string; sourceId: string; ctx: OperationContext; revisions: string[] }) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-keepdb-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    git(root, 'init', '-q');
    const sourceId = `kd-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  keep_db:\n    - concepts/\n');
        const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
        const revisions: string[] = [];
        for (const body of ['First stored body.', 'Stored body.']) {
          await put(ctx, CONCEPT, `---\ntype: concept\ntitle: alpha\n---\n${body}\n`, revisions.at(-1));
          revisions.push((await engine.readPageSnapshot(CONCEPT, { sourceId }))!.revision);
        }
        await put(ctx, PERSON, '---\ntype: person\ntitle: Alice Example\n---\nOriginal sentence.\n');
        for (const slug of [CONCEPT, PERSON]) append(root, slug, FILE_LINE);
        git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'file-only edits');
        for (const slug of [CONCEPT, PERSON]) await refusedWrite(ctx, slug);
        expect((await liveFileDrift(engine, sourceId, CONCEPT)).still_present).toBe(true);
        await run({ root, sourceId, ctx, revisions });
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.unsetConfig(DRIFT_SKIPS_KEY);
      await engine.unsetConfig(SYNC_ADMISSION_KEY);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const put = (ctx: OperationContext, slug: string, content: string, expected_revision?: string) =>
    submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID(), ...(expected_revision ? { expected_revision } : {}) } });
  const append = (root: string, slug: string, line: string) => {
    const file = join(root, `${slug}.md`);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n${line}\n`);
  };
  const refusedWrite = async (ctx: OperationContext, slug: string) => {
    const expected_revision = (await engine.readPageSnapshot(slug, { sourceId: ctx.sourceId! }))!.revision;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: '---\ntype: note\ntitle: Refused\n---\nRefused.\n', expected_revision, request_id: randomUUID() } })
      .then(() => { throw new Error(`write to ${slug} committed`); }, (error: { code?: string }) => expect(error.code).toBe('source_changed'));
  };
  /** What the pass freezes for `slug` at HEAD (committed mode, `Dp = clean`, classified `keep_db`), with `overrides`. */
  const frozen = async (root: string, sourceId: string, slug: string, overrides: Partial<KeepDbFreeze> = {}): Promise<KeepDbFreeze> => {
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    return { sourceId, slug, pageId: snapshot.page.id, revision: snapshot.revision, path: `${slug}.md`,
      frozenBytes: execFileSync('git', ['show', `HEAD:${slug}.md`], { cwd: root }), classified: { cls: 'keep_db' }, mode: 'committed', dirty: 'clean', ...overrides };
  };
  const artifactOf = async (input: KeepDbFreeze): Promise<KeepDbArtifact> => {
    const result = await freezeKeepDbReconcile(engine, input);
    if (!('artifact' in result)) throw new Error(`freeze refused ${result.refused}`);
    return result.artifact;
  };
  const noFence = async () => {};
  const admitted = async (artifact: KeepDbArtifact, passId = randomUUID()): Promise<{ request: WriteRequest; replayed: boolean }> => {
    const result = await admitKeepDbReconcile(engine, artifact, { passId, remote: false, inTx: noFence });
    if (!('request' in result)) throw new Error(`admission refused ${result.refused}`);
    return result;
  };
  const settle = (row: WriteRequest) => waitForWrite(engine, row, { engine: engine.kind } as never, 30_000);
  const reconciles = async (sourceId: string) => engine.executeRaw<{ request_id: string; state: string; error_code: string | null }>(
    "SELECT request_id, state, error_code FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='canonical_reconcile' ORDER BY sequence", [sourceId]);

  test('probe 26: a dirty or two-sided page with a concept skip and a conflict receipt gets no DB-wins write', () => fixture(async ({ root, sourceId }) => {
    const live = await liveFileDrift(engine, sourceId, CONCEPT);
    await recordDriftSkip(engine, sourceId, CONCEPT, { file_hash: live.file_hash ?? null, db_revision: live.db_revision ?? null });
    const committed = await frozen(root, sourceId, CONCEPT);
    append(root, CONCEPT, 'A second line, not committed.');
    const dirtyFile = readFileSync(join(root, `${CONCEPT}.md`), 'utf8');
    expect(await freezeKeepDbReconcile(engine, { ...committed, dirty: 'modified' })).toEqual({ refused: 'not_committed_clean' });
    expect(await freezeKeepDbReconcile(engine, { ...committed, dirty: 'staged' })).toEqual({ refused: 'not_committed_clean' });
    expect(await freezeKeepDbReconcile(engine, { ...committed, mode: 'working' })).toEqual({ refused: 'not_committed_clean' });
    expect(await freezeKeepDbReconcile(engine, committed)).toEqual({ refused: 'bytes_changed' });
    expect(await freezeKeepDbReconcile(engine, { ...committed, classified: { cls: 'drift' } })).toEqual({ refused: 'not_keep_db' });
    expect(await freezeKeepDbReconcile(engine, { ...committed, classified: { cls: 'db_ahead', sub: 'unproven' } })).toEqual({ refused: 'not_keep_db' });
    expect(await freezeKeepDbReconcile(engine, { ...committed, classified: { cls: 'db_ahead', sub: 'db_only' } })).toEqual({ refused: 'not_keep_db' });
    expect(await freezeKeepDbReconcile(engine, await frozen(root, sourceId, PERSON))).toEqual({ refused: 'outside_keep_db' });
    expect(await reconciles(sourceId)).toEqual([]);
    expect(readFileSync(join(root, `${CONCEPT}.md`), 'utf8')).toBe(dirtyFile);
    expect(Object.keys(await readDriftSkips(engine))).toContain(`${sourceId}:${CONCEPT}`);
  }), 240_000);

  test('probe 27: an edit or a revision change at the freeze seam fails closed, and so do edits after it', () => fixture(async ({ root, sourceId, revisions }) => {
    const file = join(root, `${CONCEPT}.md`);
    const head = readFileSync(file, 'utf8');
    const seen = await frozen(root, sourceId, CONCEPT);
    expect(await freezeKeepDbReconcile(engine, { ...seen, revision: revisions[0]! })).toEqual({ refused: 'revision_changed' });
    writeFileSync(file, `${head}\nAn edit at the freeze seam.\n`);
    expect(await freezeKeepDbReconcile(engine, seen)).toEqual({ refused: 'bytes_changed' });
    writeFileSync(file, head);

    const beforeAdmission = await artifactOf(seen);
    expect(beforeAdmission.preview.preconditions.raw_file_hash).toBe(sha256(seen.frozenBytes));
    expect(beforeAdmission.preview.preconditions.revision).toBe(seen.revision);
    writeFileSync(file, `${head}\nAn edit before admission.\n`);
    expect(await admitKeepDbReconcile(engine, beforeAdmission, { passId: randomUUID(), remote: false, inTx: noFence })).toEqual({ refused: 'source_changed' });
    expect(await reconciles(sourceId)).toEqual([]);
    writeFileSync(file, head);

    await disposePersistenceConsumer(engine);
    const { request } = await admitted(await artifactOf(seen));
    const edited = `${head}\nAn edit before publication.\n`;
    writeFileSync(file, edited);
    const done = await settle(request);
    expect(done.state).not.toBe('committed');
    expect(readFileSync(file, 'utf8')).toBe(edited);
    expect((await engine.readPageSnapshot(CONCEPT, { sourceId }))!.revision).toBe(seen.revision);
  }), 240_000);

  test('probe 47 (keep_db half): on a durability-off brain the published DB-wins write leaves the disk hashing to the effect expected_hash', () => fixture(async ({ root, sourceId }) => {
    await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='disabled'");
    const { request } = await admitted(await artifactOf(await frozen(root, sourceId, CONCEPT)));
    expect(request.intent).toMatchObject({ kind: 'canonical_reconcile', keepDb: { passId: expect.any(String) } });
    expect((await settle(request)).state).toBe('committed');
    const [effect] = await engine.executeRaw<{ expected_hash: string | null }>(
      "SELECT data->>'expected_hash' AS expected_hash FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [request.id]);
    const disk = readFileSync(join(root, `${CONCEPT}.md`));
    expect(effect?.expected_hash).toBe(sha256(disk));
    expect(disk.toString('utf8')).not.toContain(FILE_LINE);
    expect((await liveFileDrift(engine, sourceId, CONCEPT)).still_present).toBe(false);
  }), 240_000);

  test('probe 51 (keep_db half): sync.admission toggled between admission and publication cancels the request admission_paused and writes nothing', () => fixture(async ({ root, sourceId }) => {
    const file = join(root, `${CONCEPT}.md`);
    const head = readFileSync(file, 'utf8');
    const seen = await frozen(root, sourceId, CONCEPT);
    for (const value of ['imports_only', 'classify_only', 'not-a-mode']) {
      await engine.setConfig(SYNC_ADMISSION_KEY, value);
      let fenced = 0;
      expect(await admitKeepDbReconcile(engine, await artifactOf(seen), { passId: randomUUID(), remote: false, inTx: async () => { fenced++; } }))
        .toEqual({ refused: 'admission_paused' });
      expect(fenced).toBe(0);
    }
    expect(await reconciles(sourceId)).toEqual([]);

    await engine.setConfig(SYNC_ADMISSION_KEY, 'normal');
    await disposePersistenceConsumer(engine);
    const first = await admitted(await artifactOf(seen));
    expect(first.replayed).toBe(false);
    await engine.setConfig(SYNC_ADMISSION_KEY, 'imports_only');
    const cancelled = await settle(first.request);
    expect({ state: cancelled.state, error_code: cancelled.error_code }).toEqual({ state: 'cancelled', error_code: 'admission_paused' });
    expect(readFileSync(file, 'utf8')).toBe(head);
    expect((await engine.readPageSnapshot(CONCEPT, { sourceId }))!.revision).toBe(seen.revision);

    await engine.setConfig(SYNC_ADMISSION_KEY, 'normal');
    const again = await admitted(await artifactOf(seen));
    expect(again.replayed).toBe(false);
    expect(again.request.request_id).not.toBe(first.request.request_id);
    expect((await settle(again.request)).state).toBe('committed');
    expect(readFileSync(file, 'utf8')).not.toContain(FILE_LINE);
    expect((await reconciles(sourceId)).map(row => row.state)).toEqual(['cancelled', 'committed']);
  }), 240_000);

  test('the admission fence: what inTx throws rolls the admission back and is rethrown as is; remote callers never admit', () => fixture(async ({ root, sourceId }) => {
    const artifact = await artifactOf(await frozen(root, sourceId, CONCEPT));
    const lost = new Error('the drain lease is no longer held by this pass');
    expect(await admitKeepDbReconcile(engine, artifact, { passId: randomUUID(), remote: false, inTx: async () => { throw lost; } }).catch(error => error)).toBe(lost);
    expect(await reconciles(sourceId)).toEqual([]);
    const remote = await admitKeepDbReconcile(engine, artifact, { passId: randomUUID(), remote: true, inTx: noFence }).catch(error => error);
    expect(remote).toMatchObject({ code: 'permission_denied', reason: 'trusted_cli_required' });
    expect(await reconciles(sourceId)).toEqual([]);
    const { request } = await admitted(artifact);
    expect((await settle(request)).state).toBe('committed');
    const replay = await admitted(artifact);
    expect(replay).toMatchObject({ replayed: true, request: { request_id: request.request_id } });
    expect((await reconciles(sourceId)).length).toBe(1);
  }), 240_000);

  test('a page the pass classifies matched releases its concept drift skip; other skips stay', () => fixture(async ({ root, sourceId }) => {
    const live = await liveFileDrift(engine, sourceId, CONCEPT);
    await recordDriftSkip(engine, sourceId, CONCEPT, { file_hash: live.file_hash ?? null, db_revision: live.db_revision ?? null });
    await recordDriftSkip(engine, sourceId, PERSON, { file_hash: null, db_revision: null });
    expect(await releaseMatchedDriftSkips(engine, sourceId, [CONCEPT, CONCEPT, 'concepts/beta-example'])).toBe(1);
    expect(Object.keys(await readDriftSkips(engine))).toEqual([`${sourceId}:${PERSON}`]);
  }), 240_000);
});
