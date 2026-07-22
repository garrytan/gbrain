/**
 * Unit suite for the v0.36.x skill_brain_first analyzer (T9 from
 * /plan-eng-review).
 *
 * Drives the fixture corpus at `test/fixtures/brain-first-skills/*`.
 * Absorbs PR #1206's 10 inline-string cases (IRON-RULE regression
 * preservation: every behavior the PR pinned must still pass here).
 *
 * Coverage targets:
 *   - parseSkillFrontmatter: canonical / typo variants / array fields
 *   - analyzeSkillBrainFirst: all 6 BrainFirstReason values × edge cases
 *   - Position-relative gate body-only semantics (F6 regression)
 *   - Canonical callout regex shape variations (F7 regression)
 *   - FORMERLY_HARDCODED_EXEMPT membership preserved
 *   - buildBrainFirstSummaryLine output shape (doctor + skillify consume it)
 *   - Snapshot+diff audit logic (A2 contract: zero writes on no-transition runs)
 *
 * Hermetic: no DATABASE_URL, no network, no real audit dir. The audit
 * snapshot tests redirect `GBRAIN_AUDIT_DIR` to a tempdir.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { withEnv } from './helpers/with-env.ts';
import {
  parseSkillFrontmatter,
  formatBrainFirstTypoHint,
} from '../src/core/skill-frontmatter.ts';
import {
  analyzeSkillBrainFirst,
  buildBrainFirstSummaryLine,
  findFirstBrainRefOffset,
  findFirstExternalRefOffset,
  stripFrontmatter,
  CONVENTION_CALLOUT_RE,
  PHASE_HEADING_RE,
  EXTERNAL_LOOKUP_PATTERNS,
  FORMERLY_HARDCODED_EXEMPT,
} from '../src/core/skill-brain-first.ts';
import {
  diffAgainstSnapshot,
  loadSnapshot,
  writeSnapshotAtomically,
  computeBrainFirstAuditFilename,
  logBrainFirstEvent,
  readRecentBrainFirstEvents,
  appendAuditEventsForTransitions,
  _resetWarnedSetForTests,
} from '../src/core/audit-skill-brain-first.ts';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures', 'brain-first-skills');

function loadFixture(name: string): { content: string; skillName: string } {
  const skillMd = join(FIXTURE_DIR, name, 'SKILL.md');
  return { content: readFileSync(skillMd, 'utf-8'), skillName: name };
}

// ---------------------------------------------------------------------------
// parseSkillFrontmatter
// ---------------------------------------------------------------------------

describe('parseSkillFrontmatter', () => {
  test('returns null when no frontmatter fence is present', () => {
    expect(parseSkillFrontmatter('# Just a heading\nNo frontmatter here.')).toBeNull();
  });

  test('parses name, mutating, writes_pages, writes_to', () => {
    const content = [
      '---',
      'name: thing',
      'mutating: true',
      'writes_pages: true',
      'writes_to:',
      '  - people/',
      '  - companies/',
      '---',
      '',
      '# thing',
    ].join('\n');
    const fm = parseSkillFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(fm!.name).toBe('thing');
    expect(fm!.mutating).toBe(true);
    expect(fm!.writes_pages).toBe(true);
    expect(fm!.writes_to).toEqual(['people/', 'companies/']);
  });

  test('parses inline array forms for writes_to / tools / triggers', () => {
    const content = [
      '---',
      'name: x',
      'writes_to: [people/, companies/]',
      'tools: [search, query, put_page]',
      'triggers: [foo, bar]',
      '---',
    ].join('\n');
    const fm = parseSkillFrontmatter(content);
    expect(fm!.writes_to).toEqual(['people/', 'companies/']);
    expect(fm!.tools).toEqual(['search', 'query', 'put_page']);
    expect(fm!.triggers).toEqual(['foo', 'bar']);
  });

  test('canonical brain_first: exempt populates the typed field', () => {
    const content = '---\nname: x\nbrain_first: exempt\n---\n';
    const fm = parseSkillFrontmatter(content);
    expect(fm!.brain_first).toBe('exempt');
    expect(fm!.brain_first_typo).toBeUndefined();
  });

  test('kebab-case brain-first triggers noncanonical_key typo', () => {
    const content = '---\nname: x\nbrain-first: exempt\n---\n';
    const fm = parseSkillFrontmatter(content);
    expect(fm!.brain_first).toBeUndefined();
    expect(fm!.brain_first_typo).toBeDefined();
    expect(fm!.brain_first_typo!.reason).toBe('noncanonical_key');
    expect(fm!.brain_first_typo!.key).toBe('brain-first');
  });

  test('CamelCase BrainFirst triggers noncanonical_key typo', () => {
    const content = '---\nname: x\nBrainFirst: exempt\n---\n';
    const fm = parseSkillFrontmatter(content);
    expect(fm!.brain_first).toBeUndefined();
    expect(fm!.brain_first_typo!.reason).toBe('noncanonical_key');
  });

  test('quoted value triggers quoted_value typo', () => {
    const content = "---\nname: x\nbrain_first: 'exempt'\n---\n";
    const fm = parseSkillFrontmatter(content);
    expect(fm!.brain_first).toBeUndefined();
    expect(fm!.brain_first_typo!.reason).toBe('quoted_value');
  });

  test('capitalized value triggers capitalized_value typo', () => {
    const content = '---\nname: x\nbrain_first: Exempt\n---\n';
    const fm = parseSkillFrontmatter(content);
    expect(fm!.brain_first).toBeUndefined();
    expect(fm!.brain_first_typo!.reason).toBe('capitalized_value');
  });

  test('unknown value triggers unknown_value typo', () => {
    const content = '---\nname: x\nbrain_first: required\n---\n';
    const fm = parseSkillFrontmatter(content);
    expect(fm!.brain_first).toBeUndefined();
    expect(fm!.brain_first_typo!.reason).toBe('unknown_value');
  });

  test('formatBrainFirstTypoHint produces paste-ready strings for every reason', () => {
    expect(
      formatBrainFirstTypoHint({ key: 'brain-first', value: 'exempt', reason: 'noncanonical_key' }),
    ).toContain('snake_case');
    expect(
      formatBrainFirstTypoHint({ key: 'brain_first', value: "'exempt'", reason: 'quoted_value' }),
    ).toContain('drop the quotes');
    expect(
      formatBrainFirstTypoHint({ key: 'brain_first', value: 'Exempt', reason: 'capitalized_value' }),
    ).toContain('lowercase');
    expect(
      formatBrainFirstTypoHint({ key: 'brain_first', value: 'required', reason: 'unknown_value' }),
    ).toContain("only 'brain_first: exempt'");
    expect(formatBrainFirstTypoHint(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// stripFrontmatter + offset helpers
// ---------------------------------------------------------------------------

describe('stripFrontmatter', () => {
  test('removes leading YAML fence', () => {
    const content = '---\nname: x\n---\n# Body\nrest';
    expect(stripFrontmatter(content)).toBe('# Body\nrest');
  });

  test('leaves content unchanged when no fence is present', () => {
    expect(stripFrontmatter('# No fence')).toBe('# No fence');
  });

  test('CRITICAL F6 — frontmatter exclusion prevents tools: [web_search] false-positive', () => {
    const content = [
      '---',
      'name: x',
      'tools: [web_search]',
      '---',
      '',
      '# x',
      '',
      'Body says gbrain search comes first.',
      'Then perplexity for follow-up.',
    ].join('\n');
    const body = stripFrontmatter(content);
    // `web_search` appears ONLY in frontmatter — body has no external pattern
    // before the gbrain reference.
    expect(findFirstBrainRefOffset(body)).toBeGreaterThanOrEqual(0);
    // Body should NOT contain `web_search` (it was in the stripped frontmatter).
    expect(body.includes('web_search')).toBe(false);
  });
});

describe('offset helpers', () => {
  test('findFirstBrainRefOffset finds earliest gbrain ref', () => {
    const body = 'Some preamble. gbrain search and later gbrain query.';
    const o = findFirstBrainRefOffset(body);
    expect(o).toBe(body.indexOf('gbrain search'));
  });

  test('findFirstExternalRefOffset finds earliest external pattern', () => {
    const body = 'First call perplexity, then later web_search.';
    const o = findFirstExternalRefOffset(body);
    expect(o).toBe(body.indexOf('perplexity'));
  });

  test('returns -1 when no match', () => {
    expect(findFirstBrainRefOffset('no brain ref here')).toBe(-1);
    expect(findFirstExternalRefOffset('no external ref here')).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// CONVENTION_CALLOUT_RE (F7 — path-syntax-agnostic)
// ---------------------------------------------------------------------------

describe('CONVENTION_CALLOUT_RE', () => {
  test('matches plain-text path form (brain-ops shape)', () => {
    const line = '> **Convention:** See skills/conventions/brain-first.md for the 5-step lookup protocol.';
    expect(CONVENTION_CALLOUT_RE.test(line)).toBe(true);
  });

  test('matches relative plain-text form (perplexity-research shape)', () => {
    const line = '> **Convention:** see conventions/brain-first.md for the lookup chain.';
    expect(CONVENTION_CALLOUT_RE.test(line)).toBe(true);
  });

  test('matches markdown-link form (auto-fix output shape)', () => {
    const line = '> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) for the lookup chain.';
    expect(CONVENTION_CALLOUT_RE.test(line)).toBe(true);
  });

  test('does NOT match a non-blockquote mention of brain-first', () => {
    const line = 'In a paragraph: see conventions/brain-first.md for the chain.';
    expect(CONVENTION_CALLOUT_RE.test(line)).toBe(false);
  });

  test('does NOT match an unrelated Convention callout', () => {
    const line = '> **Convention:** see conventions/quality.md for citation format.';
    expect(CONVENTION_CALLOUT_RE.test(line)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PHASE_HEADING_RE
// ---------------------------------------------------------------------------

describe('PHASE_HEADING_RE', () => {
  test('matches ## Phase 1: Brain-First Lookup', () => {
    expect(PHASE_HEADING_RE.test('## Phase 1: Brain-First Lookup')).toBe(true);
  });

  test('matches ### Step 0: Brain Context', () => {
    expect(PHASE_HEADING_RE.test('### Step 0: Brain Context')).toBe(true);
  });

  test('does NOT match # Phase 1 (H1, not H2+)', () => {
    expect(PHASE_HEADING_RE.test('# Phase 1: Brain Lookup')).toBe(false);
  });

  test('does NOT match Phase 2 etc.', () => {
    expect(PHASE_HEADING_RE.test('## Phase 2: Synthesis')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EXTERNAL_LOOKUP_PATTERNS coverage matrix
// ---------------------------------------------------------------------------

describe('EXTERNAL_LOOKUP_PATTERNS', () => {
  test('all 8 patterns are present and named', () => {
    const names = EXTERNAL_LOOKUP_PATTERNS.map(p => p.name).sort();
    expect(names).toEqual([
      'captain_api',
      'crustdata',
      'exa',
      'firecrawl',
      'happenstance',
      'perplexity',
      'web_fetch',
      'web_search',
    ]);
  });

  test('captain_api regex handles all four shapes', () => {
    const re = EXTERNAL_LOOKUP_PATTERNS.find(p => p.name === 'captain_api')!.re;
    expect(re.test('use captain api')).toBe(true);
    expect(re.test('use captain_api')).toBe(true);
    expect(re.test('use captain-api')).toBe(true);
    expect(re.test('use captainapi')).toBe(true);
    expect(re.test('captain is not an api ref')).toBe(false);
  });

  test('exa requires a separator (avoids matching exam, exalt)', () => {
    const re = EXTERNAL_LOOKUP_PATTERNS.find(p => p.name === 'exa')!.re;
    expect(re.test('use exa.search')).toBe(true);
    expect(re.test('use exa_lookup')).toBe(true);
    expect(re.test('use exa-api')).toBe(true);
    expect(re.test('do not use exam')).toBe(false);
    expect(re.test('exalt the brain')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FORMERLY_HARDCODED_EXEMPT preservation
// ---------------------------------------------------------------------------

describe('FORMERLY_HARDCODED_EXEMPT', () => {
  test('preserves all 40+ entries from PR #1206 allowlist', () => {
    // Spot-check across the three categories from PR #1206.
    expect(FORMERLY_HARDCODED_EXEMPT.has('brain-ops')).toBe(true);
    expect(FORMERLY_HARDCODED_EXEMPT.has('gbrain')).toBe(true);
    expect(FORMERLY_HARDCODED_EXEMPT.has('exa')).toBe(true);
    expect(FORMERLY_HARDCODED_EXEMPT.has('perplexity-research')).toBe(false); // not in PR allowlist
    expect(FORMERLY_HARDCODED_EXEMPT.has('browser')).toBe(true);
    expect(FORMERLY_HARDCODED_EXEMPT.has('cron-scheduler')).toBe(true);
    expect(FORMERLY_HARDCODED_EXEMPT.has('ask-user')).toBe(true);
  });

  test('contains at least 40 entries (preserves PR #1206 intent)', () => {
    expect(FORMERLY_HARDCODED_EXEMPT.size).toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// analyzeSkillBrainFirst — fixture corpus drive (the IRON-RULE regression set)
// ---------------------------------------------------------------------------

describe('analyzeSkillBrainFirst (fixture corpus)', () => {
  test('compliant-callout → ok via compliant_callout reason', () => {
    const { content, skillName } = loadFixture('compliant-callout');
    const fm = parseSkillFrontmatter(content);
    const result = analyzeSkillBrainFirst(content, skillName, fm);
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('compliant_callout');
    expect(result.external_patterns_matched.length).toBeGreaterThan(0);
  });

  test('compliant-phase → ok via compliant_phase reason', () => {
    const { content, skillName } = loadFixture('compliant-phase');
    const fm = parseSkillFrontmatter(content);
    const result = analyzeSkillBrainFirst(content, skillName, fm);
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('compliant_phase');
  });

  test('compliant-position → ok via compliant_position reason', () => {
    const { content, skillName } = loadFixture('compliant-position');
    const fm = parseSkillFrontmatter(content);
    const result = analyzeSkillBrainFirst(content, skillName, fm);
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('compliant_position');
  });

  test('missing-brain-first → warn via missing_brain_first', () => {
    const { content, skillName } = loadFixture('missing-brain-first');
    const fm = parseSkillFrontmatter(content);
    const result = analyzeSkillBrainFirst(content, skillName, fm);
    expect(result.status).toBe('warn');
    expect(result.reason).toBe('missing_brain_first');
    expect(result.external_patterns_matched).toContain('web_search');
    expect(result.external_patterns_matched).toContain('perplexity');
  });

  test('exempt-frontmatter → ok via exempt_explicit', () => {
    const { content, skillName } = loadFixture('exempt-frontmatter');
    const fm = parseSkillFrontmatter(content);
    const result = analyzeSkillBrainFirst(content, skillName, fm);
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('exempt_explicit');
  });

  test('no-external → ok via exempt_no_external', () => {
    const { content, skillName } = loadFixture('no-external');
    const fm = parseSkillFrontmatter(content);
    const result = analyzeSkillBrainFirst(content, skillName, fm);
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('exempt_no_external');
    expect(result.external_patterns_matched).toEqual([]);
  });

  test('multi-pattern → warn with all 3 external patterns matched', () => {
    const { content, skillName } = loadFixture('multi-pattern');
    const fm = parseSkillFrontmatter(content);
    const result = analyzeSkillBrainFirst(content, skillName, fm);
    expect(result.status).toBe('warn');
    expect(result.reason).toBe('missing_brain_first');
    expect(result.external_patterns_matched).toContain('exa');
    expect(result.external_patterns_matched).toContain('perplexity');
    expect(result.external_patterns_matched).toContain('crustdata');
  });

  test('typo-frontmatter → warn with typo_hint surfaced', () => {
    const { content, skillName } = loadFixture('typo-frontmatter');
    const fm = parseSkillFrontmatter(content);
    const result = analyzeSkillBrainFirst(content, skillName, fm);
    expect(result.status).toBe('warn');
    expect(result.typo_hint).toBeDefined();
    expect(result.typo_hint).toContain('brain-first');
    expect(result.typo_hint).toContain('snake_case');
  });

  test('negation-prose → ok via compliant_position (brain ref appears first)', () => {
    const { content, skillName } = loadFixture('negation-prose');
    const fm = parseSkillFrontmatter(content);
    const result = analyzeSkillBrainFirst(content, skillName, fm);
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('compliant_position');
  });
});

// ---------------------------------------------------------------------------
// analyzeSkillBrainFirst — direct-input regression (PR #1206 absorption)
// ---------------------------------------------------------------------------

describe('analyzeSkillBrainFirst (PR #1206 regression preservation)', () => {
  test('PR test case: good skill with Step 0 brain context passes', () => {
    // Direct copy of PR #1206 `good-skill` test case shape.
    const content = `---\nname: good-skill\n---\n# Good Skill\n\n## Step 0: Brain Context\nSearch the brain first with \`gbrain search\` for relevant context.\n\n## Step 1: External Lookup\nUse web_search to find additional information.\n`;
    const result = analyzeSkillBrainFirst(content, 'good-skill', parseSkillFrontmatter(content));
    expect(result.status).toBe('ok');
  });

  test('PR test case: bad skill with web_search but no brain-first → warn', () => {
    const content = `---\nname: bad-skill\n---\n# Bad Skill\n\n## Step 1: Research\nUse web_search to find information about the entity.\nThen use Perplexity for deeper research.\n`;
    const result = analyzeSkillBrainFirst(content, 'bad-skill', parseSkillFrontmatter(content));
    expect(result.status).toBe('warn');
  });

  test('PR test case: skill with brain search reference is not flagged', () => {
    const content = `---\nname: bf\n---\n# Brain-First\n\nFirst, search the brain for existing context.\nThen use web_search for anything missing. Use gbrain search.\n`;
    const result = analyzeSkillBrainFirst(content, 'bf', parseSkillFrontmatter(content));
    expect(result.status).toBe('ok');
  });

  test('PR test case: skill without external lookups not flagged', () => {
    const content = `---\nname: internal\n---\n# Internal Skill\nThis skill only operates on local files. No external lookups.\n`;
    const result = analyzeSkillBrainFirst(content, 'internal', parseSkillFrontmatter(content));
    expect(result.status).toBe('ok');
    expect(result.reason).toBe('exempt_no_external');
  });
});

// ---------------------------------------------------------------------------
// buildBrainFirstSummaryLine
// ---------------------------------------------------------------------------

describe('buildBrainFirstSummaryLine', () => {
  test('ok results render with reason tag', () => {
    const line = buildBrainFirstSummaryLine({
      skill: 'x',
      status: 'ok',
      reason: 'compliant_callout',
      external_patterns_matched: [],
      formerly_hardcoded_exempt: false,
    });
    expect(line).toBe('x: ok (compliant_callout)');
  });

  test('warn results include external patterns + hint', () => {
    const line = buildBrainFirstSummaryLine({
      skill: 'bad',
      status: 'warn',
      reason: 'missing_brain_first',
      external_patterns_matched: ['perplexity', 'exa'],
      formerly_hardcoded_exempt: false,
    });
    expect(line).toContain('bad');
    expect(line).toContain('perplexity, exa');
  });

  test('warn results with formerly_hardcoded_exempt include the PR #1206 hint', () => {
    const line = buildBrainFirstSummaryLine({
      skill: 'browser',
      status: 'warn',
      reason: 'missing_brain_first',
      external_patterns_matched: ['web_fetch'],
      formerly_hardcoded_exempt: true,
    });
    expect(line).toContain('hardcoded-exempt in PR #1206');
    expect(line).toContain('brain_first: exempt');
  });

  test('warn results carry typo hint through to message', () => {
    const line = buildBrainFirstSummaryLine({
      skill: 'typo',
      status: 'warn',
      reason: 'missing_brain_first',
      external_patterns_matched: ['perplexity'],
      typo_hint: 'Found brain-first: exempt — did you mean brain_first?',
      formerly_hardcoded_exempt: false,
    });
    expect(line).toContain('typo');
    expect(line).toContain('brain-first');
  });
});

// ---------------------------------------------------------------------------
// Snapshot+diff audit (A2 contract — zero writes on no-transition runs)
// ---------------------------------------------------------------------------

/**
 * Helper: provision an isolated audit tempdir for one test body and tear
 * it down via try/finally. Wraps the body in `withEnv()` so the
 * GBRAIN_AUDIT_DIR mutation is scoped to this test only — cross-test-
 * safe (no leak to other tests in the same shard) per the test-
 * isolation lint (R1).
 */
