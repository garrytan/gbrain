/**
 * Child process for test/large-pages/segmented-delete-crash.slow.test.ts and segmented-delete-stage-crash.slow.test.ts:
 * one managed source whose page over the single-string ceiling has a canonical file, a soft delete stopped (for
 * SIGKILL) at a publication or before-stage seam, the owner's recovery pass, stopped at a restoration seam or run to
 * the end, and the `gbrain repair stuck-recovery` preview scan. Prints one JSON line per step.
 */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { recoverPublication } from '../../src/core/persistence/coordinator.ts';
import { scanStuckRecoveries } from '../../src/core/persistence/recovery-resolve.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { fileSha, writeCanonicalPage } from '../helpers/large-page-file.ts';

const [mode, configPath, boundary = ''] = process.argv.slice(2);
const config: { engine: 'pglite' | 'postgres'; database_path?: string; database_url?: string; root: string; sourceId: string; slug: string; bytes: number } = JSON.parse(readFileSync(configPath!, 'utf8'));
if (config.engine === 'postgres') assertSafeE2eDatabaseUrl(config.database_url!);
const engine = config.engine === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
await engine.connect(config as never);
const emit = (value: Record<string, unknown>) => writeSync(1, JSON.stringify(value) + '\n');
const hang = (): never => { const wait = new Int32Array(new SharedArrayBuffer(4)); for (;;) Atomics.wait(wait, 0, 0); };
const file = join(config.root, `${config.slug}.md`);
const ctx = { engine, sourceId: config.sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } } as OperationContext;
const stages = () => existsSync(dirname(file)) ? readdirSync(dirname(file)).filter(name => name.includes('.tmp.')).map(name => join(dirname(file), name)) : [];
async function settled<T>(call: () => Promise<T>): Promise<T> {
  for (;;) {
    try { return await call(); }
    catch (error) { if ((error as { code?: string }).code !== 'write_pending') throw error; await Bun.sleep(1000); }
  }
}
async function deleteRequest() {
  const [row] = await engine.executeRaw<{ id: string; state: string; recovery: Record<string, any> | null; recovery_text: string | null; recovery_bytes: string }>(
    `SELECT id, state, recovery, recovery::text AS recovery_text, recovery_bytes::text AS recovery_bytes FROM persistence_requests
      WHERE source_id=$1 AND operation='delete_page' ORDER BY sequence DESC LIMIT 1`, [config.sourceId]);
  return row!;
}

try {
  if (mode === 'initialize') {
    await engine.initSchema();
    await engine.setConfig('pages.segmented_storage', 'on');
    mkdirSync(dirname(file), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: config.root });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [config.sourceId, config.root]);
    await registerLocalWriter(engine, 'cli');
    await claimWorktree(engine, config.sourceId, config.root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const written = writeCanonicalPage(file, config.bytes, 7);
    const imported = await settled(() => importManagedFile(engine, file, `${config.slug}.md`, { sourceId: config.sourceId, noEmbed: true }));
    const [page] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE source_id=$1 AND slug=$2', [config.sourceId, config.slug]);
    emit({ initialized: imported.status, body_storage: page?.body_storage, ...written });
  } else if (mode === 'delete') {
    installFaultHook(async (point, detail) => {
      if (point !== boundary || detail.operation !== 'delete_page') return;
      emit({ boundary: point });
      hang();
    });
    const snapshot = await engine.readPageSnapshot(config.slug, { sourceId: config.sourceId, includeDeleted: true });
    await settled(() => submitPageMutation(ctx, { operation: 'delete_page', params: { slug: config.slug, expected_revision: snapshot!.revision, request_id: randomUUID() } }));
    emit({ error: 'the delete committed without reaching the crash seam' });
  } else if (mode === 'inspect') {
    const row = await deleteRequest();
    const [page] = await engine.executeRaw<{ deleted: boolean }>('SELECT deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND slug=$2', [config.sourceId, config.slug]);
    const counters = await engine.executeRaw<{ bytes: string }>('SELECT recovery_bytes::text AS bytes FROM persistence_counters');
    emit({ state: row.state, recovery_chars: row.recovery_text?.length ?? 0, recovery_bytes: Number(row.recovery_bytes),
      before: row.recovery?.before ?? null, before_hash: row.recovery?.beforeHash ?? null, before_stage: row.recovery?.staging?.before ?? null,
      file_sha: existsSync(file) ? fileSha(file) : null, stages: stages().map(path => ({ path, sha: fileSha(path) })),
      page_deleted: page?.deleted ?? null, counters_zero: counters.every(counter => Number(counter.bytes) === 0) });
  } else if (mode === 'recover') {
    const row = await deleteRequest();
    const recovered = await recoverPublication(engine, row.id, localHostId(), false, undefined, false, {
      fileBoundary: point => { if (point === boundary) { emit({ boundary: point }); hang(); } },
    });
    emit({ recovered: recovered.state, recovery: recovered.recovery === null ? null : 'set', blocked_reason: recovered.blocked_reason ?? null });
  } else if (mode === 'scan') {
    const scan = await scanStuckRecoveries(engine, [config.sourceId]).catch((error: { code?: string }) => ({ error: error.code ?? String(error) }));
    emit('error' in scan ? scan : { items: scan.items.length, refused: scan.refused.map(entry => entry.code), residuals: scan.residuals });
  }
} finally {
  await disposePersistenceConsumer(engine).catch(() => undefined);
  await engine.disconnect();
}
