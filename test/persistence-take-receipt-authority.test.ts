import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { compactWriteReceipts, getWriteRequest } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const sourceId = 'take-receipt-authority';
const privateHolder = 'people/private-holder-example';
beforeAll(async () => {
  const local = new PGLiteEngine(); await local.connect({}); await local.initSchema(); engines.push(local);
  if (process.env.DATABASE_URL) {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(isolated.engine); closePostgres = isolated.close;
  }
  for (const engine of engines) await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
});

test('holder narrowing hides every affected take receipt and replay after real compaction, while world receipts remain accessible', async () => {
  for (const engine of engines) {
    const token = await mintLegacyToken(engine, { name: 'receipt-test', scopes: ['read', 'write'],
      takesHolders: ['world', privateHolder], sourceGrant: [sourceId] });
    const principal = { kind: 'legacy_token' as const, id: token.id };
    const ctx: OperationContext = { engine, config: { engine: engine.kind, embedding_disabled: true }, remote: true,
      transport: 'http', sourceId, dryRun: false, takesHoldersAllowList: ['world', privateHolder],
      auth: { token: '', clientId: token.id, principal, sourceId, allowedSources: [sourceId], scopes: ['read', 'write'] },
      logger: { info() {}, warn() {}, error() {} } };
    const slug = 'takes/receipt';
    await engine.putPage(slug, { type: 'note', title: 'Take receipt fixture', compiled_truth: 'Stable page' }, { sourceId });
    const calls: Array<{ operation: string; params: Record<string, unknown> }> = [];
    async function submit(operation: string, params: Record<string, unknown>) {
      const call = { operation, params: { request_id: randomUUID(), slug, ...params } }; calls.push(call);
      return submitPageMutation(ctx, call);
    }
    const add = await submit('takes_add', { claim: 'Private holder claim', kind: 'take', holder: privateHolder });
    await submit('takes_update', { row_num: add.row_num, weight: 0.8 });
    const supersede = await submit('takes_supersede', { row_num: add.row_num, claim: 'Updated private holder claim' });
    await submit('takes_resolve', { row_num: supersede.new_row, quality: 'correct', evidence: 'Fixture evidence' });
    const privateCalls = [...calls];
    const world = await submit('takes_add', { claim: 'Public holder claim', kind: 'fact', holder: 'world' });
    for (const call of privateCalls) {
      const row = (await getWriteRequest(engine, principal, String(call.params.request_id)))!;
      expect(row.state).toBe('committed');
      expect(row.authority.takeHoldersUsed).toEqual([privateHolder]);
      const receipt = await operationsByName.get_write_request.handler(ctx, { request_id: row.request_id }) as any;
      expect(receipt.state).toBe('committed');
      expect(JSON.stringify(receipt)).not.toContain('takeHoldersUsed');
    }
    // Retire the projection so real deferred effects complete as superseded;
    // no fabricated completion or direct journal compaction is needed.
    await disposePersistenceConsumer(engine);
    await engine.softDeletePage(slug, { sourceId });
    // Make previously backed-off provider effects due, then run the real worker.
    await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE state='queued'");
    await runPersistenceEffects(engine, ctx.config, { hostId: localHostId(), limit: 16 });
    expect(await compactWriteReceipts(engine, 0)).toBe(5);
    // An older add receipt can prove its holder from the retained outcome even
    // if it predates the private authority field. It must obey narrowing too.
    await engine.executeRaw("UPDATE persistence_requests SET authority=authority-'takeHoldersUsed' WHERE request_id=$1::uuid",
      [privateCalls[0].params.request_id]);
    expect((await operationsByName.get_write_request.handler(ctx, { request_id: privateCalls[0].params.request_id }) as any).state).toBe('committed');
    await engine.executeRaw('UPDATE access_tokens SET permissions=$2::text::jsonb WHERE id=$1::uuid',
      [token.id, JSON.stringify({ source_id: [sourceId], takes_holders: ['world'] })]);
    const narrowed = { ...ctx, takesHoldersAllowList: ['world'] };
    for (const call of privateCalls) {
      const row = (await getWriteRequest(engine, principal, String(call.params.request_id)))!;
      expect(row.compacted).toBe(true); expect(row.intent).toBeNull();
      // Stale in-memory transport grants cannot override current database authority.
      await expect(submitPageMutation(ctx, call)).rejects.toMatchObject({ code: 'permission_denied' });
      for (const helper of ['get_write_request', 'cancel_write_request']) {
        await expect(operationsByName[helper].handler(narrowed, { request_id: call.params.request_id })).rejects.toMatchObject({ code: 'not_found' });
      }
    }
    const listing = await operationsByName.list_write_requests.handler(narrowed, {}) as any;
    expect(listing.requests.map((row: any) => row.request_id)).toEqual([world.request_id]);
    expect(JSON.stringify(listing)).not.toContain(privateHolder);
    const worldReplay = await submitPageMutation(narrowed, calls.at(-1)!);
    expect(worldReplay.request_id).toBe(world.request_id);
    expect(worldReplay.revision).toBe(world.revision);
  }
}, 120_000);
