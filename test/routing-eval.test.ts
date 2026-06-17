/**
 * Tests for src/core/routing-eval.ts — Check 5 harness.
 *
 * Covers: normalization, trigger extraction, structural match, negative
 * cases, ambiguity detection + allow-list, fixture linter (D-CX-6),
 * fixture loader, and the end-to-end runner.
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  extractTriggerPhrases,
  indexResolverTriggers,
  lintRoutingFixtures,
  loadRoutingFixtures,
  normalizeText,
  runRoutingEval,
  structuralRouteMatch,
  type RoutingFixture,
} from '../src/core/routing-eval.ts';

const created: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'routing-eval-'));
  created.push(dir);
  return dir;
}

function makeResolver(
  rows: { trigger: string; skill: string; section?: string }[],
): string {
  const bySection = new Map<string, typeof rows>();
  for (const row of rows) {
    const sec = row.section ?? 'Brain operations';
    const list = bySection.get(sec) ?? [];
    list.push(row);
    bySection.set(sec, list);
  }
  const parts: string[] = ['# RESOLVER', ''];
  for (const [sec, list] of bySection) {
    parts.push(`## ${sec}`, '', '| Trigger | Skill |', '|---------|-------|');
    for (const r of list) {
      parts.push(`| ${r.trigger} | \`skills/${r.skill}/SKILL.md\` |`);
    }
    parts.push('');
  }
  return parts.join('\n');
}

afterEach(() => {
  while (created.length) {
    const d = created.pop();
    if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

describe('normalizeText', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeText("What's up?")).toBe('what s up');
  });
  it('collapses whitespace', () => {
    expect(normalizeText('  foo   bar\n\tbaz  ')).toBe('foo bar baz');
  });
  it('handles unicode punctuation', () => {
    expect(normalizeText('search — fast!')).toBe('search fast');
  });
  it('empty input → empty', () => {
    expect(normalizeText('')).toBe('');
    expect(normalizeText('   !!  ')).toBe('');
  });
});

describe('extractTriggerPhrases', () => {
  it('splits comma-separated quoted phrases', () => {
    const phrases = extractTriggerPhrases('"search for", "look up", "find me"');
    expect(phrases).toEqual(['search for', 'look up', 'find me']);
  });
  it('returns single unquoted cell as one phrase', () => {
    const phrases = extractTriggerPhrases('Creating/enriching a person page');
    expect(phrases).toEqual(['creating enriching a person page']);
  });
  it('filters phrases shorter than 3 chars', () => {
    // "x" too short; "hi" normalized to "hi" (2 chars, filtered)
    const phrases = extractTriggerPhrases('"x", "hi", "wave"');
    expect(phrases).toEqual(['wave']);
  });
  it('mixes quoted and non-quoted → quoted wins (split mode)', () => {
    // When ANY quoted phrase is present, we treat the cell as a list.
    const phrases = extractTriggerPhrases('things like "alpha" and "beta"');
    expect(phrases).toEqual(['alpha', 'beta']);
  });
});

describe('indexResolverTriggers', () => {
  it('indexes skills and normalizes their trigger phrases', () => {
    const resolver = makeResolver([
      { trigger: '"search for", "find me"', skill: 'query' },
      { trigger: 'Fix broken citations', skill: 'citation-fixer' },
    ]);
    const idx = indexResolverTriggers(resolver);
    expect(idx.skillPhrases.get('query')).toEqual(['search for', 'find me']);
    expect(idx.skillPhrases.get('citation-fixer')).toEqual(['fix broken citations']);
  });
  it('accumulates phrases when one skill has multiple resolver rows', () => {
    const resolver = makeResolver([
      { trigger: '"search", "lookup"', skill: 'query' },
      { trigger: '"graph query"', skill: 'query' },
    ]);
    const idx = indexResolverTriggers(resolver);
    expect(idx.skillPhrases.get('query')).toEqual(['search', 'lookup', 'graph query']);
  });
  it('skips GStack entries (external references)', () => {
    const resolver = [
      '# RESOLVER',
      '',
      '## External',
      '| Trigger | Skill |',
      '|---------|-------|',
      '| "plan review" | GStack: plan-ceo-review |',
      '| "do thing" | `skills/foo/SKILL.md` |',
      '',
    ].join('\n');
    const idx = indexResolverTriggers(resolver);
    expect(Array.from(idx.skillPhrases.keys())).toEqual(['foo']);
  });
});

describe('structuralRouteMatch', () => {
  const index = indexResolverTriggers(
    makeResolver([
      { trigger: '"search", "lookup", "find"', skill: 'query' },
      { trigger: '"fix citations", "broken sources"', skill: 'citation-fixer' },
      { trigger: '"every inbound message"', skill: 'signal-detector', section: 'Always-on' },
    ]),
  );

  it('matches a clean unambiguous intent', () => {
    const r = structuralRouteMatch('please lookup that person', index);
    expect(r.matched).toEqual(['query']);
    expect(r.ambiguous).toBe(false);
  });
  it('returns empty match for out-of-scope intent', () => {
    const r = structuralRouteMatch('deploy the app to prod', index);
    expect(r.matched).toEqual([]);
    expect(r.ambiguous).toBe(false);
  });
  it('flags ambiguity when two specific skills match', () => {
    const r = structuralRouteMatch('find broken sources in notes', index);
    expect(r.matched).toContain('query'); // "find"
    expect(r.matched).toContain('citation-fixer'); // "broken sources"
    expect(r.ambiguous).toBe(true);
  });
  it('does NOT flag ambiguity when always-on skill co-fires', () => {
    // always-on skills are exempted from the ambiguity check.
    const r = structuralRouteMatch('every inbound message lookup', index);
    expect(r.matched).toContain('query');
    expect(r.matched).toContain('signal-detector');
    expect(r.ambiguous).toBe(false);
  });
});

describe('lintRoutingFixtures (D-CX-6)', () => {
  const resolver = makeResolver([
    { trigger: '"find me", "search for"', skill: 'query' },
    { trigger: 'Fix broken citations', skill: 'citation-fixer' },
  ]);
  const index = indexResolverTriggers(resolver);

  it('rejects fixture whose intent is verbatim-equal to a trigger', () => {
    // Intent equals the trigger exactly (after normalization): pure
    // tautology. These are the copy-paste fixtures D-CX-6 targets.
    const fixtures: RoutingFixture[] = [
      { intent: 'find me', expected_skill: 'query' },
    ];
    const issues = lintRoutingFixtures(fixtures, index);
    expect(issues.length).toBe(1);
    expect(issues[0].reason).toBe('intent_copies_trigger');
  });
  it('accepts a natural-sentence fixture embedding trigger words', () => {
    // Intent embeds the trigger in a natural sentence — this is exactly
    // what Layer A's substring match is supposed to detect, so the
    // linter must NOT flag it.
    const fixtures: RoutingFixture[] = [
      { intent: 'please find me that paper', expected_skill: 'query' },
    ];
    const issues = lintRoutingFixtures(fixtures, index);
    expect(issues).toEqual([]);
  });
  it('accepts a fully-paraphrased fixture (no trigger words at all)', () => {
    const fixtures: RoutingFixture[] = [
      { intent: 'pull up what we know about Paul', expected_skill: 'query' },
    ];
    const issues = lintRoutingFixtures(fixtures, index);
    expect(issues).toEqual([]);
  });
  it('flags unknown expected_skill (typo / dead reference)', () => {
    const fixtures: RoutingFixture[] = [
      { intent: 'something', expected_skill: 'not-a-skill' },
    ];
    const issues = lintRoutingFixtures(fixtures, index);
    expect(issues.length).toBe(1);
    expect(issues[0].reason).toBe('unknown_expected_skill');
  });
  it('skips verbatim check for negative cases (expected_skill=null)', () => {
    const fixtures: RoutingFixture[] = [
      { intent: 'find broken citations', expected_skill: null },
    ];
    const issues = lintRoutingFixtures(fixtures, index);
    expect(issues).toEqual([]);
  });
  it('flags invalid shape (missing intent, wrong type)', () => {
    const fixtures: RoutingFixture[] = [
      { intent: '', expected_skill: 'query' },
      { intent: 'ok', expected_skill: 42 as unknown as string },
    ];
    const issues = lintRoutingFixtures(fixtures, index);
    expect(issues.length).toBe(2);
    expect(issues[0].reason).toBe('invalid_shape');
    expect(issues[1].reason).toBe('invalid_shape');
  });
});

describe('loadRoutingFixtures', () => {
  function seedFixture(skillsDir: string, name: string, lines: string[]): void {
    const dir = join(skillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n`);
    writeFileSync(join(dir, 'routing-eval.jsonl'), lines.join('\n'));
  }

  it('walks skills/*/routing-eval.jsonl and parses JSON-per-line', () => {
    const dir = scratch();
    seedFixture(dir, 'query', [
      '{"intent":"lookup paul","expected_skill":"query"}',
      '{"intent":"find that doc","expected_skill":"query"}',
    ]);
    seedFixture(dir, 'other', [
      '{"intent":"clean citations","expected_skill":"other"}',
    ]);
    const r = loadRoutingFixtures(dir);
    expect(r.fixtures.length).toBe(3);
    expect(r.malformed).toEqual([]);
    expect(r.fixtures.every(f => f.source !== undefined)).toBe(true);
  });
  it('skips comments and blank lines', () => {
    const dir = scratch();
    seedFixture(dir, 'query', [
      '// comment',
      '',
      '# also comment',
      '{"intent":"lookup","expected_skill":"query"}',
    ]);
    const r = loadRoutingFixtures(dir);
    expect(r.fixtures.length).toBe(1);
  });
  it('collects malformed lines separately without crashing', () => {
    const dir = scratch();
    seedFixture(dir, 'query', [
      '{"intent":"ok","expected_skill":"query"}',
      '{ bad json',
      '{"intent":"also ok","expected_skill":"query"}',
    ]);
    const r = loadRoutingFixtures(dir);
    expect(r.fixtures.length).toBe(2);
    expect(r.malformed.length).toBe(1);
    expect(r.malformed[0].line).toBe(2);
  });
  it('handles missing skills dir cleanly', () => {
    const r = loadRoutingFixtures('/tmp/never-exists-routing-eval-XYZ');
    expect(r.fixtures).toEqual([]);
    expect(r.malformed).toEqual([]);
  });
  it('skips underscore and dot dirs', () => {
    const dir = scratch();
    seedFixture(dir, '_conventions', [
      '{"intent":"x","expected_skill":"y"}',
    ]);
    seedFixture(dir, '.hidden', [
      '{"intent":"x","expected_skill":"y"}',
    ]);
    const r = loadRoutingFixtures(dir);
    expect(r.fixtures).toEqual([]);
  });
});

