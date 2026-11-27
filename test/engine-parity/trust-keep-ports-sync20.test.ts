/**
 * BrainEngine parity — master's trust-tier fixes of #10389 (sync 20 group B) through the typed members the trunk moved
 * them into: the forget reason (#9739, appendFactForgetReason), the entity re-home (#10003, rehomeEntityFacts), the
 * relower's owner-decision rule (#10178, countClaimLiftedRows) and the claim classifier's chronicle timeline rank
 * (#10176, raw SQL the Rust engine refuses by name).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a write that authors no text (a forget reason, a re-home) keeps the stored trust tier of the facts it
 *    touches when the caller runs it inside withTrustKeep, as forget-prepare.ts and facts-rehome.ts now do; without it
 *    the tier drops to the write's own (unknown). A row a claim lifted that the owner decided since is not
 *    relowerable, so it is not counted, and a relower dry run with only such rows answers nothing to lower.
 *  - Regression: master's tests (withdrawal-keeps-trust-9739, rename-rekey-keeps-trust-10003,
 *    trust-relower-owner-decision-10178, trust-claim-chronicle-timeline-10176) run on PGLite and Postgres only; on a
 *    Rust brain an owner-decided claim row still made the relower refuse.
 *  - Seam: none. Real engines and typed members; withTrustKeep and withWriteTrust set the same transaction settings
 *    the callers set.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withTrustKeep, withTrustPromotion, withWriteTrust } from '../../src/core/persistence/context.ts';
import { relowerClaimedRows, runTrustBackfill } from '../../src/core/trust/backfill.ts';
import { setRowTier } from '../../src/core/trust/page-handlers.ts';
import type { WriteTrust } from '../../src/core/trust/tier.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());
const AGENT = { tier: 'agent_written', origin: { channel: 'agent' } } as unknown as WriteTrust;
const CLAIM = { tier: 'operator_curated', origin: { channel: 'trust_claim' } } as unknown as WriteTrust;

/** One fact about `entity`, written under the agent tier. */
async function agentFact(engine: BrainEngine, entity: string, text: string, rowNum: number | null): Promise<number> {
  const out = await engine.transaction(tx => withWriteTrust(tx, AGENT, () => tx.insertFacts([{
    fact: text, entity_slug: entity, source_markdown_slug: rowNum === null ? null : 'notes/holder', row_num: rowNum,
    kind: 'fact', visibility: 'world', source: 'cli',
  }] as never, { source_id: 'default' })));
  return Number((out as { ids: number[] }).ids[0]);
}
const tier = async (engine: BrainEngine, table: 'facts' | 'pages', id: number) => (await engine.readRowTrustTier(table, id))?.trust_tier ?? null;

describe('engine parity: sync 20 trust-tier ports (#10389)', () => {
  parityTest('#9739 a forget reason written inside withTrustKeep keeps the fact tier; written bare it drops',
    { methods: ['insertFacts', 'appendFactForgetReason', 'readRowTrustTier'], timeout: 120_000 }, async (engine) => {
      const kept = await agentFact(engine, 'people/alice-example', 'Alice runs the harbor ledger.', 1);
      const bare = await agentFact(engine, 'people/alice-example', 'Alice moved to the north office.', 2);
      await engine.transaction(tx => withTrustKeep(tx, ['facts'], () => tx.appendFactForgetReason(kept, 'default', 'forgotten: outdated')));
      await engine.transaction(tx => tx.appendFactForgetReason(bare, 'default', 'forgotten: outdated'));
      const out = { kept: await tier(engine, 'facts', kept), bare: await tier(engine, 'facts', bare) };
      expect(out).toEqual({ kept: 'agent_written', bare: 'unknown' });
      return out;
    });

  parityTest('#10003 a re-home inside withTrustKeep keeps the tier of the facts it moves; a bare re-home drops it',
    { methods: ['insertFacts', 'rehomeEntityFacts', 'readRowTrustTier'], timeout: 120_000 }, async (engine) => {
      const kept = await agentFact(engine, 'companies/acme-example', 'Acme ships widgets.', null);
      const bare = await agentFact(engine, 'companies/widget-co', 'Widget Co sells gears.', null);
      await engine.transaction(tx => withTrustKeep(tx, ['facts'], () => tx.rehomeEntityFacts('default', 'companies/acme-example', 'companies/acme-example-inc')));
      await engine.transaction(tx => tx.rehomeEntityFacts('default', 'companies/widget-co', 'companies/widget-co-ltd'));
      const out = { kept: await tier(engine, 'facts', kept), bare: await tier(engine, 'facts', bare) };
      expect(out).toEqual({ kept: 'agent_written', bare: 'unknown' });
      return out;
    });

  parityTest('#10178 a claim-lifted page the owner confirmed is not relowerable, and a relower dry run finds nothing',
    { methods: ['putPage', 'readRowTrustTier', 'setRowTrustTier', 'countClaimLiftedRows', 'listTrustClaimTargets', 'listTrustColumns'], timeout: 120_000 },
    async (engine) => {
      await engine.transaction(tx => withTrustPromotion(tx, 'operator_curated', () => withWriteTrust(tx, CLAIM, () =>
        seedPage(tx, { slug: 'atoms/2026-09-07/a', input: { type: 'atom', title: 'Atom', compiled_truth: 'Body.', timeline: '' } }))));
      const page = await engine.getPage('atoms/2026-09-07/a', { sourceId: 'default' });
      const id = Number(page!.id);
      const lifted = await engine.countClaimLiftedRows('pages');
      const confirmed = await setRowTier(engine, { table: 'pages', id, sourceId: 'default', tier: 'user_confirmed', ceiling: 'user_confirmed' });
      const out = {
        lifted, confirmed, tier: await tier(engine, 'pages', id),
        after: await engine.countClaimLiftedRows('pages'),
        relower: (await relowerClaimedRows(engine, { dryRun: true, sources: ['default'] })).rows,
      };
      expect(out).toEqual({ lifted: 1, confirmed: true, tier: 'user_confirmed', after: 0, relower: 0 });
      return out;
    });

  parityTest('#10176 the claim classifier (chronicle timeline rank included) is raw SQL: a dry run answers on SQL engines, Rust refuses it by name',
    { methods: ['listTrustColumns'], requires: 'raw_sql', timeout: 120_000 }, async (engine, backend) => {
      try {
        const report = await runTrustBackfill(engine, { dryRun: true });
        return { mode: report.mode };
      } catch (error) {
        // No Rust twin of the classifier: the Rust engine refuses the backfill by name before it reads a row.
        if (backend === 'rust') expect(error).toMatchObject({ code: 'engine_capability_missing', detail: expect.stringContaining('member=runTrustBackfill capability=raw_sql') });
        throw error;
      }
    });
});
