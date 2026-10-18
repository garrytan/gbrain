/**
 * #6429: a caller write that ended `conflict` with `source_changed` because
 * the page's file and database differed is a `gbrain repair failed-writes`
 * candidate. On the reported brain the
 * v0.13.1 grandfather stamped `validate: false` into the database only, so
 * every `remember` on those pages bounced and the fact was lost; once the
 * drift check carries the stamp (page-prepare.ts), the replay commits.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { lostCallerWritesCheck } from '../src/commands/doctor/checks/persistence-requests.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-replay-6429-db-'));
const logger = { info() {}, warn() {}, error() {} };
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

test('a remember refused as file/database drift is listed and replayed by repair failed-writes', async () => {
  for (const engine of engines) await conflictCase(engine);
}, 240_000);

test('a caller retry that commits clears the original and its refused replay attempt from the lost count', async () => {
  for (const engine of engines) await retryCase(engine);
}, 240_000);

async function retryCase(engine: BrainEngine): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-replay-6429r-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  const sourceId = `r6429-${randomUUID().slice(0, 8)}`;
  const slug = 'people/dana-example';
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: '---\ntitle: Dana Example\ntype: person\n---\nDana.', request_id: randomUUID() } });
      const file = join(root, 'people', 'dana-example.md');
      const published = readFileSync(file, 'utf8');
      appendFileSync(file, '\nEdited in the file only.\n');
      const params = { fact: 'Dana Example runs marathons', entity: slug, provenance: 'test', visibility: 'world' };
      await submitRememberMutation(ctx, { ...params, request_id: randomUUID() }).catch(() => undefined);
      const scope = await resolveRepairScope(engine, sourceId);
      const preview = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
      // The replay attempt is refused too: two conflict rows (the original and its attempt, which carries a different digest).
      await (await repairRunner(engine, { apply: true, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId, expect: preview.apply_command.split('--expect ')[1] });
      const [conflicts] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND operation='remember' AND state='conflict'`, [sourceId]);
      expect(conflicts.n).toBe(2);
      expect((await lostCallerWritesCheck(engine, [sourceId])).details).toMatchObject({ count: 1 });

      // The file is reconciled and the caller sends the same remember again (same intent, new request id): it commits.
      writeFileSync(file, published);
      await submitRememberMutation(ctx, { ...params, request_id: randomUUID() });
      expect((await lostCallerWritesCheck(engine, [sourceId])).status).toBe('ok');
      const again = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
      expect(again.affected).toBe(0);
      expect(again.residuals).toEqual({ already_written: 1 });
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(dir, { recursive: true, force: true });
  }
}

async function conflictCase(engine: BrainEngine): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-replay-6429-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  const sourceId = `c6429-${randomUUID().slice(0, 8)}`;
  const slug = 'companies/acme-example';
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: '---\ntitle: Acme Example\ntype: company\n---\nAcme.', request_id: randomUUID() } });
      const file = join(root, 'companies', 'acme-example.md');
      expect(existsSync(file)).toBe(true);
      const published = readFileSync(file, 'utf8');
      // The file drifts from the database (a hand edit), so the remember is refused source_changed and ends in conflict.
      appendFileSync(file, '\nEdited in the file only.\n');
      await submitRememberMutation(ctx, { fact: 'Acme Example moved to Austin', entity: slug, provenance: 'test', visibility: 'world', request_id: randomUUID() }).catch(() => undefined);
      const [receipt] = await engine.executeRaw<{ state: string; error_code: string }>(
        `SELECT state, error_code FROM persistence_requests WHERE source_id=$1 AND operation='remember'`, [sourceId]);
      expect(receipt).toMatchObject({ state: 'conflict', error_code: 'source_changed' });

      // Doctor names the loss and the replay's preview; before this check only a query on persistence_requests showed it.
      const lost = await lostCallerWritesCheck(engine, [sourceId]);
      expect(lost.status).toBe('warn');
      expect(lost.message).toContain(`1 caller write(s) never landed (1 remember; 1 refused source_changed`);
      expect(lost.message).not.toContain('compacted');
      expect(lost.message).toContain(`gbrain repair failed-writes --source ${sourceId}`);
      expect(lost.details).toMatchObject({ count: 1, repair: 'failed-writes', writes: [{ source_id: sourceId, operation: 'remember', reason: 'source_changed', count: 1 }], compacted_unreplayable: 0 });

      const scope = await resolveRepairScope(engine, sourceId);
      const preview = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
      expect((preview.listing ?? []).map(entry => entry.class)).toEqual(['replay']);
      expect(preview.listing?.[0]?.item).toContain(`${slug} remember (conflict `);

      // Replaying while the file still differs refuses the same way and is classified, not retried blindly (W4.11).
      const stillDrifted = await (await repairRunner(engine, { apply: true, logger })).run('failed-writes', scope,
        { explicit: true, sourceFlag: sourceId, expect: preview.apply_command.split('--expect ')[1] });
      expect(stillDrifted.outcomes).toEqual({ file_database_drift: 1 });
      const classified = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
      expect((classified.listing ?? []).map(entry => entry.class)).toEqual(['file_database_drift']);
      // The refused replay attempt is the same write, counted once.
      expect((await lostCallerWritesCheck(engine, [sourceId])).details).toMatchObject({ count: 1 });

      // A reconcile that publishes the file and leaves the page row untouched (file_written, database_changed=false)
      // makes the write a candidate again: the preview probes the file, not only the row's updated_at.
      writeFileSync(file, published);
      const again = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
      expect((again.listing ?? []).map(entry => entry.class)).toEqual(['replay']);
      const applied = await (await repairRunner(engine, { apply: true, logger })).run('failed-writes', scope,
        { explicit: true, sourceFlag: sourceId, expect: again.apply_command.split('--expect ')[1] });
      expect(applied.outcomes).toEqual({ replayed: 1 });
      const [fact] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND fact LIKE 'Acme Example moved to Austin%'`, [sourceId]);
      expect(fact.n).toBe(1);
      expect(readFileSync(file, 'utf8')).toContain('Acme Example moved to Austin');

      const done = await (await repairRunner(engine, { apply: false, logger })).run('failed-writes', scope, { explicit: true, sourceFlag: sourceId });
      expect(done.affected).toBe(0);
      expect(done.residuals).toEqual({ already_written: 1 });
      // The replay committed the same intent, so doctor no longer counts the write as lost.
      expect((await lostCallerWritesCheck(engine, [sourceId])).status).toBe('ok');
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(dir, { recursive: true, force: true });
  }
}
