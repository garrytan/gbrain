/**
 * Refactor wave 1, W0 / EO4 (T-G3 inventory part): which PostgresEngine
 * methods run their SQL through `withScopedReadTransaction` (RLS source-scope
 * binding, GBRAIN_RLS_SCOPE_BINDING) on master. W1's engine-sql read functions
 * must accept `ScopedRead` / `LegacyUnscopedRead` EXACTLY matching this: no
 * read may gain or lose the scoped transaction, and no read may gain a new
 * per-read pool hold (#1794 class).
 *
 * Two independent observations, cross-checked and pinned in
 * `test/fixtures/goldens/rls-scope-inventory.json`:
 *   - static: a TypeScript AST scan of `src/core/postgres-engine.ts` counts
 *     `this.withScopedReadTransaction(...)` call sites per class member and
 *     follows `this.<member>(...)` calls transitively;
 *   - runtime: every catalogued case (the EO8 SQL-text cases plus the
 *     out-of-domain read paths) runs through the recording fake with the flag
 *     ON (scoped = `set_config('app.scopes', ...)` observed in a transaction
 *     lane) and OFF (records whether master already opened a transaction,
 *     e.g. the search methods' SET LOCAL statement_timeout wrap).
 *
 * Reconciliation with the plan's "23 scoped sites": the source has 23 lines
 * naming `withScopedReadTransaction` = 1 definition + 22 call sites, in 21
 * methods (searchVector had 2); evidence delivery's getChunkWindows adds one,
 * and #5824 moves searchVector's ANN-attempt call into runVectorAttempt
 * (shared with explainVectorSearch): 23 call sites, 23 methods. Cat 40 Hard
 * F2 adds the scoped keyword count and keyword-mode page reads
 * (countKeywordPages, searchKeywordPages): 25 and 25. The golden pins the
 * exact numbers.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { defineNormalizer, expectGolden, expectNormalizerStable } from './helpers/golden.ts';
import { EXTRA_READ_CASES, SQL_CASES, runCase, withPinnedSqlEnvironment, type SqlCase } from './helpers/postgres-engine-sql-cases.ts';
import type { RecordedStatement } from './helpers/fake-postgres-sql.ts';

const ENGINE_FILE = join(import.meta.dir, '..', 'src', 'core', 'postgres-engine.ts');
const HELPER = 'withScopedReadTransaction';

interface AstMember { directCallSites: number; calls: string[] }

function scanEngineAst(): Record<string, AstMember> {
  // test-reads-source-ok[structural]: EO4 pins master's per-method RLS scoping by AST call-site scan of the engine class
  const text = readFileSync(ENGINE_FILE, 'utf8');
  const sf = ts.createSourceFile(ENGINE_FILE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: Record<string, AstMember> = {};
  const visitClass = (cls: ts.ClassDeclaration) => {
    for (const m of cls.members) {
      if (!(ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m)) || !m.name || !m.body) continue;
      const name = m.name.getText(sf);
      const entry: AstMember = { directCallSites: 0, calls: [] };
      const walk = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
          const callee = n.expression.name.text;
          if (callee === HELPER) entry.directCallSites++;
          else if (!entry.calls.includes(callee)) entry.calls.push(callee);
        }
        ts.forEachChild(n, walk);
      };
      walk(m.body);
      entry.calls.sort();
      out[name] = entry;
    }
  };
  ts.forEachChild(sf, (n) => { if (ts.isClassDeclaration(n) && n.name?.text === 'PostgresEngine') visitClass(n); });
  return out;
}

/** `direct` | `via:<callee>` (first scoped callee, alphabetical, transitively) | `none`. */
function astScoping(members: Record<string, AstMember>): Record<string, string> {
  const memo: Record<string, string> = {};
  const resolve = (name: string, seen: Set<string>): string => {
    if (memo[name]) return memo[name];
    const m = members[name];
    if (!m || name === HELPER) return 'none';
    if (m.directCallSites > 0) return (memo[name] = 'direct');
    for (const callee of m.calls) {
      if (seen.has(callee)) continue;
      if (resolve(callee, new Set([...seen, callee])) !== 'none') return (memo[name] = `via:${callee}`);
    }
    return (memo[name] = 'none');
  };
  return Object.fromEntries(Object.keys(members).sort().map((n) => [n, resolve(n, new Set([n]))]));
}

interface RuntimeObservation {
  flagOn: 'scoped' | 'unscoped';
  /** The CSV bound to app.scopes (federated array > scalar > '*'). */
  flagOnScopes: string[];
  flagOnLanes: string[];
  flagOffLanes: string[];
  flagOffOpensTransaction: boolean;
}

function lanesOf(trace: Awaited<ReturnType<typeof runCase>>['trace']): string[] {
  return [...new Set(trace.filter((t): t is RecordedStatement => t.kind === 'query').map((t) => t.lane))].sort();
}

