/**
 * #5575 ENG-14 drift tests: every read-scope operation declares its trust
 * handling (filtered | labeled | text_free), every `filtered` op takes the
 * `min_trust` param, the dispatcher backstop refuses an unfiltered read for a
 * floored token, and every registered proactive surface calls
 * `proactiveEligibility` with its own id (no unregistered ids anywhere).
 * Fails when an op or surface is added without a declaration.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { operations } from '../src/core/operations.ts';
import { enforceReadTrustFloor, OP_READ_TRUST, PROACTIVE_SURFACES, readTrustHandling } from '../src/core/eligibility/registry.ts';
import { OperationError } from '../src/core/ops/contract.ts';

const readOps = operations.filter(o => (o.scope ?? 'read') === 'read');

describe('read trust registry (ENG-14)', () => {
  test('every read-scope operation is declared, and every declaration names a read-scope operation', () => {
    expect(readOps.filter(o => !(o.name in OP_READ_TRUST)).map(o => o.name)).toEqual([]);
    const names = new Set(readOps.map(o => o.name));
    expect(Object.keys(OP_READ_TRUST).filter(n => !names.has(n))).toEqual([]);
  });

  test('every filtered op takes min_trust; ops that take min_trust are filtered', () => {
    for (const op of readOps) {
      const filtered = readTrustHandling(op) === 'filtered';
      expect({ op: op.name, min_trust: 'min_trust' in op.params }).toEqual({ op: op.name, min_trust: filtered });
    }
  });

  test('the retrieval and memory read surfaces are filtered', () => {
    for (const name of ['search', 'query', 'get_page', 'fetch', 'recall', 'context_pack', 'delta', 'takes_list', 'takes_search', 'get_timeline', 'volunteer_context', 'assemble_evidence']) {
      expect({ name, handling: OP_READ_TRUST[name] }).toEqual({ name, handling: 'filtered' });
    }
  });

  test('an unlisted read op resolves to the strictest handling', () => {
    expect(readTrustHandling({ name: 'some_future_op' })).toBe('labeled');
  });
});

describe('dispatcher floor backstop (CEO-18)', () => {
  const op = (name: string) => operations.find(o => o.name === name)!;
  test('a floored connection is refused a labeled read and allowed filtered, text-free and write ops', () => {
    const floored = { minTrust: 'operator_curated' as const };
    expect(() => enforceReadTrustFloor(floored, op('list_pages'))).toThrow(OperationError);
    try { enforceReadTrustFloor(floored, op('list_pages')); } catch (e) { expect((e as OperationError).code).toBe('permission_denied'); }
    expect(() => enforceReadTrustFloor(floored, op('search'))).not.toThrow();
    expect(() => enforceReadTrustFloor(floored, op('whoami'))).not.toThrow();
    expect(() => enforceReadTrustFloor(floored, op('put_page'))).not.toThrow();
  });
  test('a connection without a floor reaches every read op', () => {
    for (const o of readOps) expect(() => enforceReadTrustFloor({}, o)).not.toThrow();
    expect(() => enforceReadTrustFloor(undefined, op('list_pages'))).not.toThrow();
  });
});

describe('proactive surface registry (CEO-20)', () => {
  const root = join(import.meta.dir, '..');
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  test('each registered surface module calls proactiveEligibility with its id', () => {
    for (const [id, file] of Object.entries(PROACTIVE_SURFACES)) {
      const text = readFileSync(join(root, file), 'utf8');
      expect({ id, file, calls: new RegExp(`proactiveEligibility\\([^)]*'${id.replace('.', '\\.')}'`).test(text) }).toEqual({ id, file, calls: true });
    }
  });

  test('no source calls proactiveEligibility with an unregistered surface id', () => {
    const ids = new Set(Object.keys(PROACTIVE_SURFACES));
    const unknown: string[] = [];
    for (const file of walk(join(root, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/proactiveEligibility\([^)]*?'([a-z_.]+)'/g)) if (!ids.has(m[1])) unknown.push(`${file}: ${m[1]}`);
    }
    expect(unknown).toEqual([]);
  });
});
