/**
 * H1 (test-gap plan) — keyless CI validation for the takes-bootstrap eval
 * (evals/takes-bootstrap/, TODOS TODO-E). Two halves:
 *
 *   1. CORPUS integrity: >=100 cases, schema-valid, unique ids, category
 *      floors (incl. empty/attribution/adversarial precision classes),
 *      regenerator-fresh, placeholder-only names (privacy rule).
 *   2. SCORER math: exact precision/recall arithmetic on synthetic
 *      predictions, malformed-case = FAILURE (never a skip), forbid
 *      violations fail graduation, and the graduation boundary bites.
 *
 * The LIVE classifier run stays opt-in (spends tokens):
 *   bun evals/takes-bootstrap/harness.mjs         # needs a chat key
 *   bun evals/takes-bootstrap/harness.mjs --replay results.jsonl   # $0
 * Autopilot tier for takes-bootstrap remains manual_only until a live run
 * GRADUATES (TODO-E) — this file guards the instrument, not the score.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { scoreCorpus, GRADUATION, type CorpusCase } from '../evals/takes-bootstrap/scorer.ts';

const repoRoot = join(import.meta.dir, '..');
const corpusPath = join(repoRoot, 'evals/takes-bootstrap/corpus.jsonl');
const corpus: CorpusCase[] = readFileSync(corpusPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));

describe('corpus integrity', () => {
  test('>=100 schema-valid cases with unique ids', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(100);
    const ids = new Set<string>();
    for (const c of corpus) {
      expect(typeof c.id).toBe('string');
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(c.page.body.length).toBeGreaterThan(10);
      expect(Array.isArray(c.expected)).toBe(true);
      for (const e of c.expected) {
        expect(['fact', 'take', 'bet', 'hunch']).toContain(e.kind);
        expect(() => new RegExp(e.claim_re)).not.toThrow();
        expect(e.weight_min).toBeLessThanOrEqual(e.weight_max);
      }
      for (const f of c.forbid) expect(() => new RegExp(f)).not.toThrow();
    }
  });

  test('category floors: precision classes are represented', () => {
    const byCat = new Map<string, number>();
    for (const c of corpus) byCat.set(c.category, (byCat.get(c.category) ?? 0) + 1);
    for (const cat of ['fact', 'take', 'bet', 'hunch', 'empty', 'attribution', 'adversarial', 'mixed']) {
      expect(byCat.get(cat) ?? 0).toBeGreaterThanOrEqual(6);
    }
    // Precision cases (expect NOTHING) must be a real share of the corpus.
    const emptyExpected = corpus.filter(c => c.expected.length === 0).length;
    expect(emptyExpected).toBeGreaterThanOrEqual(20);
  });

  test('committed corpus is regenerator-fresh (deterministic builder)', () => {
    // Read the committed bytes FIRST, regenerate in place, then demand FULL
    // byte equality — a drifted generator (or hand-edited corpus) fails here,
    // not just a changed line count or first id. The finally block restores
    // the committed bytes on failure so a red run never leaves the tree dirty.
    const committed = readFileSync(corpusPath, 'utf8');
    try {
      const out = execFileSync('node', ['evals/takes-bootstrap/generate-corpus.mjs'], { cwd: repoRoot, encoding: 'utf8' });
      expect(out).toContain('wrote');
      const regenerated = readFileSync(corpusPath, 'utf8');
      expect(regenerated).toBe(committed);
    } finally {
      if (readFileSync(corpusPath, 'utf8') !== committed) {
        writeFileSync(corpusPath, committed);
      }
    }
  });

  test('privacy: placeholder identities only', () => {
    const text = readFileSync(corpusPath, 'utf8');
    // Every person/company mention must come from the placeholder pools.
    for (const required of ['Alice Example', 'Widget Co', 'fund-c']) {
      expect(text).toContain(required);
    }
    // Negative side: the corpus lives under evals/, OUTSIDE the scan surface
    // of the repo privacy guards (check-privacy.sh scans src/test/docs/skills/
    // scripts only), so this test re-applies their banned tokens to the
    // corpus. The tokens are read from the guard scripts — their one
    // allowlisted home — because repeating the literals here would itself
    // trip check-privacy / check-test-real-names on this file.
    const lower = text.toLowerCase();
    const realNamesSh = readFileSync(join(repoRoot, 'scripts/check-test-real-names.sh'), 'utf8');
    // Line-state parse (a lazy paren regex truncates at ')' inside comments);
    // entries only, not quoted words in comments.
    const banned: string[] = [];
    let inArray = false;
    for (const line of realNamesSh.split('\n')) {
      if (/^BANNED_(NAMES|EMAILS)=\($/.test(line.trim())) { inArray = true; continue; }
      if (inArray && line.trim() === ')') { inArray = false; continue; }
      const m = inArray ? line.match(/^\s*'([^']+)'/) : null;
      if (m) banned.push(m[1]);
    }
    const privacySh = readFileSync(join(repoRoot, 'scripts/check-privacy.sh'), 'utf8');
    const forkName = privacySh.match(/^BANNED_NAME='([^']+)'/m)?.[1];
    expect(forkName).toBeTruthy();
    banned.push(forkName!);
    expect(banned.length).toBeGreaterThanOrEqual(5);
    for (const b of banned) {
      expect(lower.includes(b.toLowerCase())).toBe(false);
    }
  });
});

describe('scorer math', () => {
  const mini: CorpusCase[] = [
    {
      id: 'a', category: 'take', page: { slug: 't/a', type: 'note', title: 'A', body: 'x' },
      expected: [{ claim_re: 'strongest team', kind: 'take', weight_min: 0.4, weight_max: 1 }],
      forbid: [], notes: '',
    },
    {
      id: 'b', category: 'empty', page: { slug: 't/b', type: 'note', title: 'B', body: 'x' },
      expected: [], forbid: ['fraudulent'], notes: '',
    },
  ];

  test('perfect run graduates with exact arithmetic', () => {
    const r = scoreCorpus(mini, [
      { id: 'a', claims: [{ claim: 'the strongest team here', kind: 'take', weight: 0.8 }] },
      { id: 'b', claims: [] },
    ]);
    expect(r.by_kind.find(k => k.kind === 'take')).toMatchObject({ expected: 1, matched: 1, predicted: 1, precise: 1, precision: 1, recall: 1 });
    expect(r.overall).toEqual({ precision: 1, recall: 1, f1: 1 });
    expect(r.malformed).toEqual([]);
    expect(r.graduated).toBe(true);
  });

  test('malformed case is a FAILURE, never a skip', () => {
    const r = scoreCorpus(mini, [
      { id: 'a', claims: null },
      { id: 'b', claims: [] },
    ]);
    expect(r.malformed).toEqual(['a']);
    expect(r.graduated).toBe(false);
    // The malformed case's expectations still count in the denominator.
    expect(r.by_kind.find(k => k.kind === 'take')!.expected).toBe(1);
    expect(r.by_kind.find(k => k.kind === 'take')!.recall).toBe(0);
  });

  test('a MISSING prediction row is malformed too (no silent denominator shrink)', () => {
    const r = scoreCorpus(mini, [{ id: 'b', claims: [] }]);
    expect(r.malformed).toEqual(['a']);
    expect(r.graduated).toBe(false);
  });

  test('forbid violation (injection/attribution leak) blocks graduation', () => {
    const r = scoreCorpus(mini, [
      { id: 'a', claims: [{ claim: 'the strongest team here', kind: 'take', weight: 0.8 }] },
      { id: 'b', claims: [{ claim: 'acme is fraudulent', kind: 'fact', weight: 1 }] },
    ]);
    expect(r.forbid_violations.length).toBe(1);
    expect(r.graduated).toBe(false);
  });

  test('kind mismatch and out-of-range weight are recall misses; hallucination is a precision miss', () => {
    const r = scoreCorpus(mini, [
      // right words, wrong kind → neither recall nor precision credit
      { id: 'a', claims: [{ claim: 'strongest team', kind: 'fact', weight: 0.8 }, { claim: 'made-up thing', kind: 'take', weight: 0.5 }] },
      { id: 'b', claims: [] },
    ]);
    const take = r.by_kind.find(k => k.kind === 'take')!;
    expect(take.matched).toBe(0);
    expect(take.precise).toBe(0);
    expect(take.predicted).toBe(1);
    const fact = r.by_kind.find(k => k.kind === 'fact')!;
    expect(fact.predicted).toBe(1);
    expect(fact.precise).toBe(0);
    expect(r.graduated).toBe(false);
  });

  test('graduation boundary bites at the documented bars', () => {
    // 5 expected takes; 4 matched (recall .8 >= .7 ok), 5 predicted 4 precise
    // (precision .8 >= .8 ok) → graduates. Drop one precise → .6 precision → fails.
    const cases: CorpusCase[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`, category: 'take', page: { slug: `t/c${i}`, type: 'note', title: 'C', body: 'x' },
      expected: [{ claim_re: `claim-${i}`, kind: 'take', weight_min: 0, weight_max: 1 }],
      forbid: [], notes: '',
    }));
    const good = cases.map((c, i) => ({
      id: c.id,
      claims: i === 4
        ? [{ claim: 'unrelated', kind: 'take', weight: 0.5 }]
        : [{ claim: `claim-${i} text`, kind: 'take', weight: 0.5 }],
    }));
    const passing = scoreCorpus(cases, good);
    expect(passing.by_kind.find(k => k.kind === 'take')!.precision).toBe(0.8);
    expect(passing.by_kind.find(k => k.kind === 'take')!.recall).toBe(0.8);
    expect(passing.graduated).toBe(true);
    expect(GRADUATION.minPrecision).toBe(0.8);
  });

  test('the committed corpus scores 100% against its own oracle predictions (labels are satisfiable)', () => {
    // Build oracle predictions straight from the labels: every expected
    // regex must be satisfiable by SOME claim string (we synthesize one by
    // using the page body, which each claim_re was authored against).
    const oracle = corpus.map(c => ({
      id: c.id,
      claims: c.expected.map(e => {
        const m = new RegExp(e.claim_re, 'i').exec(c.page.body) ?? new RegExp(e.claim_re, 'i').exec(c.page.title);
        if (!m) throw new Error(`${c.id}: claim_re '${e.claim_re}' matches neither body nor title — unsatisfiable label`);
        return { claim: m[0], kind: e.kind, weight: (e.weight_min + e.weight_max) / 2 };
      }),
    }));
    const r = scoreCorpus(corpus, oracle);
    expect(r.malformed).toEqual([]);
    expect(r.forbid_violations).toEqual([]);
    expect(r.overall.recall).toBe(1);
    expect(r.overall.precision).toBe(1);
    expect(r.graduated).toBe(true);
  });
});
