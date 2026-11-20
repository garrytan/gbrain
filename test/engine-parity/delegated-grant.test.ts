/**
 * BrainEngine parity: a delegated client's spend admission reads its grant through typed members -- `readOauthClient`
 * (the client's row) and `listAllSources` (the active source ids) -- so `reserve(..., { validateAdmission })` in
 * src/core/minions/budget-meter.ts, with the policy of src/core/minions/delegated-spend.ts (`effectiveDelegation`), runs
 * the same on every engine arm.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a hold for a delegated client is admitted when the submitted snapshot still fits the client's CURRENT
 *    grant, and is refused with the policy's own denial (and writes no hold) when the client is gone or revoked, the
 *    submitted source or brain changed, the `submit_agent` operation or every submitted tool was withdrawn, the agent
 *    scope was dropped, or the client's source is no longer one it may read. The effective budget is the lower of the
 *    snapshot's and the current grant's, and a missing side is the other side.
 *  - Regression: a Rust engine whose grant read refuses (a delegated agent could never spend there), or one that reads
 *    the grant as it was submitted (a withdrawn tool, a revoked client or a lower budget keeps spending), or that
 *    admits a hold and then denies, so the hold is left behind -- an agent that spends past what its operator granted,
 *    or one that is refused on every spend, differently per engine.
 *  - Why existing coverage misses it: test/minions/delegated-execution.serial.test.ts and budget-meter.test.ts run on
 *    PGLite with raw SQL seeds; test/engine-parity/spend-log.test.ts reserves with no policy.
 *  - Seam: none. Real engines, typed methods only. The clients are made by `insertOauthClient`; a source archived after
 *    its client was made cannot be built on the Rust engine (no member archives a source), so that denial is not here.
 */
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OauthClientInsert } from '../../src/core/engine-sql/oauth-clients.ts';
import { reserve } from '../../src/core/minions/budget-meter.ts';
import { DelegationDeniedError, effectiveDelegation, type DelegationSnapshot } from '../../src/core/minions/delegated-policy.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

function grant(id: string, extra: Partial<OauthClientInsert> = {}): OauthClientInsert {
  return {
    client_id: id, client_name: id, scope: 'read write agent', bound_tools: ['get_page', 'put_page'], source_id: 'src-a',
    bound_source_id: 'src-a', federated_read: ['src-a'], delegated_namespace: 'prefixes', delegated_slug_prefixes: ['wiki/agents/*'],
    bound_max_concurrent: 3, budget_usd_per_day: 5, allowed_operations: null, ...extra,
  };
}

function snapshot(id: string, extra: Partial<DelegationSnapshot> = {}): DelegationSnapshot {
  return {
    clientId: id, sourceId: 'src-a', brainId: null, tools: ['get_page', 'put_page'], allowedOperations: null, slugPrefixes: ['wiki/agents/*'],
    namespace: 'prefixes', readSources: ['src-a'], scopes: ['read', 'write', 'agent'], maxConcurrent: 2, budgetUsdPerDay: '10.00', ...extra,
  };
}

async function setup(engine: BrainEngine, backend: ParityBackend): Promise<void> {
  await createSource(engine, backend, 'src-a');
  await createSource(engine, backend, 'src-b');
}

/** The outcome of one delegated hold: admitted, or the denial it ended with; and what the client's open holds are after. */
async function hold(engine: BrainEngine, id: string, snap: DelegationSnapshot): Promise<Record<string, unknown>> {
  let outcome: unknown;
  try {
    await reserve(engine, {
      clientId: id, capCents: null, estimatedCents: 7, model: 'anthropic:claude-sonnet', provider: 'anthropic',
      validateAdmission: async tx => { await effectiveDelegation(tx, snap); },
    });
    outcome = 'admitted';
  } catch (error) {
    if (!(error instanceof DelegationDeniedError)) throw error;
    outcome = { denied: error.reasons };
  }
  const spend = (await engine.readAgentClientSpend()).find(r => r.client_id === id);
  return { outcome, pending_cents: spend?.pending_cents ?? null };
}

describe('engine parity: delegated spend reads the grant through typed members', () => {
  parityTest('a delegated hold is admitted while the snapshot fits the current grant, and each withdrawal denies it with no hold left',
    { methods: ['readOauthClient', 'listAllSources', 'reserveClientSpend', 'readAgentClientSpend', 'insertOauthClient'] }, async (engine, backend) => {
      await setup(engine, backend);
      const cases: Array<[string, Partial<OauthClientInsert>, Partial<DelegationSnapshot>]> = [
        ['fits', {}, {}],
        ['narrower-tools', { bound_tools: ['get_page'] }, {}],
        ['operations-listed', { allowed_operations: ['submit_agent', 'get_page'] }, {}],
        ['submit-agent-withdrawn', { allowed_operations: ['get_page', 'put_page'] }, {}],
        ['all-tools-withdrawn', { bound_tools: ['search'] }, {}],
        ['revoked', { deleted_at: new Date('2025-01-01T00:00:00.000Z') }, {}],
        ['source-changed', { source_id: 'src-b', bound_source_id: 'src-b', federated_read: ['src-b'] }, {}],
        ['source-unreadable', { federated_read: ['src-a', 'src-b'], bound_source_id: 'src-a' }, { readSources: ['src-b'] }],
        ['brain-changed', { bound_brain_id: 'other' }, {}],
        ['agent-scope-dropped', { scope: 'read write', bound_tools: null, source_id: null, bound_source_id: null, federated_read: [] }, {}],
        ['snapshot-ops-missing', {}, { allowedOperations: ['get_page'] }],
        ['prefixes-disjoint', { delegated_slug_prefixes: ['other/*'] }, {}],
      ];
      const out: Record<string, unknown> = {};
      for (const [name, row, snap] of cases) {
        const id = `c-${name}`;
        await engine.insertOauthClient(grant(id, row));
        out[name] = await hold(engine, id, snapshot(id, snap));
      }
      out['client-gone'] = await hold(engine, 'c-nobody', snapshot('c-nobody'));
      return out;
    });

  parityTest('the effective grant keeps the lower budget and the narrower limits of the snapshot and the current grant',
    { methods: ['readOauthClient', 'listAllSources', 'insertOauthClient'] }, async (engine, backend) => {
      await setup(engine, backend);
      const cases: Array<[string, number | null, string | null, number, number]> = [
        ['snapshot-lower', 5, '3.00', 4, 2],
        ['current-lower', 2.5, '10.00', 1, 6],
        ['equal', 5, '5.00', 2, 2],
        ['current-none', null, '4.00', 3, 3],
        ['snapshot-none', 6.5, null, 3, 3],
        ['neither', null, null, 3, 3],
      ];
      const out: Record<string, unknown> = {};
      for (const [name, current, submitted, currentMax, submittedMax] of cases) {
        const id = `c-${name}`;
        await engine.insertOauthClient(grant(id, { budget_usd_per_day: current, bound_max_concurrent: currentMax }));
        const effective = await effectiveDelegation(engine, snapshot(id, { budgetUsdPerDay: submitted, maxConcurrent: submittedMax }));
        out[name] = { budgetUsdPerDay: effective.budgetUsdPerDay, maxConcurrent: effective.maxConcurrent, tools: effective.tools, readSources: effective.readSources };
      }
      return out;
    });
});
