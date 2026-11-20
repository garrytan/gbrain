/**
 * BrainEngine parity: the spend ledger and the client budget rows (engine-sql/spend-log.ts): `reserveClientSpend`,
 * `reserveGroupSpend`, `readGroupSpendTotals`, `settleSpendWithLog`, `insertSpendLog`, `sumClientSpendSince`,
 * `readClientBudgetUsd`, `insertOauthClient`, `updateOauthClientBudget` and `readAgentClientSpend`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the same calls return the same answers on every engine arm (PGLite always; Postgres with DATABASE_URL;
 *    the Rust arm through test/engine-parity/harness.ts). A client hold is admitted while the day's ledger sum, every
 *    open hold (pending or overdue) and the new estimate stay within the lower of the caller's cap and the client's
 *    configured cap, and refused beyond it (the refusal reports the sums and inserts nothing). An unknown estimate, or
 *    an open hold of unknown usage, refuses under a cap and passes without one. A group hold is bounded by the room
 *    left under its lifetime cap: `exhausted` when the ledger and the overdue holds leave none, `pressure` when only
 *    live holds are in the way. A settle writes one ledger row, once, and the ledger sums count it. The agent spend view
 *    lists the live clients with the agent scope or tool binding, by name, with today's sum, open and unknown holds and
 *    open `subagent` jobs. A refused admission changes nothing, including the sweep it ran.
 *  - Regression: an engine that ignores the client's configured cap, sums yesterday's ledger into today, forgets that an
 *    overdue hold still counts, lets an unknown estimate through a cap, double-counts a re-settle, treats a group's
 *    pressure as exhaustion (or the reverse), counts a deleted client's jobs or another client's holds, or keeps the
 *    sweep of a refused admission -- a budget cap that admits paid calls it should refuse, or refuses ones it should
 *    admit, differently per engine.
 *  - Why existing coverage misses it: test/minions/budget-meter.test.ts and test/admin-agents-spend.test.ts run on
 *    PGLite only and seed with raw SQL; a Rust engine has no raw SQL.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18). The ledger is stamped by the engine's clock, so
 *    the day boundary is exercised by the `day_start`/`since` the caller passes (a day ago counts every row, an hour
 *    ahead counts none). Names sort in lower-case ASCII, which every engine's collation orders the same way.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, AdmitJobSpec, ClaimJobSpec, JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import type { SpendReservationInsert } from '../../src/core/engine-sql/jobs-spend.ts';
import type { ClientReserveSpec, GroupReserveSpec, OauthClientInsert } from '../../src/core/engine-sql/spend-log.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority, type SubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { reserve, reserveGroup } from '../../src/core/minions/budget-meter.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const PAST = new Date('2000-01-01T00:00:00.000Z');
const DAY_AGO = new Date(Date.now() - 24 * 3_600_000);
const HOUR_AHEAD = new Date(Date.now() + 3_600_000);

function client(id: string, extra: Partial<OauthClientInsert> = {}): OauthClientInsert {
  return { client_id: id, client_name: id, scope: 'read', budget_usd_per_day: null, bound_tools: null, deleted_at: null, ...extra };
}

function ask(n: number, extra: Partial<ClientReserveSpec> = {}): ClientReserveSpec {
  return {
    reservation_id: uuid(n), client_id: 'client-a', estimated_cents: 5, cap_cents: null, estimate_known: true,
    model: 'anthropic:claude-sonnet', provider: 'anthropic', job_id: null, expires_at: FUTURE, day_start: DAY_AGO, ...extra,
  };
}

function askGroup(n: number, extra: Partial<GroupReserveSpec> = {}): GroupReserveSpec {
  return {
    reservation_id: uuid(n), budget_key: 'group:g1', estimated_cents: 5, cap_cents: null, estimate_known: true,
    model: 'anthropic:claude-sonnet', provider: 'anthropic', job_id: null, expires_at: FUTURE, ...extra,
  };
}

function hold(n: number, extra: Partial<SpendReservationInsert> = {}): SpendReservationInsert {
  return {
    reservation_id: uuid(n), client_id: 'client-a', budget_key: null, job_id: null, estimated_cents: 5,
    model: 'anthropic:claude-sonnet', provider: 'anthropic', expires_at: FUTURE, estimate_known: true,
    usage_unknown_reason: null, ...extra,
  };
}

/** Whether a call threw (constraint messages name the engine's own driver, so only the fact is compared); a typed refusal propagates. */
async function threw(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'engine_capability_missing') throw error;
    return true;
  }
}

