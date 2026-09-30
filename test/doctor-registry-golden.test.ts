/**
 * Refactor wave 1 (W0, EO11): doctor check registry golden.
 *
 * Pins the ORDERED list of check names `buildChecks` (local doctor) and
 * `doctorReportRemote` (remote MCP doctor) can emit, with each name's
 * category from src/core/doctor-categories.ts, independent of which checks
 * fire at runtime. Extracted from the AST by test/helpers/doctor-registry-ast.ts
 * (see its header for how push arguments are resolved). The W4 doctor registry
 * runner must reproduce this order, and stop where `early_returns_after`
 * says master returns early.
 *
 * Normalizer `doctor-registry-v1`: identity over plain data (names and
 * categories are static source facts; no timestamps, paths or ordering from
 * Map/Set iteration). Stability is proven in-test by extracting twice.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { GOLDENS_DIR, defineNormalizer, expectGolden, expectNormalizerStable } from './helpers/golden.ts';
import { extractDoctorRegistry, type DoctorRegistry } from './helpers/doctor-registry-ast.ts';
import {
  BRAIN_CHECK_NAMES,
  META_CHECK_NAMES,
  OPS_CHECK_NAMES,
  SKILL_CHECK_NAMES,
} from '../src/core/doctor-categories.ts';

function categoryOf(name: string): string {
  if (BRAIN_CHECK_NAMES.has(name)) return 'brain';
  if (SKILL_CHECK_NAMES.has(name)) return 'skill';
  if (OPS_CHECK_NAMES.has(name)) return 'ops';
  if (META_CHECK_NAMES.has(name)) return 'meta';
  return 'uncategorized';
}

const REGISTRY = defineNormalizer<DoctorRegistry>('doctor-registry-v1', (r) => ({
  checks: r.names.map((name) => ({ name, category: categoryOf(name) })),
  early_returns_after: r.early_returns_after,
}));

const ROOTS = [
  { golden: 'doctor/registry-build-checks', file: 'src/commands/doctor.ts', fn: 'buildChecks' },
  { golden: 'doctor/registry-report-remote', file: 'src/commands/doctor/report-remote.ts', fn: 'doctorReportRemote' },
] as const;

describe('doctor check registry golden (AST, master order)', () => {
  for (const root of ROOTS) {
    test(`${root.fn}: ordered names + categories match the golden`, async () => {
      const registry = await expectNormalizerStable(() => extractDoctorRegistry(root.file, root.fn), REGISTRY);
      expect(registry.unresolved).toEqual([]);
      expect(registry.names.length).toBeGreaterThan(0);
      expect(registry.names.filter((n) => categoryOf(n) === 'uncategorized')).toEqual([]);
      expectGolden(root.golden, registry, REGISTRY);
    });
  }

  test('buildChecks: connection precedes every DB check and both early returns are pinned', () => {
    const { names, early_returns_after } = extractDoctorRegistry();
    // Null-engine path returns after the dead-DB lane (pgbouncer_prepare,
    // db_repair_recurrence); connection failure returns right after `connection`.
    expect(early_returns_after).toEqual(['db_repair_recurrence', 'connection']);
    expect(names.indexOf('connection')).toBeLessThan(names.indexOf('pgvector'));
    expect(names.at(-1)).toBe('dangling_aliases');
  });

  test('every runtime doctor golden emits registry names in registry order (extractor recall)', () => {
    const { names, sequence } = extractDoctorRegistry();
    const dir = join(GOLDENS_DIR, 'doctor');
    const files = readdirSync(dir).filter((f) => /^(json-pglite|json-postgres|early-stop)-.*\.json$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const golden = (JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { golden: unknown }).golden as
        | { report?: { checks?: Array<{ name: string }> } }
        | Array<{ name: string }>;
      const emitted = (Array.isArray(golden) ? golden : golden.report?.checks ?? []).map((c) => c.name);
      expect({ f, missing: emitted.filter((n) => !names.includes(n)) }).toEqual({ f, missing: [] });
      let cursor = 0;
      for (const n of emitted) {
        const at = sequence.indexOf(n, cursor);
        expect({ f, name: n, inOrder: at >= 0 }).toEqual({ f, name: n, inOrder: true });
        cursor = at + 1;
      }
    }
  });
});
