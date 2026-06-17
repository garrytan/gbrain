/**
 * test/regression-v0_16_4.test.ts — F-ENG-8.
 *
 * Guards against v0.17 regressions: a clean fixture that passed cleanly
 * on v0.16.4 check-resolvable must still pass cleanly on v0.17 — same
 * errors[] and warnings[] shape, no new surprise findings.
 *
 * The fixture matches the canonical RESOLVER.md + manifest.json +
 * skills/ shape that v0.16.4 test suites used.
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { checkResolvable } from '../src/core/check-resolvable.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const d = created.pop();
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

function makeCleanFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'v0_16_4-regression-'));
  created.push(root);
  const skillsDir = join(root, 'skills');
  mkdirSync(skillsDir, { recursive: true });

  // Two skills, both in manifest, both reachable via RESOLVER.md.
  const manifest = {
    name: 'test',
    version: '0.16.4-fixture',
    skills: [
      { name: 'query', path: 'query/SKILL.md' },
      { name: 'brain-ops', path: 'brain-ops/SKILL.md' },
    ],
  };
  writeFileSync(join(skillsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  mkdirSync(join(skillsDir, 'query'), { recursive: true });
  writeFileSync(
    join(skillsDir, 'query', 'SKILL.md'),
    '---\nname: query\ndescription: lookup brain pages.\ntriggers:\n  - "look up"\n---\n\n# query\n',
  );

  mkdirSync(join(skillsDir, 'brain-ops'), { recursive: true });
  writeFileSync(
    join(skillsDir, 'brain-ops', 'SKILL.md'),
    '---\nname: brain-ops\ndescription: core read/write cycle.\ntriggers:\n  - any brain read/write\n---\n\n# brain-ops\n',
  );

  writeFileSync(
    join(skillsDir, 'RESOLVER.md'),
    [
      '# RESOLVER',
      '',
      '## Brain operations',
      '',
      '| Trigger | Skill |',
      '|---------|-------|',
      '| "look up" | `skills/query/SKILL.md` |',
      '| any brain read/write | `skills/brain-ops/SKILL.md` |',
      '',
    ].join('\n'),
  );

  return skillsDir;
}

describe('v0.16.4 regression guard (F-ENG-8)', () => {
  it('clean fixture passes all checks on v0.17 (no errors, no surprise warnings)', () => {
    const skillsDir = makeCleanFixture();
    const report = checkResolvable(skillsDir);
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);

    // v0.17 adds routing_*/filing_*/skillify_stub_* warning types.
    // A clean v0.16.4-style fixture has NO routing-eval fixtures,
    // NO writes_pages declarations, NO SKILLIFY_STUB markers — so
    // none of the new warning types should fire.
    const newTypeWarnings = report.warnings.filter(w =>
      w.type.startsWith('routing_') ||
      w.type.startsWith('filing_') ||
      w.type === 'skillify_stub_unreplaced',
    );
    expect(newTypeWarnings).toEqual([]);

    // Summary shape unchanged.
    expect(report.summary.total_skills).toBe(2);
    expect(report.summary.reachable).toBe(2);
    expect(report.summary.unreachable).toBe(0);
  });

  it('JSON envelope shape is stable (keys unchanged from v0.16.4)', () => {
    const skillsDir = makeCleanFixture();
    const report = checkResolvable(skillsDir);
    // Top-level keys the --json envelope promises.
    expect(Object.keys(report).sort()).toEqual([
      'errors',
      'issues',
      'ok',
      'summary',
      'warnings',
    ]);
    // Summary keys — new `routing_*` totals are NOT added to summary
    // (kept in the issues list only).
    expect(Object.keys(report.summary).sort()).toEqual([
      'gaps',
      'overlaps',
      'reachable',
      'total_skills',
      'unreachable',
    ]);
  });

  it('deprecated issues[] union equals errors[] + warnings[]', () => {
    const skillsDir = makeCleanFixture();
    const report = checkResolvable(skillsDir);
    expect(report.issues.length).toBe(report.errors.length + report.warnings.length);
  });
});
