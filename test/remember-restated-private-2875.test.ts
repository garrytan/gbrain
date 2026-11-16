/**
 * GST-2875: a remote `remember` that restates a confirmed private fact as world is stored private, with a proposal that
 * carries the widening, until the owner accepts it (the rule #9196 / GST-2511 applies to fence rows).
 *
 * 1. Protects: an agent that knows a private claim cannot publish it to every other connected client by remembering it.
 * 2. Fails when: the restated row is stored world, no proposal is filed, a remote recall returns the claim before the
 *    accept, the owner's accept does not make it world, or an ordinary remember (no private copy, a world copy, an
 *    explicit private visibility) changes.
 * 3. Real seams: MCP operation handlers with remote=true and a source-granted token; PGLite (Postgres when DATABASE_URL
 *    is set); managed and unmanaged.
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
import { listTrustProposals, parseTrustProposalRef } from '../src/core/trust/proposals.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const engines: BrainEngine[] = [];
const urls = new Map<BrainEngine, string>();
const home = mkdtempSync(join(tmpdir(), 'gbrain-open-facts-'));
let closePostgres: (() => Promise<void>) | undefined;
const quiet = { info() {}, warn() {}, error() {} };
/** Every fact the fixtures write is older than this instant (--created-before is required). */

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); urls.set(pg.engine, pg.databaseUrl); closePostgres = pg.close;
  }
}), 120_000);
afterAll(async () => {
  resetGateway();
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

interface Brain { engine: BrainEngine; sourceId: string; remote: OperationContext; local: OperationContext }
/** A source on a shared-shaped brain (no owner, no members) with a token granted only that source. */
async function brain(engine: BrainEngine, managed: boolean): Promise<Brain> {
  const sourceId = `open-${randomUUID().slice(0, 8)}`;
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await engine.setConfig('brain.audience', 'shared');
  await registerLocalWriter(engine, 'cli');
  const minted = await mintLegacyToken(engine, { name: `token-${sourceId}`, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
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

async function confirmFact(b: Brain, id: number) {
  await b.engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () => withTrustPromotion(tx, 'user_confirmed', () =>
    tx.executeRaw(`UPDATE facts SET trust_tier='user_confirmed' WHERE id=$1`, [id])), TEST_WRITE_ATTRIBUTION));
}
const owner = { confirmation: { via: 'tty' as const } };
const row = (n: number, claim: string, visibility = 'world') => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', active: true });
const body = (rows: ReturnType<typeof row>[]) => `Profile.\n\n## Facts\n\n${renderFactsTable(rows as never)}`;
const note = (title: string, text: string) => `---\ntype: note\ntitle: ${title}\n---\n${text}\n`;
const rowsOf = (b: Brain, claim: string) => b.engine.executeRaw<{ id: number; visibility: string; trust_tier: string; row_num: number | null; superseded_by: number | null }>(
  'SELECT id::int AS id, visibility, trust_tier, row_num, superseded_by::int AS superseded_by FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL ORDER BY id', [b.sourceId, claim]);
async function seeded(engine: BrainEngine, managed: boolean, slug: string, claim: string, confirm = true) {
  const b = await brain(engine, managed);
  await run(b.local, 'put_page', { slug, content: note(slug, body([row(1, 'Lives in Turin'), row(2, claim, 'private')])) });
  if (confirm) for (const r of await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2', [b.sourceId, slug])) await confirmFact(b, Number(r.id));
  return b;
}
async function remoteSees(b: Brain, slug: string, claim: string) {
  __resetPrivateVisibilityCacheForTests();
  return JSON.stringify(await run(b.remote, 'recall', { entity: slug })).includes(claim);
}

describe('GST-2875: a remote remember restating a confirmed private claim', () => {
  for (const managed of [true, false]) {
    test(`is stored private with a widening proposal, hidden from remote reads, and the owner accept makes it world (${managed ? 'managed' : 'unmanaged'})`, async () => withEnv({ GBRAIN_HOME: home }, async () => {
      for (const engine of engines) {
        const slug = 'people/lia-example', claim = 'Lia Example keeps bees';
        const b = await seeded(engine, managed, slug, claim);
        const [confirmed] = await rowsOf(b, claim);
        const res = await run(b.remote, 'remember', { fact: claim, provenance: 'chat', entity: slug });
        const ref = res.contested?.proposal_ref ?? res.outcome?.contested?.proposal_ref;
        expect(ref).toMatch(/^tp\d+$/);
        const rows = await rowsOf(b, claim);
        expect(rows.filter(r => r.visibility === 'world')).toEqual([]);
        expect(rows.find(r => r.id === confirmed!.id)).toMatchObject({ visibility: 'private', trust_tier: 'user_confirmed' });
        const restated = rows.find(r => r.id !== confirmed!.id)!;
        expect(restated).toMatchObject({ visibility: 'private', trust_tier: 'agent_written' });
        const proposal = (await listTrustProposals(engine, { status: 'pending' })).find(p => p.id === parseTrustProposalRef(ref)!);
        expect(proposal?.before_state.visibility).toEqual({ from: 'private', to: 'world' });
        expect(await remoteSees(b, slug, claim)).toBe(false);
        expect((await decideTrustProposal(engine, parseTrustProposalRef(ref)!, 'accept', owner)).status).toBe('accepted');
        expect((await rowsOf(b, claim)).find(r => r.id === restated.id)).toMatchObject({ visibility: 'world', trust_tier: 'user_confirmed' });
        expect(await remoteSees(b, slug, claim)).toBe(true);
      }
    }), 180_000);
  }

  test('a later page write keeps the held restatement private until the accept', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const slug = 'people/mae-example', claim = 'Mae Example keeps bees';
      const b = await seeded(engine, true, slug, claim);
      await run(b.remote, 'remember', { fact: claim, provenance: 'chat', entity: slug });
      await run(b.remote, 'remember', { fact: 'Mae Example likes tea', provenance: 'chat', entity: slug });
      expect((await rowsOf(b, claim)).map(r => r.visibility)).toEqual(['private', 'private']);
      expect(await remoteSees(b, slug, claim)).toBe(false);
    }
  }), 180_000);

  test('unchanged: no private copy, a world copy already present, or an explicit private remember', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const fresh = await seeded(engine, true, 'people/ned-example', 'Ned Example keeps bees');
      const plain = await run(fresh.remote, 'remember', { fact: 'Ned Example rides a bike', provenance: 'chat', entity: 'people/ned-example' });
      expect(plain.contested).toBeUndefined();
      expect((await rowsOf(fresh, 'Ned Example rides a bike')).map(r => r.visibility)).toEqual(['world']);

      const shared = await brain(engine, true);
      await run(shared.local, 'put_page', { slug: 'people/ola-example', content: note('Ola', body([row(1, 'Ola Example keeps bees')])) });
      for (const r of await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1', [shared.sourceId])) await confirmFact(shared, Number(r.id));
      const again = await run(shared.remote, 'remember', { fact: 'Ola Example keeps bees', provenance: 'chat', entity: 'people/ola-example' });
      expect(again.contested).toBeUndefined();
      expect((await rowsOf(shared, 'Ola Example keeps bees')).map(r => r.visibility).every(v => v === 'world')).toBe(true);

      const kept = await seeded(engine, true, 'people/pia-example', 'Pia Example keeps bees');
      await run(kept.remote, 'remember', { fact: 'Pia Example keeps bees', provenance: 'chat', entity: 'people/pia-example', visibility: 'private' });
      expect((await rowsOf(kept, 'Pia Example keeps bees')).every(r => r.visibility === 'private')).toBe(true);
      expect((await listTrustProposals(engine, { status: 'pending' })).filter(p => (p.before_state as { visibility?: unknown }).visibility && p.source_id === kept.sourceId)).toEqual([]);
    }
  }), 180_000);
});
