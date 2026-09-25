import { writeFileSync } from 'node:fs';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';

const marker = process.env.GBRAIN_TEST_SYNC_CLAIM_BARRIER;
if (!marker) throw new Error('The sync claim barrier requires an isolated marker path.');
const transaction = PGLiteEngine.prototype.transactionDirect;
let stopped = false;
PGLiteEngine.prototype.transactionDirect = async function<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const result = await transaction.call(this, fn) as T;
  const row = result as WriteRequest | null;
  if (!stopped && row?.state === 'running' && row.source_id === 'workspace' && row.slug === 'topics/note-0003'
    && row.intent?.kind === 'managed_sync_import' && typeof row.intent.runId === 'string') {
    stopped = true;
    writeFileSync(marker, JSON.stringify({ requestId: row.request_id, runId: row.intent.runId }), { flag: 'wx', mode: 0o600 });
    await new Promise<never>((_, reject) => setTimeout(() => reject(new Error('The sync claim barrier was not interrupted.')), 120_000));
  }
  return result;
};