describe('runRoutingEval', () => {
  const resolver = makeResolver([
    { trigger: '"find me", "search for", "look up"', skill: 'query' },
    { trigger: '"broken citations", "fix citations"', skill: 'citation-fixer' },
    { trigger: '"every inbound message"', skill: 'signal-detector', section: 'Always-on' },
  ]);

  it('scores a passing fixture', () => {
    const fixtures: RoutingFixture[] = [
      { intent: 'please look up that person', expected_skill: 'query' },
    ];
    const r = runRoutingEval(resolver, fixtures);
    expect(r.passed).toBe(1);
    expect(r.top1Accuracy).toBe(1);
    expect(r.details[0].outcome).toBe('pass');
  });
  it('detects a missed fixture (no match)', () => {
    const fixtures: RoutingFixture[] = [
      { intent: 'deploy to prod', expected_skill: 'query' },
    ];
    const r = runRoutingEval(resolver, fixtures);
    expect(r.missed).toBe(1);
    expect(r.details[0].outcome).toBe('missed');
  });
  it('detects ambiguity when unexpected skills also match', () => {
    const fixtures: RoutingFixture[] = [
      { intent: 'search for broken citations', expected_skill: 'query' },
    ];
    const r = runRoutingEval(resolver, fixtures);
    expect(r.ambiguous).toBe(1);
    expect(r.details[0].outcome).toBe('ambiguous');
    expect(r.details[0].note).toContain('citation-fixer');
  });
  it('honors ambiguous_with allow-list', () => {
    const fixtures: RoutingFixture[] = [
      {
        intent: 'search for broken citations',
        expected_skill: 'query',
        ambiguous_with: ['citation-fixer'],
      },
    ];
    const r = runRoutingEval(resolver, fixtures);
    expect(r.passed).toBe(1);
    expect(r.ambiguous).toBe(0);
  });
  it('passes when only always-on skills co-fire', () => {
    const fixtures: RoutingFixture[] = [
      { intent: 'every inbound message look up', expected_skill: 'query' },
    ];
    const r = runRoutingEval(resolver, fixtures);
    expect(r.passed).toBe(1);
  });
  it('passes a negative case when nothing matches', () => {
    const fixtures: RoutingFixture[] = [
      { intent: 'deploy the app tonight', expected_skill: null },
    ];
    const r = runRoutingEval(resolver, fixtures);
    expect(r.passed).toBe(1);
  });
  it('fails a negative case when something matches (false positive)', () => {
    const fixtures: RoutingFixture[] = [
      { intent: 'please look up this fact', expected_skill: null },
    ];
    const r = runRoutingEval(resolver, fixtures);
    expect(r.falsePositives).toBe(1);
    expect(r.details[0].outcome).toBe('false_positive');
  });
  it('empty fixture set → top1Accuracy = 1 (vacuous pass)', () => {
    const r = runRoutingEval(resolver, []);
    expect(r.top1Accuracy).toBe(1);
    expect(r.totalCases).toBe(0);
  });
  it('mixed case report totals add up', () => {
    const fixtures: RoutingFixture[] = [
      { intent: 'pull up paul graham', expected_skill: 'query' }, // pass
      { intent: 'deploy prod', expected_skill: 'query' }, // miss
      { intent: 'fix busted sources', expected_skill: null }, // false pos
    ];
    const r = runRoutingEval(resolver, fixtures);
    expect(r.totalCases).toBe(3);
    expect(r.passed + r.missed + r.ambiguous + r.falsePositives).toBe(3);
  });
});
