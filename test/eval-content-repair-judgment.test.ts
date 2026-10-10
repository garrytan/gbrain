/**
 * Keyless check of the content-repair judgment eval instrument (#6377, plan
 * section 4, evals/content-repair-judgment/).
 *
 * Protects: the committed fixtures match their generator; the set counts
 * the plan fixes (25 true duplicates, 10 stray slugs, 8 adversarial, 5
 * ambiguous) with placeholder names only; every held file's slug line names
 * the paired page; the late-evidence fixtures keep their evidence out of
 * the first 60 non-blank body lines and inside `mentions` (through the production participant builder); the grader's truth table
 * (a remove on a true duplicate and a merge elsewhere or into the wrong
 * canonical are hard failures, needs_human is never one, an ambiguous guess
 * is neither); the scorer's rates, the decision boundary and the ranking
 * (ties to the cheaper model). Fails when: a fixture is hand-edited without
 * regenerating, a case drifts off its claimed shape, or the grader stops
 * counting a wrong merge as a hard failure. It guards the instrument, not
 * the score: the live run (harness.ts --model ...) spends tokens and is never
 * part of CI.
 * Why new: the eval is new with #6377.
 * Seams: none (pure functions over the fixtures; no gateway, no brain).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkFixtures, SET_COUNTS } from '../evals/content-repair-judgment/check.ts';
import { fixturesJsonl, type Fixture } from '../evals/content-repair-judgment/generate-fixtures.ts';
import { judgmentInput } from '../evals/content-repair-judgment/input.ts';
import { buildReport, renderMarkdown } from '../evals/content-repair-judgment/report.ts';
import { grade, meetsRule, rank, summarize, type ResultRow, type Verdict } from '../evals/content-repair-judgment/score.ts';

const dir = join(import.meta.dir, '..', 'evals/content-repair-judgment');
const text = readFileSync(join(dir, 'fixtures.jsonl'), 'utf8');
const fixtures: Fixture[] = text.trim().split('\n').map(line => JSON.parse(line));
const byId = (id: string) => fixtures.find(f => f.id === id)!;

describe('fixtures', () => {
  test('match the generator (regenerate with bun evals/content-repair-judgment/generate-fixtures.ts)', () => {
    expect(text).toBe(fixturesJsonl());
  });

  test('the set counts, placeholder names, slug lines, canonicals and late evidence hold', () => {
    expect(checkFixtures(fixtures)).toEqual([]);
    expect(fixtures.length).toBe(Object.values(SET_COUNTS).reduce((s, n) => s + n, 0));
    expect(fixtures.filter(f => f.tags.includes('held_canonical')).length).toBe(3);
    expect(fixtures.filter(f => f.cls === 'mutual_notes_late').length).toBe(3);
    expect(fixtures.filter(f => f.cls === 'late_evidence').length).toBe(2);
    for (const f of fixtures) expect(f.expected.hard.includes('needs_human')).toBe(false);
  });

  test('the judgment input shows the slug line, both slugs, 60 head lines at most and late mentions', () => {
    const input = judgmentInput(byId('adv-07'));
    expect(input.held.frontmatter.slug).toBe('people/xia-example');
    expect(input.held.slug).toBe('people/xia-example-2');
    expect(input.named!.slug).toBe('people/xia-example');
    expect(input.held.head_lines.length).toBe(60);
    expect(input.held.head_lines.some(l => l.includes('Not the same person'))).toBe(false);
    expect(input.held.mentions).toEqual([expect.stringContaining('Not the same person as [[people/xia-example]]')]);
    expect(input.reason).toBe('frontmatter_slug_conflict');
    const stray = judgmentInput(byId('ss-09'));
    expect(stray.held.type).toBe('meeting');
    expect(stray.named!.type).toBe('company');
    expect(stray.held.frontmatter).toMatchObject({ type: 'meeting', slug: 'companies/acme-example', date: '2026-03-02' });
    expect(stray.held.headings).toEqual(['Acme Example intro', 'Notes']);
  });
});

describe('grader', () => {
  const merge = (canonical: string): Verdict => ({ action: 'merge_into', canonical });
  const remove: Verdict = { action: 'remove_slug' };
  const human: Verdict = { action: 'needs_human' };

  test('true duplicate: the right canonical is best, the wrong one and a remove are hard failures, needs_human is acceptable', () => {
    const f = byId('td-n-01');
    expect(grade(f, merge('people/alice-example'))).toBe('best');
    expect(grade(f, merge('people/alice-example-hivemind'))).toBe('hard_failure');
    expect(grade(f, remove)).toBe('hard_failure');
    expect(grade(f, human)).toBe('acceptable');
    expect(grade(f, null)).toBe('no_answer');
    const heldCanonical = byId('td-n-03');
    expect(grade(heldCanonical, merge('people/carol-example-full'))).toBe('best');
    expect(grade(heldCanonical, merge('people/carol-example'))).toBe('hard_failure');
  });

  test('stray and adversarial: remove is best, any merge is a hard failure; ambiguous: needs_human is best and the rest are guesses', () => {
    for (const id of ['ss-01', 'adv-05']) {
      expect(grade(byId(id), remove)).toBe('best');
      expect(grade(byId(id), human)).toBe('acceptable');
      expect(grade(byId(id), merge(byId(id).named!.slug))).toBe('hard_failure');
      expect(grade(byId(id), merge(byId(id).held.slug))).toBe('hard_failure');
    }
    expect(grade(byId('amb-01'), human)).toBe('best');
    expect(grade(byId('amb-01'), remove)).toBe('guess');
    expect(grade(byId('amb-01'), merge('people/zed-example'))).toBe('guess');
  });
});

describe('scorer', () => {
  const row = (model: string, run: number, f: Fixture, verdict: Verdict | null, usd = 0.01, failure: string | null = null): ResultRow => ({
    model, run, id: f.id, set: f.set, cls: f.cls, tags: f.tags, verdict, failure, grade: grade(f, verdict), input_tokens: 1000, output_tokens: 50, usd, latency_ms: 1500, stop: 'end', text: '', attempts: 1,
  });
  const td = fixtures.filter(f => f.set === 'true_duplicate');
  const others = fixtures.filter(f => f.set !== 'true_duplicate');

  test('rates, the decision boundary and the ranking', () => {
    // model a: every true duplicate right, every other pair remove_slug or needs_human -> qualifies.
    const a = [...td.map(f => row('a', 1, f, { action: 'merge_into', canonical: f.canonical! })), ...others.map(f => row('a', 1, f, f.set === 'ambiguous' ? { action: 'needs_human' } : { action: 'remove_slug' }, 0.02))];
    // model b: 20 of 25 right (80%), 5 needs_human, cheaper -> qualifies, ranks below a on accuracy.
    const b = [...td.map((f, i) => row('b', 1, f, i < 20 ? { action: 'merge_into', canonical: f.canonical! } : { action: 'needs_human' }, 0.005)), ...others.map(f => row('b', 1, f, { action: 'needs_human' }, 0.005))];
    // model c: like a but one remove_slug on a true duplicate -> one hard failure, fails.
    const c = a.map(r => ({ ...r, model: 'c' }));
    c[0] = row('c', 1, td[0]!, { action: 'remove_slug' });
    // model d: like a, same accuracy, cheaper -> ranks first on the tie.
    const d = a.map(r => ({ ...r, model: 'd', usd: r.usd / 2 }));
    const summaries = summarize([...a, ...b, ...c, ...d]);
    const by = Object.fromEntries(summaries.map(s => [s.model, s]));
    expect(by.a!.true_duplicate).toMatchObject({ n: 25, merge_canonical: 25, accuracy: 1, wrong_canonical: 0 });
    expect(by.a!.hard_failures).toBe(0);
    expect(by.a!.ambiguous.by_action.needs_human).toBe(5);
    expect(by.a!.needs_human_rate).toBeCloseTo(5 / 48, 10);
    expect(by.b!.true_duplicate.accuracy).toBeCloseTo(0.8, 10);
    expect(by.b!.needs_human_rate).toBeCloseTo(28 / 48, 10);
    expect(by.c!.hard_failures).toBe(1);
    expect(by.c!.hard_failure_ids).toEqual({ [td[0]!.id]: 1 });
    expect(meetsRule(by.a!)).toBe(true);
    expect(meetsRule(by.b!)).toBe(true);
    expect(meetsRule(by.c!)).toBe(false);
    expect(meetsRule({ ...by.b!, true_duplicate: { ...by.b!.true_duplicate, accuracy: 0.79 } })).toBe(false);
    expect(rank(summaries).map(s => s.model)).toEqual(['d', 'a', 'b', 'c']);
    const report = buildReport(summaries, ['x.jsonl']);
    expect(report.measured_models).toEqual(['d', 'a', 'b']);
    const md = renderMarkdown(report);
    expect(md).toContain('| `c` | 1/48 (td-n-01 ×1) |');
    expect(md).toContain('Proposed `CONTENT_REPAIR_MEASURED_MODELS`: `d`, `a`, `b`.');
  });

  test('a missing verdict is a no_answer with its failure class, never a hard failure', () => {
    const [s] = summarize([row('m', 1, td[0]!, null, 0, 'llm_malformed'), row('m', 1, td[1]!, null, 0, 'llm_unavailable'), row('m', 2, td[1]!, null, 0, 'llm_unavailable')]);
    expect(s!.no_answer).toEqual({ n: 3, by_failure: { llm_malformed: 1, llm_unavailable: 2 } });
    expect(s!.hard_failures).toBe(0);
    expect(s!.runs).toBe(2);
    expect(s!.true_duplicate.per_run_accuracy).toEqual([0, 0]);
  });
});
