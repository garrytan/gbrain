import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { writerDiagnostics } from '../src/core/persistence/control.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const local = new PGLiteEngine(); await local.connect({}); await local.initSchema(); engines.push(local);
  if (process.env.DATABASE_URL) {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(isolated.engine); closePostgres = isolated.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
});

test('admin diagnostics account for queued work and configured limits without exposing intent', async () => {
  for (const engine of engines) {
    const ctx: OperationContext = { engine, config: { engine: engine.kind }, sourceId: 'default',
      remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'inbox/committed', content: 'Visible example', request_id: randomUUID() } });
    await disposePersistenceConsumer(engine);
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
    const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, 'inbox/queued');
    const row = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: source.incarnation, slug: 'inbox/queued', requestId: randomUUID(),
      callerIntent: {}, intent: { content: 'PRIVATE_DIAGNOSTIC_INTENT_CANARY' } });
    await engine.executeRaw("UPDATE persistence_requests SET blocked_reason='owner_unavailable' WHERE id=$1::uuid", [row.id]);
    await engine.setConfig('persistence.limits.brain_outstanding', '1');
    const status = await writerDiagnostics(engine);
    expect(status.queue).toMatchObject([{ state: 'queued', count: 1 }]);
    const capacity = status.capacity.find(c => c.scope === 'brain' && c.resource === 'outstanding_count')!;
    expect(capacity).toMatchObject({ used: 1, limit: 1, remaining: 0, approaching_capacity: true });
    expect(capacity.next_action).toContain('persistence.limits.brain_outstanding');
    expect(status.blockers[0]).toMatchObject({ request_id: row.request_id });
    expect(status.blockers[0].next_action).toContain('designated owner');
    expect(JSON.stringify(status)).not.toContain('PRIVATE_DIAGNOSTIC_INTENT_CANARY');
    expect(JSON.stringify(status)).not.toContain('execution_token');
  }
});
