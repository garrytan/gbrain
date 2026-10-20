/**
 * #6712 PR 4b (design v3.2 §4): the persistence consumer no longer runs a storage.keep_db worker. A resident owner
 * (serve) idling over a source whose gbrain.yml declares keep_db prefixes, with a drifted page under them that has a
 * drift conflict receipt and a concept drift skip (the worker's two nominations), admits no reconcile: keep_db writes
 * are admitted only by the managed sync pass (repair/keep-db-policy.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { DRIFT_SKIPS_KEY, liveFileDrift, recordDriftSkip } from '../src/core/persistence/drift-conflicts.ts';
import { setClaimOwnerForTest } from '../src/core/persistence/claim-phase.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

const logger = { info() {}, warn() {}, error() {} };
const SLUG = 'concepts/alpha-example';

describe('#6712 PR 4b: no keep_db worker in the consumer', () => {
  let engine: PGLiteEngine;
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-keepdb-consumer-'));
  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
    engine = new PGLiteEngine(); await engine.connect({ database_path: join(dir, 'db') }); await engine.initSchema();
  }, 120_000);
  afterAll(async () => {
    setClaimOwnerForTest(undefined);
    await disposePersistenceConsumer(engine);
    await engine.disconnect(); resetGateway(); rmSync(dir, { recursive: true, force: true });
  });

  test('a resident serve consumer idling over a nominated keep_db drift admits no reconcile', () => withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
    const root = join(dir, 'brain'); mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    const sourceId = `kc-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await engine.setConfig('sync.write_through', 'true');
    await claimWorktree(engine, sourceId, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  keep_db:\n    - concepts/\n');
    const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, content: '---\ntype: concept\ntitle: alpha\n---\nStored.\n', request_id: randomUUID() } });
    const file = join(root, `${SLUG}.md`);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nA line added in the file only.\n`);
    const expected_revision = (await engine.readPageSnapshot(SLUG, { sourceId }))!.revision;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: SLUG, content: '---\ntype: concept\ntitle: Refused\n---\nRefused.\n', expected_revision, request_id: randomUUID() } })
      .then(() => { throw new Error('write committed'); }, (error: { code?: string }) => expect(error.code).toBe('source_changed'));
    const live = await liveFileDrift(engine, sourceId, SLUG);
    expect(live.still_present).toBe(true);
    await recordDriftSkip(engine, sourceId, SLUG, { file_hash: live.file_hash ?? null, db_revision: live.db_revision ?? null });
    await disposePersistenceConsumer(engine);

    setClaimOwnerForTest({ kind: 'serve', pid: process.pid, version: 'test', nonce: randomUUID() });
    startPersistenceConsumer(engine, { engine: engine.kind } as never).wake(true);
    const reconciles = async () => Number((await engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='canonical_reconcile'", [sourceId]))[0]!.n);
    for (let waited = 0; waited < 8_000 && await reconciles() === 0; waited += 250) await new Promise(resolve => setTimeout(resolve, 250));
    expect(await reconciles()).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('A line added in the file only.');
    setClaimOwnerForTest(undefined);
    await disposePersistenceConsumer(engine);
    await engine.unsetConfig(DRIFT_SKIPS_KEY);
  }), 120_000);
});
