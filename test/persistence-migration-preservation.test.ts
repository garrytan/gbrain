import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { copyPageToTarget, runMigrateEngine } from '../src/commands/migrate-engine.ts';
import { assertLegacyEngineMigration } from '../src/core/persistence/maintenance.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  const source = new PGLiteEngine();
  await source.connect({}); await source.initSchema(); engines.push(source);
  if (process.env.DATABASE_URL) {
    const fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(fixture.engine); closePostgres = fixture.close;
  } else {
    const target = new PGLiteEngine();
    await target.connect({}); await target.initSchema(); engines.push(target);
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
}, 60_000);

test('legacy migration preserves unverified vectors and rebuilds before retrieval in both directions', async () => {
  for (const [source, target] of [[engines[0], engines[1]], [engines[1], engines[0]]]) {
    const slug = `migration-${randomUUID()}`;
    await source.putPage(slug, { type: 'note', title: 'Migrated example', compiled_truth: 'canonical migration sentinel' });
    const vector = new Float32Array(1536); vector[0] = 1;
    await source.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth',
      chunk_text: 'stale migration text', embedding: vector }]);
    expect(await source.getChunksWithEmbeddings(slug)).toEqual([]);
    const copied = await copyPageToTarget(source, target, (await source.getPage(slug))!);
    expect(copied.chunks).toBe(1);
    const raw = await target.getChunksWithEmbeddings(slug, { includeUnsealed: true });
    expect(raw).toHaveLength(1);
    expect(raw[0].chunk_text).toBe('stale migration text');
    expect(raw[0].embedding?.[0]).toBe(1);
    expect(await target.getChunksWithEmbeddings(slug)).toEqual([]);
    expect(await target.searchKeyword('stale migration')).toEqual([]);
    expect((await rebuildPendingPageProjections(target)).rebuilt).toBeGreaterThanOrEqual(1);
    const snapshot = (await target.readPageSnapshot(slug))!;
    expect(snapshot.page.text_projection_revision).toBe(snapshot.revision);
    expect((await target.getChunks(slug)).map(chunk => chunk.chunk_text).join('\n')).toBe('canonical migration sentinel');
  }
});

test('withdrawals, ownership and compacted cancelled IDs refuse legacy engine migration', async () => {
  for (const engine of engines) {
    await assertLegacyEngineMigration(engine);
    await engine.executeRaw("INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES('default','world','synthetic')");
    await expect(assertLegacyEngineMigration(engine)).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    await engine.executeRaw("DELETE FROM fact_withdrawals WHERE fact_hash='synthetic'");
    const root = randomUUID();
    await engine.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id) VALUES($1::uuid,$2::uuid)', [root, randomUUID()]);
    await expect(assertLegacyEngineMigration(engine)).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    await engine.executeRaw('DELETE FROM persistence_worktrees WHERE id=$1::uuid', [root]);
    await registerLocalWriter(engine, 'cli');
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
    const authority = await submissionAuthority({ engine, config: { engine: engine.kind }, sourceId: 'default',
      remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } }, 'put_page', 'default', source.incarnation, 'never-published');
    const admitted = await admitWrite(engine, { principal: authority.principal, authority, requestId: randomUUID(),
      operation: 'put_page', sourceId: 'default', sourceIncarnation: source.incarnation, slug: 'never-published',
      pageId: null, callerIntent: { content: 'original' }, intent: { content: 'original' } });
    await cancelWriteRequest(engine, authority.principal, admitted.request_id);
    await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '31 days' WHERE request_id=$1::uuid", [admitted.request_id]);
    expect(await compactWriteReceipts(engine)).toBe(1);
    await expect(assertLegacyEngineMigration(engine)).rejects.toMatchObject({ code: 'writer_coordinator_required' });
    // Must reject before parsing the target or touching its datastore/config.
    await expect(runMigrateEngine(engine, [])).rejects.toMatchObject({ code: 'writer_coordinator_required' });
  }
});
