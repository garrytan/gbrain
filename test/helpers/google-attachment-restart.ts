import { writeSync } from 'node:fs';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { parseGoogleSourceConfig, runGoogleAttachmentBackfill } from '../../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

const input = JSON.parse(process.env.GBRAIN_TEST_GMAIL_RESTART!);
if (input.database.database_url) assertSafeE2eDatabaseUrl(input.database.database_url);
const engine: BrainEngine = input.database.engine === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
await engine.connect(input.database);
const kill = () => { writeSync(1, `GMAIL_CRASH ${input.crash}\n`); process.kill(process.pid, 'SIGKILL'); };
if (input.crash) {
  const transaction = engine.transaction;
  engine.transaction = async function <T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
    const result = await transaction.call(this, async tx => {
      const executeRaw = tx.executeRaw;
      if (input.crash === 'before_publication') tx.executeRaw = async function (sql, params) {
        if (sql.includes('publication_started=true')) {
          const [row] = await executeRaw.call(tx, 'SELECT intent FROM persistence_requests WHERE id=$1::uuid', [params![0]]);
          if ((row as Partial<WriteRequest>)?.intent?.kind === 'connector_v2_google_receipts') kill();
        }
        return executeRaw.call(tx, sql, params);
      } as BrainEngine['executeRaw'];
      const value = await run(tx);
      const row = value as Partial<WriteRequest> | undefined;
      if (input.crash === 'after_publication' && row?.state === 'committed' && row.intent?.kind === 'connector_v2_google_receipts') kill();
      return value;
    });
    const row = result as Partial<WriteRequest> | undefined;
    if (row?.state === 'committed' && (input.crash === 'after_metadata_commit' && row.intent?.kind === 'connector_v2_google_receipts' ||
      input.crash === 'after_checkpoint_commit' && row.intent?.kind === 'connector_v2_checkpoint' &&
      ((row.intent.checkpointAfter as any)?.[0]?.state?.gmail_attachment_backfill?.afterPageId ?? 0) > 0)) kill();
    return result as T;
  };
}
try {
  const result = await runGoogleAttachmentBackfill(engine, input.sourceId, parseGoogleSourceConfig(input.sourceConfig, input.root), {}, async url => {
    if (url.includes('/profile')) return Response.json({ emailAddress: 'reader@example.com', historyId: '100' });
    if (!url.includes('/threads/thread1?')) throw new Error('Unexpected synthetic metadata endpoint');
    if (input.unavailable) return Response.json({}, { status: 404 });
    return Response.json({ id: 'thread1', messages: [{ id: 'message0000000001', payload: {
      mimeType: 'application/pdf', filename: 'fixture.pdf', partId: '1', body: { attachmentId: 'opaque', size: 17 },
    } }] });
  });
  process.stdout.write(`GMAIL_RESULT ${JSON.stringify(result)}\n`);
} finally {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
}
