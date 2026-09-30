import { writeSync } from 'node:fs';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { parseGoogleSourceConfig, runGoogleAttachmentBackfill } from '../../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

const input = JSON.parse(process.env.GBRAIN_TEST_MEMORY_WAVE_REPAIR!);
if (input.database.database_url) assertSafeE2eDatabaseUrl(input.database.database_url);
let outboundCalls = 0;
globalThis.fetch = Object.assign(async () => {
  outboundCalls++;
  throw new Error('Historical lifecycle repair must not make outbound requests');
}, { preconnect() {
  outboundCalls++;
  throw new Error('Historical lifecycle repair must not preconnect outbound requests');
} });
const engine: BrainEngine = input.database.engine === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
await engine.connect(input.database);
if (input.crash) {
  const transaction = engine.transaction;
  engine.transaction = async function <T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
    const result = await transaction.call(this, run);
    const row = result as Partial<WriteRequest> | undefined;
    if (row?.state === 'committed' && row.intent?.kind === 'connector_v2_google_receipts') {
      if (outboundCalls) throw new Error('Historical lifecycle repair attempted outbound requests');
      writeSync(1, 'MEMORY_WAVE_CRASH after_metadata_commit\n');
      process.kill(process.pid, 'SIGKILL');
    }
    return result as T;
  };
}
try {
  const result = await runGoogleAttachmentBackfill(engine, input.sourceId, parseGoogleSourceConfig(input.sourceConfig, input.root), {}, async url => {
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') {
      return Response.json({ emailAddress: input.sourceConfig.g_account, historyId: '100' });
    }
    const request = new URL(url);
    const fields = request.searchParams.get('fields');
    if (`${request.origin}${request.pathname}` !== `https://gmail.googleapis.com/gmail/v1/users/me/threads/${input.thread.id}` ||
      request.searchParams.size !== 2 || request.searchParams.get('format') !== 'full' ||
      !fields?.includes('body(attachmentId,size)') || /\b(data|raw|snippet)\b|\*/.test(fields)) {
      throw new Error('Unexpected synthetic lifecycle Gmail endpoint');
    }
    return Response.json(input.thread);
  });
  if (outboundCalls) throw new Error('Historical lifecycle repair attempted outbound requests');
  process.stdout.write(`MEMORY_WAVE_RESUMED ${JSON.stringify(result)}\n`);
} finally {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
}