function values(name: string, extra: Partial<JobInsertValues> = {}): JobInsertValues {
  return {
    name, queue: 'default', status: 'waiting', priority: 0, data: {}, max_attempts: 3, backoff_type: 'exponential',
    backoff_delay: 1000, backoff_jitter: 0.2, delay_until: null, parent_job_id: null, on_child_fail: 'fail_parent',
    max_children: null, timeout_ms: null, lock_duration_ms: null, remove_on_complete: false, remove_on_fail: false,
    idempotency_key: null, quiet_hours: null, stagger_key: null, private_queue_owner_job_id: null,
    private_queue_owner_token: null, private_queue_lease_until: null, submission_authority: APPLICATION_AUTHORITY,
    spend_authorization: null, max_stalled: null, ...extra,
  };
}

function policy(authority: SubmissionAuthority = APPLICATION_AUTHORITY): AdmitJobPolicy {
  return {
    decide: async (_tx, row) => coalesceDecision(row, authority),
    parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
  };
}

async function add(engine: BrainEngine, name: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const out = await engine.admitJob({ maxSpawnDepth: 5, insert: values(name, extra) } as Partial<AdmitJobSpec> & { insert: JobInsertValues } as AdmitJobSpec, policy());
  expect(out.coalesced).toBe(false);
  await Bun.sleep(2);
  return Number(out.row.id);
}

function claimSpec(token: string, name: string): ClaimJobSpec {
  return {
    lockToken: token, lockDurationMs: 30_000, queue: 'default', names: [name], handlerTimeouts: {},
    handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 },
  };
}