async function withAuditDir<T>(fn: (auditDir: string) => Promise<T> | T): Promise<T> {
  _resetWarnedSetForTests();
  const auditDir = join(
    tmpdir(),
    `brain-first-audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(auditDir, { recursive: true });
  try {
    return await withEnv({ GBRAIN_AUDIT_DIR: auditDir }, () => fn(auditDir));
  } finally {
    try { rmSync(auditDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

describe('audit-skill-brain-first (snapshot+diff)', () => {
  test('loadSnapshot returns present:false when file missing', async () => {
    await withAuditDir(() => {
      const r = loadSnapshot();
      expect(r.present).toBe(false);
      expect(r.violators.size).toBe(0);
    });
  });

  test('writeSnapshotAtomically + loadSnapshot round-trip', async () => {
    await withAuditDir(() => {
      writeSnapshotAtomically(new Set(['a', 'b', 'c']));
      const r = loadSnapshot();
      expect(r.present).toBe(true);
      expect(r.violators.has('a')).toBe(true);
      expect(r.violators.has('b')).toBe(true);
      expect(r.violators.has('c')).toBe(true);
    });
  });

  test('diffAgainstSnapshot detects added/removed/unchanged', () => {
    // Pure function — no audit dir needed.
    const prev = new Set(['a', 'b', 'c']);
    const curr = new Set(['b', 'c', 'd']);
    const diff = diffAgainstSnapshot(curr, prev);
    expect(diff.added).toEqual(['d']);
    expect(diff.removed).toEqual(['a']);
    expect(diff.unchanged).toEqual(['b', 'c']);
  });

  test('diff result is sorted for determinism', () => {
    const prev = new Set(['c', 'a', 'd']);
    const curr = new Set(['a', 'b', 'e']);
    const diff = diffAgainstSnapshot(curr, prev);
    expect(diff.added).toEqual(['b', 'e']);
    expect(diff.removed).toEqual(['c', 'd']);
    expect(diff.unchanged).toEqual(['a']);
  });

  test('corrupt snapshot JSON treated as missing with warn-once', async () => {
    await withAuditDir(auditDir => {
      const file = join(auditDir, 'skill-brain-first-snapshot.json');
      require('fs').writeFileSync(file, 'not-json-at-all');
      const r = loadSnapshot();
      expect(r.present).toBe(false);
      expect(r.violators.size).toBe(0);
    });
  });

  test('appendAuditEventsForTransitions writes one line per added/removed', async () => {
    await withAuditDir(() => {
      const diff = { added: ['skill-a'], removed: ['skill-b'], unchanged: ['skill-c'] };
      const patterns = new Map([['skill-a', ['web_search']]]);
      appendAuditEventsForTransitions(diff, patterns, 'test-run-1');
      const events = readRecentBrainFirstEvents(7);
      expect(events.length).toBe(2);
      const detected = events.find(e => e.event === 'detected');
      const resolved = events.find(e => e.event === 'resolved');
      expect(detected?.skill).toBe('skill-a');
      expect(detected?.external_patterns).toEqual(['web_search']);
      expect(resolved?.skill).toBe('skill-b');
    });
  });

  test('no-transition diff produces zero audit writes (A2 contract)', async () => {
    await withAuditDir(() => {
      const diff = { added: [], removed: [], unchanged: ['skill-a', 'skill-b'] };
      appendAuditEventsForTransitions(diff, new Map(), 'test-run-2');
      const events = readRecentBrainFirstEvents(7);
      expect(events.length).toBe(0);
    });
  });

  test('logBrainFirstEvent writes a fixed event', async () => {
    await withAuditDir(() => {
      logBrainFirstEvent({ event: 'fixed', skill: 'browser' });
      const events = readRecentBrainFirstEvents(7);
      expect(events.length).toBe(1);
      expect(events[0].event).toBe('fixed');
      expect(events[0].skill).toBe('browser');
      expect(events[0].code).toBe('SKILL_BRAIN_FIRST');
      expect(events[0].severity).toBe('info');
    });
  });

  test('computeBrainFirstAuditFilename produces ISO-week format', () => {
    const name = computeBrainFirstAuditFilename(new Date('2026-05-19T10:00:00Z'));
    expect(name).toMatch(/^skill-brain-first-2026-W\d{2}\.jsonl$/);
  });
});
