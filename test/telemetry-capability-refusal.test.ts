/**
 * Telemetry and budget reads must not invent values on an engine that cannot serve them.
 *
 * The Rust engine refuses raw SQL with `engine_capability_missing`. Before this test, the search-stats read, the
 * get_usage op, the semantic-cache stats and prune, the fence and content repair plans and the doctor fence check
 * turned that refusal into zeros, `table_present: false` or "no ledger", so a Rust brain answered with numbers PGLite
 * would never give. Each read now lets the refusal through and keeps its fail-open answer for any other error (a
 * brain that predates the table still shows zeros).
 *
 * The engine here is a real PGLite brain whose executeRaw refuses, with the error the Rust engine throws, every
 * statement that names the telemetry table under test, and whose typed members that read that table (TYPED_READERS)
 * refuse the same way, as a Rust engine without the member's capability does. Everything else runs on PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { capabilityMissing } from '../src/core/rust-engine/errors.ts';
import type { Capability } from '../src/core/engine-capabilities.ts';
import { readSearchStats } from '../src/core/search/telemetry.ts';
import { usageOperations } from '../src/core/ops/usage.ts';
import { SemanticQueryCache } from '../src/core/search/query-cache.ts';
import { fencesRepair } from '../src/core/repair/fences.ts';
import { slugConflictsRepair } from '../src/core/repair/slug-conflicts.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { fenceIntegrityResult } from '../src/commands/doctor/checks/fence-integrity.ts';

let pglite: PGLiteEngine;

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
}, 60_000);

afterAll(async () => { await pglite.disconnect(); });

type Failure = 'refusal' | 'missing-table';

/**
 * Typed engine members that read a table under test, with the capability the Rust engine gates them on
 * (src/core/rust-engine/members.ts). readSearchStats left executeRaw for the typed member (engine-sql/telemetry.ts);
 * get_usage left it for readChatUsage (engine-sql/chat-usage.ts).
 */
const TYPED_READERS: Record<string, Record<string, Capability>> = {
  search_telemetry: { readSearchStats: 'telemetry' },
  chat_usage_log: { readChatUsage: 'telemetry' },
  budget_ledger: { readBudgetLedgerDay: 'persistence_journal' },
};

/**
 * PGLite, except that executeRaw fails every statement naming `table`, and each typed member in TYPED_READERS[table]
 * fails every call: with the Rust refusal, or as a missing table.
 */
function failing(table: string, failure: Failure): BrainEngine {
  const hit = new RegExp(`\\b${table}\\b`);
  const typed = TYPED_READERS[table] ?? {};
  return new Proxy(pglite, {
    get(target, prop) {
      if (typeof prop === 'string' && Object.hasOwn(typed, prop)) {
        return async () => {
          if (failure === 'refusal') throw capabilityMissing(typed[prop]!, prop);
          throw new Error(`relation "${table}" does not exist`);
        };
      }
      if (prop === 'executeRaw') {
        return async (sql: string, params?: unknown[]) => {
          if (hit.test(sql)) {
            if (failure === 'refusal') throw capabilityMissing('raw_sql', 'executeRaw');
            throw new Error(`relation "${table}" does not exist`);
          }
          return target.executeRaw(sql, params);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
}

const refused = { code: 'engine_capability_missing' };

function opCtx(engine: BrainEngine): OperationContext {
  return { engine, config: {} as OperationContext['config'], logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false, remote: false, sourceId: 'default' } as OperationContext;
}

const getUsage = usageOperations.find(op => op.name === 'get_usage')!;

describe('a refused telemetry read refuses instead of reporting invented values', () => {
  test('readSearchStats', async () => {
    await expect(readSearchStats(failing('search_telemetry', 'refusal'))).rejects.toMatchObject(refused);
    const missing = await readSearchStats(failing('search_telemetry', 'missing-table'));
    expect(missing.total_calls).toBe(0);
  });

  test('get_usage', async () => {
    await expect(getUsage.handler(opCtx(failing('chat_usage_log', 'refusal')), {})).rejects.toMatchObject(refused);
    const missing = await getUsage.handler(opCtx(failing('chat_usage_log', 'missing-table')), {}) as { coverage: { table_present: boolean } };
    expect(missing.coverage.table_present).toBe(false);
  });

  test('semantic cache stats and prune', async () => {
    const refusing = new SemanticQueryCache(failing('query_cache', 'refusal'));
    await expect(refusing.stats()).rejects.toMatchObject(refused);
    await expect(refusing.prune()).rejects.toMatchObject(refused);
    const missing = new SemanticQueryCache(failing('query_cache', 'missing-table'));
    expect(await missing.stats()).toEqual({ total_rows: 0, total_hits: 0, fresh_rows: 0, stale_rows: 0 });
    expect(await missing.prune()).toBe(0);
  });

  test('the fence repair plan reads the daily ledger', async () => {
    const scope = await resolveRepairScope(pglite, 'default');
    await expect(fencesRepair.plan(failing('budget_ledger', 'refusal'), scope, null, { apply: false })).rejects.toMatchObject(refused);
    const missing = await fencesRepair.plan(failing('budget_ledger', 'missing-table'), scope, null, { apply: false });
    expect(missing.llm?.cap_remaining_usd ?? null).toBeNull();
  }, 60_000);

  test('the slug-conflict repair plan reads the daily ledger', async () => {
    const scope = await resolveRepairScope(pglite, 'default');
    await expect(slugConflictsRepair.plan(failing('budget_ledger', 'refusal'), scope, null, { apply: false })).rejects.toMatchObject(refused);
    await slugConflictsRepair.plan(failing('budget_ledger', 'missing-table'), scope, null, { apply: false });
  }, 60_000);

  test('the doctor fence check reads the daily ledger', async () => {
    await expect(fenceIntegrityResult(failing('budget_ledger', 'refusal'), { timeoutMs: 30_000 })).rejects.toMatchObject(refused);
    const missing = await fenceIntegrityResult(failing('budget_ledger', 'missing-table'), { timeoutMs: 30_000 });
    expect(missing.status).toBeDefined();
  }, 60_000);

  test('no ledger day read swallows every error into null', () => {
    // The two budget-stop messages (fences, slug conflicts) read the ledger only after a paid model call stops;
    // this scan keeps them, and any new reader, on the refusal-aware catch.
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts') && /\.readDay\([^)]*\)\.catch\(\(\) => null\)/.test(readFileSync(path, 'utf8'))) hits.push(path);
      }
    };
    walk('src');
    expect(hits).toEqual([]);
  });
});
