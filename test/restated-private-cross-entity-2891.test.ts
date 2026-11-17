/**
 * GST-2891: the GST-2875 hold checks that no world copy of the claim exists before it holds a restatement. That check
 * must be on the same entity: a world copy the writer saved about another entity first must not let it restate a
 * confirmed private fact as world on this one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite, withTrustPromotion } from '../src/core/persistence/context.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { decideTrustProposal } from '../src/core/trust/decide.ts';
import { parseTrustProposalRef } from '../src/core/trust/proposals.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { heldProposalRef } from './helpers/held-proposal.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const home = mkdtempSync(join(tmpdir(), 'gst2891x-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const quiet = { info() {}, warn() {}, error() {} };

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}), 120_000);
afterAll(async () => {
  resetGateway();
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

interface Brain { engine: BrainEngine; sourceId: string; remote: OperationContext; local: OperationContext }
async function brain(engine: BrainEngine, managed: boolean): Promise<Brain> {
  const sourceId = 'open-' + randomUUID().slice(0, 8);
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await engine.setConfig('brain.audience', 'shared');
  await registerLocalWriter(engine, 'cli');
  const minted = await mintLegacyToken(engine, { name: 'token-' + sourceId, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
  await readsUnscopedOnPurpose(engine, minted.id);
  if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const base = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, dryRun: false, logger: quiet };
  await readLocalWriter(engine, 'cli');
  return {
    engine, sourceId,
    remote: { ...base, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
      auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id } as Principal, sourceId, allowedSources: [sourceId], scopes: ['read', 'write'] } },
    local: { ...base, remote: false },
  } as Brain;
}
const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) =>
  operationsByName[op].handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const row = (n: number, claim: string, visibility = 'world') => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', active: true });
const note = (title: string, rows: ReturnType<typeof row>[]) => '---\ntype: note\ntitle: ' + title + '\n---\nProfile.\n\n## Facts\n\n' + renderFactsTable(rows as never) + '\n';
const rowsOf = (b: Brain, claim: string) => b.engine.executeRaw<{ id: number; visibility: string; entity_slug: string | null }>(
  'SELECT id::int AS id, visibility, entity_slug FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL ORDER BY id', [b.sourceId, claim]);
async function remoteSees(b: Brain, slug: string, claim: string) {
  __resetPrivateVisibilityCacheForTests();
  return JSON.stringify(await run(b.remote, 'recall', { entity: slug })).includes(claim);
}

describe('GST-2891: a world copy on another entity does not lift the restatement hold', () => {
  for (const engineIndex of [0, 1]) for (const managed of [true, false]) {
    test('remember on entity A after a world copy on entity B is still held (' + (engineIndex ? 'postgres' : 'pglite') + ', ' + (managed ? 'managed' : 'unmanaged') + ')', async () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines.slice(engineIndex, engineIndex + 1)) {
        const b = await brain(engine, managed);
        const claim = 'Keeps bees on the roof walrusheld';
        await run(b.local, 'put_page', { slug: 'people/lia-example', content: note('Lia Example', [row(1, 'Lives in Turin'), row(2, claim, 'private')]) });
        for (const r of await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [b.sourceId, 'people/lia-example']))
          await engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw("UPDATE facts SET trust_tier='user_confirmed' WHERE id=$1", [r.id])), TEST_WRITE_ATTRIBUTION));
        expect(await remoteSees(b, 'people/lia-example', claim)).toBe(false);
        const decoy = await run(b.remote, 'remember', { fact: claim, provenance: 'chat', entity: 'people/ben-example' });
        expect(decoy.contested ?? decoy.outcome?.contested).toBeUndefined();
        const res = await run(b.remote, 'remember', { fact: claim, provenance: 'chat', entity: 'people/lia-example' });
        const rows = await rowsOf(b, claim);
        const label = engine.kind + (managed ? ' managed' : ' unmanaged');
        const lia = rows.filter(r => r.entity_slug === 'people/lia-example').map(r => r.visibility);
        expect({ label, lia, remoteSees: await remoteSees(b, 'people/lia-example', claim) }).toEqual({ label, lia: ['private', 'private'], remoteSees: false });
        expect(JSON.stringify(res)).not.toContain('proposal_ref');
        const ref = await heldProposalRef(engine, b.sourceId, claim);
        expect(ref).toMatch(/^tp\d+$/);
        expect((await decideTrustProposal(engine, parseTrustProposalRef(ref)!, 'accept', { confirmation: { via: 'tty' as const } })).status).toBe('accepted');
        expect(await remoteSees(b, 'people/lia-example', claim)).toBe(true);
      }
    }), 180_000);
  }
});
