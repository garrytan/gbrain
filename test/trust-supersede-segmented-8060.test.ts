/**
 * #8060: the owner's accept of a supersede_fact trust proposal on an entity page stored in segments.
 *
 * 1. Protects: on a managed brain, a lower-tier remember.replaces of a confirmed fact on a segmented page files a
 *    supersede_fact proposal; the owner's accept (decide_proposal) supersedes the old fact, confirms the new one and
 *    strikes the old row in the page's facts fence, reading the segmented body back whole as every other managed
 *    fence write does; undo restores it.
 * 2. Fails when: the decide_proposal preparer reads the page body as one string (rowToPage.compiled_truth) again:
 *    the accept fails page_body_segmented and the proposal stays pending.
 * 3. Why existing coverage misses it: trust-guarded-supersession.test.ts and conflict-proposals-managed.test.ts
 *    use small inline pages.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { registerLocalWriter, readLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { Principal } from '../src/core/persistence/model.ts';
import { withCoordinatedWrite, withTrustPromotion } from '../src/core/persistence/context.ts';
import { decideTrustProposal } from '../src/core/trust/decide.ts';
import { parseTrustProposalRef } from '../src/core/trust/proposals.ts';
import { materializedPage } from '../src/core/persistence/segmented-apply.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const engines: BrainEngine[] = [];
const home = mkdtempSync(join(tmpdir(), 'gbrain-trust-segmented-'));
let closePostgres: (() => Promise<void>) | undefined;
const quiet = { info() {}, warn() {}, error() {} };
const SLUG = 'people/alice-example';

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}), 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

async function brain(engine: BrainEngine) {
  const sourceId = 'trust-' + randomUUID().slice(0, 8);
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli');
  const minted = await mintLegacyToken(engine, { name: 'token-' + sourceId, scopes: ['read', 'write'], sourceGrant: [sourceId], takesHolders: ['world'] });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const base = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId, dryRun: false, logger: quiet };
  await readLocalWriter(engine, 'cli');
  return {
    engine, sourceId,
    remote: { ...base, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
      auth: { token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id } as Principal, sourceId, allowedSources: [sourceId], scopes: ['read', 'write'] } } as OperationContext,
    local: { ...base, remote: false } as OperationContext,
  };
}
const run = (ctx: OperationContext, op: string, params: Record<string, unknown>) =>
  operationsByName[op].handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const factRow = async (engine: BrainEngine, id: unknown) => (await engine.executeRaw<{ trust_tier: string; expired_at: unknown; superseded_by: number | null }>(
  'SELECT trust_tier, expired_at, superseded_by::int AS superseded_by FROM facts WHERE id=$1', [Number(id)]))[0]!;
const owner = { confirmation: { via: 'tty' as const } };

/** About 1.3 MB of prose: past the 1 MiB promotion bound, so the page is stored in segments. */
const filler = Array.from({ length: 26_000 }, (_, i) => 'Alice Example kept notes on item ' + i + ' of the archive.').join('\n');

describe('#8060 supersede_fact accept on a segmented entity page', () => {
  test('the owner accept supersedes, confirms and strikes the fence row; undo restores', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) {
      const b = await brain(engine);
      await run(b.local, 'put_page', { slug: SLUG, content: '---\ntype: person\ntitle: Alice Example\n---\n# Alice Example\n\n' + filler + '\n' });
      const [stored] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE source_id=$1 AND slug=$2', [b.sourceId, SLUG]);
      expect(stored!.body_storage).toBe('segmented');
      const old = await run(b.local, 'remember', { fact: 'Alice lives in Paris', provenance: 'owner', entity: SLUG });
      await engine.transaction(tx => withCoordinatedWrite(tx, [b.sourceId], () => withTrustPromotion(tx, 'user_confirmed', () =>
        tx.executeRaw("UPDATE facts SET trust_tier='user_confirmed' WHERE id=$1", [Number(old.id)])), TEST_WRITE_ATTRIBUTION));
      const agent = await run(b.remote, 'remember', { fact: 'Alice lives in Berlin', provenance: 'web page', entity: SLUG, replaces: String(old.id) });
      expect(agent.contested?.proposal_ref).toMatch(/^tp\d+$/);
      const id = parseTrustProposalRef(agent.contested.proposal_ref)!;

      const accepted = await decideTrustProposal(engine, id, 'accept', owner);
      expect(accepted.status).toBe('accepted');
      expect(await factRow(engine, old.id)).toMatchObject({ superseded_by: Number(agent.id) });
      expect((await factRow(engine, old.id)).expired_at).not.toBeNull();
      expect((await factRow(engine, agent.id)).trust_tier).toBe('user_confirmed');
      const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: b.sourceId }))!;
      const fence = parseFactsFence((await materializedPage(engine, snapshot.page)).compiled_truth);
      expect(fence.facts.find(f => f.claim === 'Alice lives in Paris')?.active).toBe(false);

      const undone = await decideTrustProposal(engine, id, 'undo', owner);
      expect(undone.status).toBe('undone');
      expect((await factRow(engine, old.id)).expired_at).toBeNull();
      expect((await factRow(engine, agent.id)).trust_tier).toBe('agent_written');
    }
  }), 300_000);
});
