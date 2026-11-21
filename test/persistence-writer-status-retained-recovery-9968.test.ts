import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { initializeLocalPersistence } from '../src/core/persistence/page-mutations.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readWriterDiagnostics } from '../src/core/persistence/diagnostics.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

test('#9968: writer status lists a retained request whose recovery record is set even in a terminal state', async () => {
  await disposePersistenceConsumer(engine);
  const ctx: OperationContext = { engine, config: { engine: engine.kind }, sourceId: 'default',
    remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  await initializeLocalPersistence(ctx);
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, 'inbox/retained');
  const row = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source.incarnation, slug: 'inbox/retained', requestId: randomUUID(), callerIntent: {}, intent: { content: 'x' } });
  await engine.executeRaw(`UPDATE persistence_requests SET state='cancelled',execution_token=NULL,completed_at=now(),
    recovery='{"version":1}'::jsonb WHERE id=$1::uuid`, [row.id]);
  const diagnostics = await readWriterDiagnostics(engine);
  expect(diagnostics.blockers.map(b => b.request_id)).toContain(row.request_id);
});
