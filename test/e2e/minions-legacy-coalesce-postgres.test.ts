/**
 * #5157 / #5114 on real Postgres: the same coalesce matrix the PGLite unit
 * test runs (`test/minions-legacy-coalesce.test.ts`), plus a real concurrent
 * insert race over a released legacy key.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { runMigrations } from '../../src/core/migrate.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { prepareRemoteJob } from '../../src/core/minions/submission-authority.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { PATHS, runCoalesceMatrix } from '../helpers/legacy-coalesce-matrix.ts';
import { withEnv } from '../helpers/with-env.ts';

const suite = hasDatabase() ? describe : describe.skip;
suite('Postgres legacy coalesce rule (#5157)', () => {
  let sandbox: string, root: string;
  const ctx = (): OperationContext => ({
    engine: getEngine(), config: {} as OperationContext['config'], remote: true, sourceId: 'default', dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
    auth: { token: 'test-only', clientId: 'coalesce-test-client', principal: { kind: 'oauth_client', id: 'coalesce-test-client' }, scopes: ['admin'], sourceId: 'default' },
  });
  beforeAll(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'gbrain-pg-legacy-coalesce-'));
    root = join(sandbox, 'repo'); mkdirSync(root); execFileSync('git', ['init', '-q', root]);
    await withEnv({ GBRAIN_HOME: sandbox }, async () => { await setupDB(); await runMigrations(getEngine()); });
  }, 120_000);
  afterAll(async () => { await teardownDB(); if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });
  beforeEach(async () => {
    await getEngine().executeRaw('DELETE FROM minion_jobs');
    await getEngine().executeRaw("DELETE FROM oauth_clients WHERE client_id = 'coalesce-test-client'");
    await getEngine().executeRaw("UPDATE sources SET local_path = $1, config = '{}'::jsonb, archived = false WHERE id = 'default'", [root]);
    await getEngine().executeRaw("INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, scope, source_id) VALUES ('coalesce-test-client', 'fixture-hash', 'example-client', 'admin', 'default')");
  });

  test('variant x path x status x caller matches PGLite', async () => {
    const cells = await runCoalesceMatrix(getEngine(), () => prepareRemoteJob(ctx(), 'lint', {}));
    expect(cells).toBe(4 * Object.values(PATHS).reduce((n, p) => n + p.statuses.length * p.callers.length, 0));
  }, 300_000);

  test('concurrent resubmissions over one dead legacy key insert exactly one fresh job', async () => {
    const queue = new MinionQueue(getEngine());
    const old = await queue.add('legacy-fixture', { n: 1 }, { idempotency_key: 'dream:synth-v2:race' });
    await getEngine().executeRaw("UPDATE minion_jobs SET status = 'dead', submission_authority = NULL WHERE id = $1", [old.id]);
    const results = await Promise.all(Array.from({ length: 6 }, () => queue.add('legacy-fixture', { n: 1 }, { idempotency_key: 'dream:synth-v2:race' })));
    const ids = new Set(results.map(job => job.id));
    expect(ids.size).toBe(1);
    expect(ids.has(old.id)).toBe(false);
    const rows = await getEngine().executeRaw<{ id: number }>("SELECT id FROM minion_jobs WHERE idempotency_key = 'dream:synth-v2:race'");
    expect(rows.map(r => r.id)).toEqual([...ids]);
  }, 60_000);
});
