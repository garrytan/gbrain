/**
 * Engine parity for the catalog probes: the doctor and core reads of Postgres internals (pg_proc, pg_index and planner
 * statistics, pg_policy, server settings, the relation catalog, to_regclass, the links constraint and pgvector).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every probe answers on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1). On PGLite and Postgres the probe runs the same SQL as before. On the Rust engine it answers
 *    from the store's capability list, or the doctor check reports "skipped: not applicable on this engine" with
 *    `details.outcome: 'skipped'` and a reason, never a pass it did not measure (docs/designs/RUST_ENGINE_INTERFACES.md,
 *    "catalog probes").
 *  - Regression: before the change each probe sent catalog SQL through `executeRaw`, which the Rust engine refuses
 *    (`engine_capability_missing`, raw_sql), so `gbrain doctor` on a Rust brain reported "probe failed" for checks that do
 *    not apply there, or stopped. Each case catches the probe's error and returns whether it answered, so a refusal the
 *    case caught fails the Rust arm (rust-arm.ts) and the case is fail-first.
 *  - Why existing coverage misses it: raw-sql.test.ts proves executeRaw refuses on Rust; nothing called the probes that
 *    read through it on a Rust brain.
 *  - Why this file is not under test/engine-parity/: on the Rust engine these probes call no engine member at all (they
 *    read the capability list), and every case there must name a member it calls on every arm. The cases still run
 *    through the parity harness, so each arm's answer is compared with PGLite's.
 *  - Seam: none. Real engines; doctor entries run with the minimal context they read (engine and a progress stub).
 *  - Not covered here, because no Rust caller reaches them yet: the set_config sites (each runs inside
 *    `engine.transaction`, which the Rust engine does not serve), the pg_stat_activity read in fence-repair/census.ts
 *    (the census around it is raw SQL), relation sizes (the row counts beside them are raw SQL) and the old-migration
 *    checks (a Rust brain starts on the current format).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './engine-parity/harness.ts';
import { testBackends } from './helpers/test-backends.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { reportsCapability } from '../src/core/rust-engine/store-members/catalog.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext, DoctorEntry } from '../src/commands/doctor/context.ts';
import { functionSearchPathEntry } from '../src/commands/doctor/checks/function-search-path.ts';
import { schemaFunctionBodiesEntry } from '../src/commands/doctor/checks/schema-function-bodies.ts';
import { plannerStatsEntry } from '../src/commands/doctor/checks/planner-stats.ts';
import { databaseEncodingEntry } from '../src/commands/doctor/checks/database-encoding.ts';
import { sessionLaneBudgetEntry } from '../src/commands/doctor/checks/session-lane.ts';
import { ownerHostStaleEntry } from '../src/commands/doctor/checks/owner-host-stale.ts';
import { rlsEntry, rlsEventTriggerEntry } from '../src/commands/doctor/checks/schema-health.ts';
import { jsonbIntegrityCheck, pagesUpsertArbiterCheck, pgvectorCheck } from '../src/commands/doctor/checks/core-health.ts';
import { checkManagedGuardSchemaDrift } from '../src/commands/doctor/checks/managed-guard.ts';
import { requestIndexesCheck } from '../src/commands/doctor/checks/persistence-requests.ts';
import { checkBrainstormHealth } from '../src/commands/doctor/checks/graph-embedding.ts';
import { readExpressionIndexesWithoutStats } from '../src/core/planner-stats.ts';
import { checkLinkSourceCheck } from '../src/core/link-source-check-repair.ts';

const { parityTest } = parityArms(testBackends());

const ctxFor = (engine: BrainEngine) =>
  ({ engine, args: [], progress: { heartbeat: () => undefined } }) as unknown as DoctorContext;

async function runEntry(engine: BrainEngine, entry: DoctorEntry): Promise<Check[]> {
  return (await entry.run(ctxFor(engine))) as Check[];
}

/** The explicit fixture for an engine that does not report `drop`: the same engine, its capability list without them. */
function withoutCapabilities<E extends BrainEngine>(engine: E, drop: readonly string[]): E {
  const without = new Set([...engine.capabilities].filter((c) => !drop.includes(c)));
  return new Proxy(engine, { get: (target, prop) => {
    if (prop === 'capabilities') return without;
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

/** What every arm shares: the check answered, and under which name. The per-arm answer is asserted beside it. */
async function answered(probe: () => Promise<Check | Check[]>): Promise<{ answered: true; checks: Check[] } | { answered: false; error: string }> {
  try {
    const result = await probe();
    return { answered: true, checks: Array.isArray(result) ? result : [result] };
  } catch (error) {
    return { answered: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const skipped = (check: Check | undefined) => (check?.details as { outcome?: unknown } | undefined)?.outcome === 'skipped';

/**
 * One group: run each probe, assert the Rust skip (outcome, reason, an ok status that says "Skipped") or the SQL path on
 * the other arms (no skip marker, a real check), and return the names that answered.
 */
async function group(engine: BrainEngine, backend: string, probes: Array<[string, () => Promise<Check | Check[]>, string]>) {
  const out: Record<string, unknown> = {};
  for (const [label, probe, reason] of probes) {
    const result = await answered(probe);
    if (!result.answered) { out[label] = result; continue; }
    const [check] = result.checks;
    if (backend === 'rust') {
      expect({ label, status: check?.status, skipped: skipped(check), reason: (check?.details as { reason?: unknown })?.reason })
        .toEqual({ label, status: 'ok', skipped: true, reason });
      expect(check!.message).toStartWith('Skipped: not applicable on this engine; ');
    } else {
      expect({ label, skipped: skipped(check) }).toEqual({ label, skipped: false });
    }
    out[label] = { answered: true, names: result.checks.map((c) => c.name) };
  }
  return out;
}

describe('engine parity: catalog probes', () => {
  parityTest('pg_proc: the function search-path and function-body checks answer (skipped on Rust: no SQL functions)', { methods: [] }, async (engine, backend) =>
    group(engine, backend, [
      ['function_search_path', () => runEntry(engine, functionSearchPathEntry), 'no_sql_functions'],
      ['schema_function_bodies', () => runEntry(engine, schemaFunctionBodiesEntry), 'no_sql_functions'],
    ]));

  parityTest('pg_index and planner statistics: the stale-statistics check and the expression-index read answer', { methods: [] }, async (engine, backend) => {
    const checks = await group(engine, backend, [['planner_stats_stale', () => runEntry(engine, plannerStatsEntry), 'no_planner']]);
    let gaps: unknown;
    try {
      const rows = await readExpressionIndexesWithoutStats(engine);
      if (backend === 'rust') expect(rows).toEqual([]);
      gaps = { answered: true, isArray: Array.isArray(rows) };
    } catch (error) {
      gaps = { answered: false, error: String(error) };
    }
    return { checks, gaps };
  });

  parityTest('relation catalog: the column, index, JSONB, guard, upsert-index and brainstorm checks answer (skipped on Rust)', { methods: [] }, async (engine, backend) =>
    group(engine, backend, [
      ['managed_guard_schema_drift', () => checkManagedGuardSchemaDrift(engine), 'no_relation_catalog'],
      ['persistence_request_indexes', () => requestIndexesCheck(engine), 'no_planner'],
      ['jsonb_integrity', () => jsonbIntegrityCheck(engine), 'no_jsonb_storage'],
      ['pages_upsert_arbiter', () => pagesUpsertArbiterCheck(engine), 'store_keyed_pages'],
      ['brainstorm_health', () => checkBrainstormHealth(engine), 'no_relation_catalog'],
    ]));

  parityTest('pg_policy and server settings: the row-policy and encoding checks answer without a SQL read on Rust', { methods: [] }, async (engine, backend) => {
    const probes: Array<[string, () => Promise<Check[]>, string]> = [
      ['rls', () => runEntry(engine, rlsEntry), 'no_row_policies'],
      ['rls_event_trigger', () => runEntry(engine, rlsEventTriggerEntry), 'no_row_policies'],
      ['database_encoding', () => runEntry(engine, databaseEncodingEntry), 'utf8_store'],
    ];
    if (backend !== 'pglite') return group(engine, backend, probes);
    // PGLite already skips these three with its own message; the names and the ok status are what the arms share.
    const out: Record<string, unknown> = {};
    for (const [label, probe] of probes) {
      const result = await answered(probe);
      if (result.answered) expect({ label, status: result.checks[0]?.status }).toEqual({ label, status: 'ok' });
      out[label] = result.answered ? { answered: true, names: result.checks.map((c) => c.name) } : result;
    }
    return out;
  });

  parityTest('postgres_admin: the connection-pool check is not applicable off Postgres', { methods: [] }, async (engine, backend) => {
    const [check] = await runEntry(engine, sessionLaneBudgetEntry);
    if (backend === 'postgres') return { name: check!.name, notApplicable: true };
    expect(check!.readiness_state).toBe('not_applicable');
    return { name: check!.name, notApplicable: true };
  });

  parityTest('tableExists: the managed-journal check answers from the persistence_journal capability on Rust', { methods: [] }, async (engine, backend) => {
    const result = await answered(() => runEntry(engine, ownerHostStaleEntry));
    if (!result.answered) return result;
    const [check] = result.checks;
    // The released state: the Rust store keeps the journal and serves managed mode, so the check reads the owner hosts
    // through the topology store (no skip).
    if (backend === 'rust') expect({ status: check?.status, outcome: (check?.details as { outcome?: unknown } | undefined)?.outcome, reason: (check?.details as { reason?: unknown } | undefined)?.reason })
      .toEqual({ status: 'ok', outcome: undefined, reason: undefined });
    return { answered: true, names: result.checks.map((c) => c.name), status: check?.status };
  });

  parityTest('tableExists: an engine without the journal capabilities keeps no managed write journal', { methods: [] }, async (engine, backend) => {
    // The explicit no-capabilities fixture: this engine seen without persistence_journal and managed_persistence.
    const bare = withoutCapabilities(engine, ['persistence_journal', 'managed_persistence']);
    const result = await answered(() => runEntry(bare, ownerHostStaleEntry));
    if (!result.answered) return result;
    const [check] = result.checks;
    if (backend === 'rust') expect({ status: check?.status, message: check?.message }).toEqual({ status: 'ok', message: 'This brain keeps no managed write journal.' });
    return { answered: true, names: result.checks.map((c) => c.name), status: check?.status };
  });

  parityTest('links: the link_source CHECK constraint reads as present with nothing to repair', { methods: [] }, async (engine) => {
    try {
      const status = await checkLinkSourceCheck(engine);
      return { tablePresent: status.tablePresent, constraintPresent: status.constraintPresent, needsRepair: status.needsRepair, drift: status.drift };
    } catch (error) {
      return { answered: false, error: String(error) };
    }
  });

  parityTest('pgvector: the extension check answers from the vector_search capability on Rust', { methods: [] }, async (engine, backend) => {
    const result = await answered(() => pgvectorCheck(engine));
    if (!result.answered) return result;
    const [check] = result.checks;
    if (backend === 'rust') {
      // The Rust store reports vector_search (this expectation was stale before the journal flip: it failed on the unflipped head too).
      expect({ status: check?.status, message: check?.message }).toEqual({ status: 'ok', message: 'Vector search is served by the engine store (no pgvector extension)' });
    } else {
      expect(skipped(check)).toBe(false);
    }
    return { answered: true, name: check?.name, status: check?.status };
  });

  parityTest('pgvector: an engine store without vector_search skips the check, naming the capability', { methods: [] }, async (engine, backend) => {
    const result = await answered(() => pgvectorCheck(withoutCapabilities(engine, ['vector_search'])));
    if (!result.answered) return result;
    const [check] = result.checks;
    if (backend === 'rust') {
      expect({ skipped: skipped(check), capability: (check?.details as { capability?: unknown })?.capability }).toEqual({ skipped: true, capability: 'vector_search' });
    } else {
      expect(skipped(check)).toBe(false);
    }
    return { answered: true, name: check?.name };
  });
});