describe('engine parity: spend ledger and client budgets', () => {
  parityTest('a client hold is admitted up to the cap and refused beyond it, counting the open holds and the ledger of the day',
    { methods: ['insertOauthClient', 'reserveClientSpend', 'settleSpendWithLog', 'sumClientSpendSince'] }, async engine => {
      await engine.insertOauthClient(client('client-a', { budget_usd_per_day: 1 }));
      const one = await engine.reserveClientSpend(ask(1, { estimated_cents: 40 }));
      const two = await engine.reserveClientSpend(ask(2, { estimated_cents: 40 }));
      const over = await engine.reserveClientSpend(ask(3, { estimated_cents: 30 }));
      const exact = await engine.reserveClientSpend(ask(4, { estimated_cents: 20 }));
      const settled = await engine.settleSpendWithLog(uuid(1), 10, 'subagent_loop', 'tok');
      const afterSettle = await engine.reserveClientSpend(ask(5, { estimated_cents: 31 }));
      // The day boundary: a ledger row older than `day_start` is not today's.
      const tomorrow = await engine.reserveClientSpend(ask(6, { estimated_cents: 31, day_start: HOUR_AHEAD }));
      const fits = await engine.reserveClientSpend(ask(7, { estimated_cents: 30 }));
      return {
        one, two, over, exact, settled, afterSettle, tomorrow, fits,
        sinceYesterday: await engine.sumClientSpendSince('client-a', DAY_AGO),
        sinceTomorrow: await engine.sumClientSpendSince('client-a', HOUR_AHEAD),
        stranger: await engine.sumClientSpendSince('client-zzz', DAY_AGO),
      };
    });

  parityTest('the cap is the lower of the caller\'s and the client\'s, and none when neither is set',
    { methods: ['insertOauthClient', 'reserveClientSpend'] }, async engine => {
      await engine.insertOauthClient(client('client-a', { budget_usd_per_day: 1 }));
      await engine.insertOauthClient(client('client-b'));
      await engine.insertOauthClient(client('client-c', { budget_usd_per_day: 0 }));
      return {
        callerLower: await engine.reserveClientSpend(ask(1, { estimated_cents: 60, cap_cents: 50 })),
        callerHigher: await engine.reserveClientSpend(ask(2, { estimated_cents: 110, cap_cents: 500 })),
        configuredOnly: await engine.reserveClientSpend(ask(3, { estimated_cents: 101 })),
        callerOnly: await engine.reserveClientSpend(ask(4, { client_id: 'client-b', estimated_cents: 60, cap_cents: 50 })),
        neither: await engine.reserveClientSpend(ask(5, { client_id: 'client-b', estimated_cents: 1_000_000 })),
        noRow: await engine.reserveClientSpend(ask(6, { client_id: 'client-none', estimated_cents: 70, cap_cents: 60 })),
        noRowOpen: await engine.reserveClientSpend(ask(7, { client_id: 'client-none', estimated_cents: 70 })),
        zeroCap: await engine.reserveClientSpend(ask(8, { client_id: 'client-c', estimated_cents: 0 })),
        zeroCapMore: await engine.reserveClientSpend(ask(9, { client_id: 'client-c', estimated_cents: 0.01 })),
        fits: await engine.reserveClientSpend(ask(10, { estimated_cents: 100 })),
        exactlyFull: await engine.reserveClientSpend(ask(11, { estimated_cents: 0 })),
        oneMore: await engine.reserveClientSpend(ask(12, { estimated_cents: 0.0001 })),
      };
    });

  parityTest('an overdue hold stays charged, the sweep is per client, and a refused admission keeps no sweep',
    { methods: ['insertOauthClient', 'insertSpendReservation', 'reserveClientSpend', 'expireSpendReservations', 'settleSpendWithLog'] }, async engine => {
      await engine.insertOauthClient(client('client-a', { budget_usd_per_day: 1 }));
      await engine.insertSpendReservation(hold(1, { estimated_cents: 70, expires_at: PAST }));
      await engine.insertSpendReservation(hold(2, { client_id: 'client-b', estimated_cents: 50, expires_at: PAST }));
      await engine.insertSpendReservation(hold(3, { client_id: null, budget_key: 'group:g1', estimated_cents: 50, expires_at: PAST }));
      const refused = await engine.reserveClientSpend(ask(4, { estimated_cents: 40 }));
      // The refusal is an outcome, not a rollback: the sweep it ran is kept (the caller rolls back by throwing).
      const sweepOther = await engine.expireSpendReservations({ clientId: 'client-b' });
      const sweepGroup = await engine.expireSpendReservations({ budgetKey: 'group:g1' });
      const sweepAgain = await engine.expireSpendReservations({ clientId: 'client-a' });
      const lateSettle = await engine.settleSpendWithLog(uuid(1), 30, 'subagent_loop', null);
      const afterLate = await engine.reserveClientSpend(ask(5, { estimated_cents: 70 }));
      const afterLateFits = await engine.reserveClientSpend(ask(6, { estimated_cents: 40 }));
      // An admission that throws (a job that does not exist) rolls its sweep back with it.
      await engine.insertSpendReservation(hold(7, { client_id: 'client-d', estimated_cents: 1, expires_at: PAST }));
      const threwNoJob = await threw(() => engine.reserveClientSpend(ask(8, { client_id: 'client-d', job_id: 987_654 })));
      const sweptAfterThrow = await engine.expireSpendReservations({ clientId: 'client-d' });
      return { refused, sweepOther, sweepGroup, sweepAgain, lateSettle, afterLate, afterLateFits, threwNoJob, sweptAfterThrow };
    });

  parityTest('a refused reservation through the budget meter leaves its overdue holds pending, a granted one sweeps them',
    { methods: ['insertOauthClient', 'insertSpendReservation', 'reserveClientSpend', 'reserveGroupSpend', 'expireSpendReservations'] }, async engine => {
      // The meter runs the admission inside engine.transaction and throws on a refusal, which rolls the sweep back.
      const refusedClient = async (clientId: string, estimatedCents: number, capCents: number | null) => {
        try {
          await reserve(engine, { clientId, estimatedCents, capCents, model: 'anthropic:claude-sonnet', provider: 'anthropic' });
          return 'reserved';
        } catch (error) {
          return (error as Error).name;
        }
      };
      const refusedGroup = async (budgetKey: string, estimatedCents: number, capCents: number | null) => {
        try {
          await reserveGroup(engine, { budgetKey, estimatedCents, capCents, model: 'anthropic:claude-sonnet', provider: 'anthropic' });
          return 'reserved';
        } catch (error) {
          return (error as Error).name;
        }
      };
      await engine.insertOauthClient(client('client-a'));
      await engine.insertOauthClient(client('client-b'));
      await engine.insertSpendReservation(hold(1, { estimated_cents: 70, expires_at: PAST }));
      await engine.insertSpendReservation(hold(2, { client_id: 'client-b', estimated_cents: 1, expires_at: PAST }));
      await engine.insertSpendReservation(hold(3, { client_id: null, budget_key: 'group:g1', estimated_cents: 100, expires_at: PAST }));
      await engine.insertSpendReservation(hold(4, { client_id: null, budget_key: 'group:g2', estimated_cents: 1, expires_at: PAST }));
      const clientRefused = await refusedClient('client-a', 40, 100);
      const groupRefused = await refusedGroup('group:g1', 40, 100);
      // Nothing of the refused admissions stays: the sweep still finds each overdue hold pending.
      const clientSweepAfterRefusal = await engine.expireSpendReservations({ clientId: 'client-a' });
      const groupSweepAfterRefusal = await engine.expireSpendReservations({ budgetKey: 'group:g1' });
      // A granted reservation keeps its sweep: the overdue hold is already marked when the next sweep looks.
      const clientGranted = await refusedClient('client-b', 1, 100);
      const groupGranted = await refusedGroup('group:g2', 1, 100);
      const clientSweepAfterGrant = await engine.expireSpendReservations({ clientId: 'client-b' });
      const groupSweepAfterGrant = await engine.expireSpendReservations({ budgetKey: 'group:g2' });
      expect([clientRefused, groupRefused, clientGranted, groupGranted]).toEqual(['BudgetExceededError', 'GroupBudgetRefusal', 'reserved', 'reserved']);
      expect([clientSweepAfterRefusal, groupSweepAfterRefusal, clientSweepAfterGrant, groupSweepAfterGrant]).toEqual([1, 1, 0, 0]);
      return { clientRefused, groupRefused, clientSweepAfterRefusal, groupSweepAfterRefusal, clientGranted, groupGranted, clientSweepAfterGrant, groupSweepAfterGrant };
    });

  parityTest('an unknown estimate or an open hold of unknown usage refuses under a cap and passes without one',
    { methods: ['insertOauthClient', 'insertSpendReservation', 'reserveClientSpend', 'settleSpendWithLog', 'markSpendUsageUnknown'] }, async engine => {
      await engine.insertOauthClient(client('client-a', { budget_usd_per_day: 100 }));
      await engine.insertOauthClient(client('client-b'));
      const cappedUnknown = await engine.reserveClientSpend(ask(1, { estimated_cents: 1, estimate_known: false }));
      const uncappedUnknown = await engine.reserveClientSpend(ask(2, { client_id: 'client-b', estimated_cents: 1, estimate_known: false }));
      const callerCapped = await engine.reserveClientSpend(ask(3, { client_id: 'client-b', estimated_cents: 1, estimate_known: false, cap_cents: 500 }));
      // An open unknown hold (uncapped admit above) blocks the next capped admission of its client.
      const blocked = await engine.reserveClientSpend(ask(4, { client_id: 'client-b', estimated_cents: 1, cap_cents: 500 }));
      const uncappedKnown = await engine.reserveClientSpend(ask(5, { client_id: 'client-b', estimated_cents: 1 }));
      const settled = await engine.settleSpendWithLog(uuid(2), 3, 'subagent_loop', null);
      const unblocked = await engine.reserveClientSpend(ask(6, { client_id: 'client-b', estimated_cents: 1, cap_cents: 500 }));
      await engine.insertSpendReservation(hold(7, { estimated_cents: 0, estimate_known: false, usage_unknown_reason: 'pricing_or_bound_unknown' }));
      const storedUnknown = await engine.reserveClientSpend(ask(8, { estimated_cents: 1 }));
      const marked = await engine.markSpendUsageUnknown(uuid(7), 'provider_usage_unknown');
      return { cappedUnknown, uncappedUnknown, callerCapped, blocked, uncappedKnown, settled, unblocked, storedUnknown, marked };
    });

  parityTest('a client\'s cap reads as dollars to two decimals, whether the client is live, deleted or missing, and can be changed',
    { methods: ['insertOauthClient', 'readClientBudgetUsd', 'updateOauthClientBudget', 'reserveClientSpend'] }, async engine => {
      await engine.insertOauthClient(client('client-a', { budget_usd_per_day: 5 }));
      await engine.insertOauthClient(client('client-b', { budget_usd_per_day: 0.29 }));
      await engine.insertOauthClient(client('client-c', { budget_usd_per_day: 12.5, deleted_at: new Date('2024-01-01T00:00:00Z') }));
      await engine.insertOauthClient(client('client-d'));
      await engine.insertOauthClient(client('client-e', { budget_usd_per_day: 0.005 }));
      const budgets = {
        five: await engine.readClientBudgetUsd('client-a'),
        cents: await engine.readClientBudgetUsd('client-b'),
        deleted: await engine.readClientBudgetUsd('client-c'),
        none: await engine.readClientBudgetUsd('client-d'),
        rounded: await engine.readClientBudgetUsd('client-e'),
        missing: await engine.readClientBudgetUsd('client-zzz'),
      };
      // A deleted client's cap still applies to a hold it places.
      const deletedRefused = await engine.reserveClientSpend(ask(1, { client_id: 'client-c', estimated_cents: 1251 }));
      const loose = await engine.reserveClientSpend(ask(2, { estimated_cents: 300 }));
      const tightened = await engine.updateOauthClientBudget('client-a', 1);
      const tight = await engine.reserveClientSpend(ask(3, { estimated_cents: 1 }));
      const cleared = await engine.updateOauthClientBudget('client-a', null);
      const open = await engine.reserveClientSpend(ask(4, { estimated_cents: 100_000 }));
      const missingUpdate = await engine.updateOauthClientBudget('client-zzz', 3);
      return {
        budgets, deletedRefused, loose, tightened, tight, cleared, open, missingUpdate,
        afterClear: await engine.readClientBudgetUsd('client-a'),
        repeated: await threw(() => engine.insertOauthClient(client('client-a'))),
      };
    });

  parityTest('a negative configured cap is reported, not applied',
    { methods: ['insertOauthClient', 'reserveClientSpend', 'insertSpendReservation', 'expireSpendReservations'] }, async engine => {
      await engine.insertOauthClient(client('client-a', { budget_usd_per_day: -1 }));
      const invalid = await engine.reserveClientSpend(ask(1, { estimated_cents: 1 }));
      const lowerCaller = await engine.reserveClientSpend(ask(2, { estimated_cents: 1, cap_cents: 0 }));
      // Nothing was inserted and the sweep did not run.
      await engine.insertSpendReservation(hold(3, { estimated_cents: 1, expires_at: PAST }));
      const again = await engine.reserveClientSpend(ask(4, { estimated_cents: 1 }));
      return { invalid, lowerCaller, again, swept: await engine.expireSpendReservations({ clientId: 'client-a' }) };
    });

  parityTest('a group hold is bounded by the room under its lifetime cap: exhausted when none is left, pressure when live holds are in the way',
    { methods: ['reserveGroupSpend', 'readGroupSpendTotals', 'settleSpendWithLog', 'insertSpendReservation'] }, async engine => {
      const first = await engine.reserveGroupSpend(askGroup(1, { estimated_cents: 60, cap_cents: 100 }));
      const pressure = await engine.reserveGroupSpend(askGroup(2, { estimated_cents: 60, cap_cents: 100 }));
      const fitsBeside = await engine.reserveGroupSpend(askGroup(3, { estimated_cents: 40, cap_cents: 100 }));
      const totalsLive = await engine.readGroupSpendTotals('group:g1');
      const settledAll = [
        await engine.settleSpendWithLog(uuid(1), 70, 'subagent_loop', null),
        await engine.settleSpendWithLog(uuid(3), 30, 'subagent_loop', null),
      ];
      const exhausted = await engine.reserveGroupSpend(askGroup(4, { estimated_cents: 5, cap_cents: 100 }));
      const freeKnown = await engine.reserveGroupSpend(askGroup(5, { estimated_cents: 0, cap_cents: 100 }));
      const freeUnknown = await engine.reserveGroupSpend(askGroup(6, { estimated_cents: 0, cap_cents: 100, estimate_known: false }));
      const raisedCap = await engine.reserveGroupSpend(askGroup(7, { estimated_cents: 500, cap_cents: 150 }));
      // Another group keeps its own totals; a bounded ask takes what is left; no cap admits as asked.
      const bounded = await engine.reserveGroupSpend(askGroup(8, { budget_key: 'group:g2', estimated_cents: 80, cap_cents: 50 }));
      const uncapped = await engine.reserveGroupSpend(askGroup(9, { budget_key: 'group:g3', estimated_cents: 1000 }));
      const uncappedAgain = await engine.reserveGroupSpend(askGroup(10, { budget_key: 'group:g3', estimated_cents: 1000 }));
      // An overdue hold counts as spent: 100 - 30 = 70 left.
      await engine.insertSpendReservation(hold(11, { client_id: null, budget_key: 'group:g4', estimated_cents: 30, expires_at: PAST }));
      const overdue = await engine.reserveGroupSpend(askGroup(12, { budget_key: 'group:g4', estimated_cents: 80, cap_cents: 100 }));
      return {
        first, pressure, fitsBeside, totalsLive, settledAll, exhausted, freeKnown, freeUnknown, raisedCap, bounded, uncapped, uncappedAgain,
        overdue,
        totals: {
          g1: await engine.readGroupSpendTotals('group:g1'),
          g2: await engine.readGroupSpendTotals('group:g2'),
          g3: await engine.readGroupSpendTotals('group:g3'),
          g4: await engine.readGroupSpendTotals('group:g4'),
          none: await engine.readGroupSpendTotals('group:none'),
        },
      };
    });

  parityTest('a settle writes one ledger row, once, for a pending or an overdue hold, and rounds to four decimals',
    { methods: ['insertSpendReservation', 'settleSpendWithLog', 'sumClientSpendSince', 'readGroupSpendTotals', 'settleSpendReservation'] }, async engine => {
      await engine.insertSpendReservation(hold(1));
      await engine.insertSpendReservation(hold(2, { expires_at: PAST }));
      await engine.insertSpendReservation(hold(3, { client_id: null, budget_key: 'group:g1' }));
      await engine.insertSpendReservation(hold(4, { client_id: 'client-b' }));
      const outcomes = {
        pending: await engine.settleSpendWithLog(uuid(1), 0.12345, 'subagent_loop', 'tok-a'),
        overdue: await engine.settleSpendWithLog(uuid(2), 1.5, 'subagent_loop', null),
        group: await engine.settleSpendWithLog(uuid(3), 2.25, 'subagent_loop', null),
        again: await engine.settleSpendWithLog(uuid(1), 99, 'subagent_loop', 'tok-a'),
        missing: await engine.settleSpendWithLog(uuid(99), 1, 'subagent_loop', null),
        free: await engine.settleSpendWithLog(uuid(4), 0, 'subagent_loop', null),
        badId: await threw(() => engine.settleSpendWithLog('not-a-uuid', 1, 'subagent_loop', null)),
      };
      // The plain settle of a hold the logged settle already settled changes nothing.
      const plain = await engine.settleSpendReservation(uuid(1), 7);
      return {
        outcomes, plain,
        clientA: await engine.sumClientSpendSince('client-a', DAY_AGO),
        clientB: await engine.sumClientSpendSince('client-b', DAY_AGO),
        group: await engine.readGroupSpendTotals('group:g1'),
      };
    });

  parityTest('an unreserved paid call is recorded in the ledger under its client and counted in the day\'s sum',
    { methods: ['insertSpendLog', 'sumClientSpendSince'] }, async engine => {
      await engine.insertSpendLog({ client_id: 'client-a', token_name: null, operation: 'search_by_image', spend_cents: 0.12, provider: 'voyage', model: 'voyage-multimodal-3' });
      await engine.insertSpendLog({ client_id: 'client-a', token_name: 'tok', operation: 'search_by_image', spend_cents: 0.12, provider: null, model: null });
      await engine.insertSpendLog({ client_id: 'client-b', token_name: null, operation: 'search_by_image', spend_cents: 5, provider: null, model: null });
      await engine.insertSpendLog({ client_id: null, token_name: 'anon', operation: 'search_by_image', spend_cents: 9, provider: null, model: null });
      await engine.insertSpendLog({ client_id: 'client-a', token_name: null, operation: 'x', spend_cents: 0.00004, provider: null, model: null });
      return {
        a: await engine.sumClientSpendSince('client-a', DAY_AGO),
        b: await engine.sumClientSpendSince('client-b', DAY_AGO),
        none: await engine.sumClientSpendSince('client-c', DAY_AGO),
        later: await engine.sumClientSpendSince('client-a', HOUR_AHEAD),
        overflow: await threw(() => engine.insertSpendLog({ client_id: 'client-a', token_name: null, operation: 'x', spend_cents: 1e9, provider: null, model: null })),
      };
    });

  parityTest('the agent spend view lists live agent clients by name with the day\'s ledger, open and unknown holds and open subagent jobs',
    { methods: ['insertOauthClient', 'insertSpendLog', 'insertSpendReservation', 'settleSpendWithLog', 'readAgentClientSpend', 'admitJob', 'claimNextJob', 'completeJob'] }, async engine => {
      // A client with the `agent` scope must carry a complete grant (a source, prefixes: a Postgres check the store does not
      // keep), so the scope half of the filter is checked in the store's own tests; here clients qualify by their tool binding.
      await engine.insertOauthClient(client('b-client', { client_name: 'bravo', scope: 'read', bound_tools: ['get_page'], budget_usd_per_day: 5 }));
      await engine.insertOauthClient(client('a-client', { client_name: 'alpha', scope: 'read', bound_tools: ['get_page', 'put_page'] }));
      await engine.insertOauthClient(client('c-client', { client_name: 'charlie', scope: 'read write', bound_tools: [] }));
      await engine.insertOauthClient(client('d-client', { client_name: 'delta', scope: 'read write' }));
      await engine.insertOauthClient(client('e-client', { client_name: 'echo', scope: 'read', bound_tools: ['get_page'], deleted_at: new Date('2024-01-01T00:00:00Z') }));
      await engine.insertOauthClient(client('f-client', { client_name: 'alpha', scope: 'agentic', bound_tools: ['query'] }));
      await engine.insertOauthClient(client('g-client', { client_name: 'golf', scope: 'read agentic' }));
      // An upper-case name sorts first in byte order and last under a locale collation.
      await engine.insertOauthClient(client('h-client', { client_name: 'Zulu', scope: 'read', bound_tools: ['get_page'] }));
      await engine.insertSpendLog({ client_id: 'b-client', token_name: null, operation: 'x', spend_cents: 1.25, provider: null, model: null });
      await engine.insertSpendLog({ client_id: 'b-client', token_name: null, operation: 'x', spend_cents: 0.5, provider: null, model: null });
      await engine.insertSpendLog({ client_id: 'd-client', token_name: null, operation: 'x', spend_cents: 4, provider: null, model: null });
      await engine.insertSpendReservation(hold(1, { client_id: 'b-client', estimated_cents: 10 }));
      await engine.insertSpendReservation(hold(2, { client_id: 'b-client', estimated_cents: 7, estimate_known: false, expires_at: PAST }));
      await engine.insertSpendReservation(hold(3, { client_id: 'b-client', estimated_cents: 99 }));
      await engine.settleSpendWithLog(uuid(3), 2, 'subagent_loop', null);
      await engine.insertSpendReservation(hold(4, { client_id: 'a-client', estimated_cents: 3, estimate_known: false }));
      await engine.insertSpendReservation(hold(5, { client_id: null, budget_key: 'group:g1', estimated_cents: 50 }));
      await add(engine, 'subagent', { data: { __owner_client_id: 'b-client' } });
      await add(engine, 'subagent', { data: { __owner_client_id: 'b-client' } });
      await add(engine, 'subagent', { data: { __owner_client_id: 'a-client' } });
      await add(engine, 'subagent', { data: { __owner_client_id: 'd-client' } });
      await add(engine, 'embed', { data: { __owner_client_id: 'b-client' } });
      await add(engine, 'subagent', { data: {} });
      const done = await add(engine, 'subagent', { data: { __owner_client_id: 'b-client' } });
      // Claim the one just added (the oldest waiting `subagent` job goes first, so claim until it comes up) and finish it.
      for (let i = 0; i < 7; i++) {
        const row = await engine.claimNextJob(claimSpec(`tok-${i}`, 'subagent'));
        if (row && Number(row.id) === done) { await engine.completeJob(done, `tok-${i}`); break; }
      }
      return { rows: await engine.readAgentClientSpend() };
    });
});
