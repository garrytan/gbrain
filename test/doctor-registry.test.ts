/**
 * Refactor wave 1 (W4 doctor, EO11 / DX O5): the doctor check registry
 * contract.
 *
 * - Every entry's `name` and every name in its `emits[]` is categorized by
 *   src/core/doctor-categories.ts, the single category authority. An
 *   uncategorized entry fails with FAIL / Why / Fix / See text.
 * - `emits[]` is exactly what the entry's `run` can push (AST walk from
 *   test/helpers/doctor-registry-ast.ts), so the category check cannot be
 *   dodged by an incomplete list.
 * - The runtime registry matches the statically walked one, and only the two
 *   gate entries return STOP_DOCTOR, placed where master's buildChecks
 *   returned early (the W0 golden's `early_returns_after`).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import type { DoctorEntry } from '../src/commands/doctor/context.ts';
import {
  BRAIN_CHECK_NAMES,
  META_CHECK_NAMES,
  OPS_CHECK_NAMES,
  SKILL_CHECK_NAMES,
} from '../src/core/doctor-categories.ts';
import { extractDoctorRegistryEntries } from './helpers/doctor-registry-ast.ts';
import { GOLDENS_DIR } from './helpers/golden.ts';

const CATEGORIZED = new Set([...BRAIN_CHECK_NAMES, ...SKILL_CHECK_NAMES, ...OPS_CHECK_NAMES, ...META_CHECK_NAMES]);

/** One FAIL/Why/Fix/See block per uncategorized name, empty when every entry is categorized. */
function uncategorizedFailures(entries: ReadonlyArray<Pick<DoctorEntry, 'name' | 'emits'> & { file?: string }>): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const where = e.file ? `${e.file} ` : '';
    for (const [field, name] of [['name', e.name] as const, ...e.emits.map((n) => ['emits', n] as const)]) {
      if (CATEGORIZED.has(name)) continue;
      out.push(
        [
          `FAIL: ${where}doctor registry entry '${e.name}' ${field} '${name}' is not categorized`,
          'Why:  src/core/doctor-categories.ts is the single category authority; an uncategorized check falls through to meta and skews category_scores.',
          `Fix:  add '${name}' to exactly one of BRAIN_CHECK_NAMES / SKILL_CHECK_NAMES / OPS_CHECK_NAMES / META_CHECK_NAMES in src/core/doctor-categories.ts`,
          'See:  docs/TESTING.md#doctor-check-registry',
        ].join('\n'),
      );
    }
  }
  return out;
}

const STATIC = extractDoctorRegistryEntries();

describe('doctor check registry contract', () => {
  test('every entry name and emitted check is categorized in doctor-categories.ts', () => {
    const failures = uncategorizedFailures(STATIC);
    if (failures.length > 0) throw new Error(failures.join('\n\n'));
    expect(failures).toEqual([]);
  });

  test('an uncategorized entry fails with FAIL / Why / Fix / See text (bad fixture)', () => {
    const bad = [{ name: 'resolver_health', emits: ['resolver_health', 'not_a_check_example'], file: 'src/commands/doctor/checks/fixture.ts' }];
    const failures = uncategorizedFailures(bad);
    expect(failures).toHaveLength(1);
    const [msg] = failures;
    expect(msg).toStartWith("FAIL: src/commands/doctor/checks/fixture.ts doctor registry entry 'resolver_health' emits 'not_a_check_example'");
    expect(msg).toContain('\nWhy:  ');
    expect(msg).toContain("\nFix:  add 'not_a_check_example' to exactly one of");
    expect(msg).toContain('src/core/doctor-categories.ts');
    expect(msg).toContain('\nSee:  docs/TESTING.md#doctor-check-registry');
    expect(uncategorizedFailures([{ name: 'bad_entry_example', emits: [] }])[0]).toContain("name 'bad_entry_example' is not categorized");
    expect(uncategorizedFailures([{ name: 'rls', emits: ['rls'] }])).toEqual([]);
  });

  test("emits[] lists exactly the checks each entry's run can push, and name is one of them", () => {
    for (const e of STATIC) {
      if (JSON.stringify(e.emits) !== JSON.stringify(e.names)) {
        console.error(
          `FAIL: entry ${e.entry} declares emits ${JSON.stringify(e.emits)} but its run pushes ${JSON.stringify(e.names)}\nWhy: emits[] is checked against an AST walk of run, which only sees checks.push({ name: '<literal>', ... }) inside run itself.\nFix: build const checks: Check[] = [] in run and call checks.push({ name: '<literal>', ... }) directly (no helper, no returned array literal), or correct emits.\nSee: test/helpers/doctor-registry-ast.ts, CONTRIBUTING.md#where-does-my-change-go`,
        );
      }
      expect({ entry: e.entry, emits: e.emits }).toEqual({ entry: e.entry, emits: e.names });
      if (e.names.length > 0) expect({ entry: e.entry, nameEmitted: e.names.includes(e.name) }).toEqual({ entry: e.entry, nameEmitted: true });
    }
  });

  test('the runtime registry is the statically walked registry, in order', () => {
    expect(DOCTOR_CHECK_REGISTRY.map((e) => ({ name: e.name, emits: [...e.emits] }))).toEqual(
      STATIC.map((e) => ({ name: e.name, emits: e.emits })),
    );
  });

  test("only the two gates stop, right where master's buildChecks returned early", () => {
    const golden = JSON.parse(readFileSync(join(GOLDENS_DIR, 'doctor', 'registry-build-checks.json'), 'utf-8')) as {
      golden: { early_returns_after: string[] };
    };
    const stops = STATIC.map((e, i) => ({ e, i })).filter(({ e }) => e.stops);
    expect(stops.map(({ e }) => e.entry)).toEqual(['dbChecksGateEntry', 'connectionGateEntry']);
    for (const { e } of stops) expect({ entry: e.entry, emits: e.emits }).toEqual({ entry: e.entry, emits: [] });
    const lastBefore = stops.map(({ i }) => STATIC.slice(0, i).flatMap((e) => e.names).at(-1));
    expect(lastBefore).toEqual(golden.golden.early_returns_after);
  });
});