async function observe(cases: SqlCase[]): Promise<Record<string, RuntimeObservation>> {
  const out: Record<string, RuntimeObservation> = {};
  const on = await withPinnedSqlEnvironment('1', async () => Promise.all(cases.map(runCase)));
  const off = await withPinnedSqlEnvironment(undefined, async () => Promise.all(cases.map(runCase)));
  cases.forEach((c, i) => {
    const onTrace = on[i].trace;
    const sets = onTrace.filter((t): t is RecordedStatement => t.kind === 'query' && t.text.startsWith("SELECT set_config('app.scopes'"));
    const entered = sets.filter((_, k) => k % 2 === 0);
    if (on[i].error || off[i].error) throw new Error(`${c.method}#${c.variant}: ${on[i].error ?? off[i].error}`);
    out[`${c.method}#${c.variant}`] = {
      flagOn: sets.length > 0 ? 'scoped' : 'unscoped',
      flagOnScopes: entered.map((s) => String(s.params[0])),
      flagOnLanes: lanesOf(onTrace),
      flagOffLanes: lanesOf(off[i].trace),
      flagOffOpensTransaction: off[i].trace.some((t) => t.kind === 'event' && t.event === 'begin'),
    };
  });
  return out;
}

/**
 * Methods whose runtime scoping comes through a callee the `this.<m>()` AST
 * walk cannot see (a transaction clone `tx.<m>()` or a helper module taking
 * the engine). Each is scoped only on the listed variant(s).
 */
const SCOPED_THROUGH_NON_THIS_CALLEE: Record<string, string> = {
  putPage: 'expectedRevision variant calls tx.readPageSnapshot on the transaction clone',
  createVersion: 'page-state/versions.ts createPageVersion calls tx.readPageSnapshot',
  replaceDerivedLinks: 'derived-links.ts replaceDerivedLinks reads the origin via readPageSnapshot',
};

const INVENTORY_NORMALIZER = defineNormalizer<{ ast: Record<string, AstMember>; runtime: Record<string, RuntimeObservation> }>(
  'rls-scope-inventory-v1',
  ({ ast, runtime }) => {
    const scoping = astScoping(ast);
    const directMethods = Object.entries(ast).filter(([, m]) => m.directCallSites > 0).map(([n]) => n).sort();
    return {
      static: {
        helper: HELPER,
        callSites: Object.values(ast).reduce((a, m) => a + m.directCallSites, 0),
        directMethods: Object.fromEntries(directMethods.map((n) => [n, ast[n].directCallSites])),
        scoping,
      },
      runtime,
    };
  },
);

describe('EO4 RLS scope inventory (master)', () => {
  test('static and runtime scoping agree and match the pinned inventory', async () => {
    const cases = [...SQL_CASES, ...EXTRA_READ_CASES];
    const capture = await expectNormalizerStable(async () => ({ ast: scanEngineAst(), runtime: await observe(cases) }), INVENTORY_NORMALIZER);
    const scoping = astScoping(capture.ast);

    const callSites = Object.values(capture.ast).reduce((a, m) => a + m.directCallSites, 0);
    expect(callSites).toBe(25);
    expect(Object.values(capture.ast).filter((m) => m.directCallSites > 0).length).toBe(25);

    const byMethod = new Map<string, RuntimeObservation[]>();
    for (const [key, obs] of Object.entries(capture.runtime)) {
      const method = key.slice(0, key.indexOf('#'));
      byMethod.set(method, [...(byMethod.get(method) ?? []), obs]);
    }
    const mismatches: string[] = [];
    for (const [method, list] of byMethod) {
      const runtimeScoped = list.some((o) => o.flagOn === 'scoped');
      const astScoped = scoping[method] !== 'none';
      if (astScoped && !runtimeScoped) mismatches.push(`${method}: AST ${scoping[method]} but never scoped at runtime`);
      if (runtimeScoped && !astScoped && !(method in SCOPED_THROUGH_NON_THIS_CALLEE)) mismatches.push(`${method}: scoped at runtime, AST none`);
      if (scoping[method] === 'direct' && list.some((o) => o.flagOn === 'unscoped' && o.flagOnLanes.length > 0)) {
        mismatches.push(`${method}: a direct-scoped variant ran SQL without set_config`);
      }
    }
    expect(mismatches).toEqual([]);
    const stale = Object.keys(SCOPED_THROUGH_NON_THIS_CALLEE)
      .filter((m) => scoping[m] !== 'none' || !(byMethod.get(m) ?? []).some((o) => o.flagOn === 'scoped'));
    expect(stale).toEqual([]);

    // Flag off, a scoped read that did not already need a transaction on
    // master stays on the pool: no new pool hold (#1794).
    const newHolds = Object.entries(capture.runtime)
      .filter(([k, o]) => scoping[k.slice(0, k.indexOf('#'))] === 'direct' && o.flagOffOpensTransaction
        && !/^(searchKeyword|searchKeywordChunks|searchTitles|searchVector|listCorpusSample)#/.test(k))
      .map(([k]) => k);
    expect(newHolds).toEqual([]);

    expectGolden('rls-scope-inventory', capture, INVENTORY_NORMALIZER);
  });
});
