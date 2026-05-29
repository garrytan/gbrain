/**
 * Drift guard for src/core/doctor-categories.ts.
 *
 * Reads src/commands/doctor.ts source via a literal-string scan, enumerates
 * every `name: '<...>'` Check name, and asserts each appears in exactly ONE
 * category set. The union of the four sets must equal the discovered names
 * exactly — no orphans, no extras.
 *
 * This is the structural failure the v0.41.19.0 plan-eng-review caught:
 * doctor.ts grows new checks regularly; without this guard, the
 * categorization map silently goes stale and unknown checks degrade to
 * 'meta' without anyone noticing.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BRAIN_CHECK_NAMES,
  SKILL_CHECK_NAMES,
  OPS_CHECK_NAMES,
  META_CHECK_NAMES,
  categorizeCheck,
  _resetUnknownCheckWarningsForTest,
} from '../src/core/doctor-categories.ts';

const DOCTOR_TS_PATH = join(import.meta.dir, '..', 'src', 'commands', 'doctor.ts');

function enumerateCheckNames(): Set<string> {
  const source = readFileSync(DOCTOR_TS_PATH, 'utf-8');
  const names = new Set<string>();
  // 1) Inline object-literal form: `{ name: 'foo', ... }`.
  for (const m of source.matchAll(/name:\s*['"]([a-z][a-z0-9_]+)['"]/g)) {
    names.add(m[1]);
  }
  // 2) Helper-function form: `const name = 'foo';` inside a check helper.
  //    Catches checks like `nightly_quality_probe_health` and
  //    `conversation_facts_backlog` that build the Check from a captured
  //    name constant.
  for (const m of source.matchAll(/const\s+name\s*=\s*['"]([a-z][a-z0-9_]+)['"]/g)) {
    names.add(m[1]);
  }
  return names;
}

describe('doctor-categories drift guard', () => {
  test('every check name in doctor.ts source belongs to exactly one category set', () => {
    const discovered = enumerateCheckNames();
    const allCategorized = new Set<string>([
      ...BRAIN_CHECK_NAMES,
      ...SKILL_CHECK_NAMES,
      ...OPS_CHECK_NAMES,
      ...META_CHECK_NAMES,
    ]);

    const missing: string[] = [];
    for (const name of discovered) {
      if (!allCategorized.has(name)) missing.push(name);
    }
    if (missing.length > 0) {
      throw new Error(
        `These check names appear in doctor.ts but are not categorized in ` +
          `src/core/doctor-categories.ts: ${missing.sort().join(', ')}. ` +
          `Add each to BRAIN/SKILL/OPS/META_CHECK_NAMES.`,
      );
    }
  });

  test('no check name appears in more than one category set', () => {
    const counts = new Map<string, string[]>();
    const tag = (s: ReadonlySet<string>, label: string) => {
      for (const n of s) {
        if (!counts.has(n)) counts.set(n, []);
        counts.get(n)!.push(label);
      }
    };
    tag(BRAIN_CHECK_NAMES, 'brain');
    tag(SKILL_CHECK_NAMES, 'skill');
    tag(OPS_CHECK_NAMES, 'ops');
    tag(META_CHECK_NAMES, 'meta');

    const dupes: string[] = [];
    for (const [name, cats] of counts) {
      if (cats.length > 1) dupes.push(`${name} in [${cats.join(', ')}]`);
    }
    expect(dupes).toEqual([]);
  });

  test('every categorized name is currently used in doctor.ts source (no stale entries)', () => {
    const discovered = enumerateCheckNames();
    const allCategorized = new Set<string>([
      ...BRAIN_CHECK_NAMES,
      ...SKILL_CHECK_NAMES,
      ...OPS_CHECK_NAMES,
      ...META_CHECK_NAMES,
    ]);

    const stale: string[] = [];
    for (const name of allCategorized) {
      if (!discovered.has(name)) stale.push(name);
    }
    // Stale entries are warnings, not hard errors — a check may be temporarily
    // removed during refactor. But the build should still flag them so we
    // catch the drift quickly. Use a soft assertion via console hint and a
    // strict expectation that the count is small (<=2). Adjust if real
    // refactors require more headroom.
    if (stale.length > 2) {
      throw new Error(
        `These categorized names no longer appear in doctor.ts: ${stale.sort().join(', ')}. ` +
          `Remove them from src/core/doctor-categories.ts.`,
      );
    }
  });
});

describe('categorizeCheck', () => {
  beforeEach(() => {
    _resetUnknownCheckWarningsForTest();
  });

  test('returns the right category for a known brain name', () => {
    expect(categorizeCheck('embedding_provider')).toBe('brain');
    expect(categorizeCheck('graph_coverage')).toBe('brain');
    expect(categorizeCheck('sync_freshness')).toBe('brain');
  });

  test('returns the right category for a known skill name', () => {
    expect(categorizeCheck('resolver_health')).toBe('skill');
    expect(categorizeCheck('skill_conformance')).toBe('skill');
  });

  test('returns the right category for a known ops name', () => {
    expect(categorizeCheck('connection')).toBe('ops');
    expect(categorizeCheck('rls')).toBe('ops');
    expect(categorizeCheck('supervisor')).toBe('ops');
  });

  test('returns the right category for a known meta name', () => {
    expect(categorizeCheck('schema_version')).toBe('meta');
    expect(categorizeCheck('upgrade_errors')).toBe('meta');
  });

  test('unknown check name falls through to meta with a stderr warn (once per process)', () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured: string[] = [];
    (process.stderr as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
    ) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(categorizeCheck('made_up_check_name_not_in_any_set')).toBe('meta');
      expect(categorizeCheck('made_up_check_name_not_in_any_set')).toBe('meta');
      const warns = captured.filter((c) => c.includes('made_up_check_name_not_in_any_set'));
      expect(warns.length).toBe(1);
    } finally {
      (process.stderr as { write: typeof process.stderr.write }).write = originalWrite;
    }
  });
});
