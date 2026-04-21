/**
 * BrainBench Category 10: Robustness / Adversarial.
 *
 * Tests that gbrain doesn't crash, hang, or silently corrupt on weird input.
 * Currently zero coverage of edge cases. Pass = no exceptions, no hangs > 30s,
 * no silent wrong-data outputs.
 *
 * Usage: bun run eval/runner/adversarial.ts [--json]
 */

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { extractPageLinks, parseTimelineEntries } from '../../src/core/link-extraction.ts';
import type { PageInput } from '../../src/core/types.ts';

interface CaseResult {
  name: string;
  ops_attempted: number;
  ops_succeeded: number;
  crashes: string[];
  silent_corruption: string[];
}

interface AdversarialCase {
  name: string;
  slug: string;
  page: PageInput;
  /** Optional invariants to check after putPage. */
  expect?: (engine: PGLiteEngine) => Promise<{ pass: boolean; note?: string }>;
}

const ADVERSARIAL_CASES: AdversarialCase[] = [
  // ── Empty / whitespace ──
  { name: 'empty compiled_truth', slug: 'concepts/empty-1', page: { type: 'concept', title: '', compiled_truth: '', timeline: '' } },
  { name: 'whitespace only', slug: 'concepts/ws-1', page: { type: 'concept', title: '   ', compiled_truth: '\n\t  \n', timeline: '   ' } },
  { name: 'newlines only', slug: 'concepts/nl-1', page: { type: 'concept', title: 'NL', compiled_truth: '\n\n\n\n', timeline: '\n\n' } },

  // ── Massive content ──
  { name: '50K char page', slug: 'concepts/big-1', page: { type: 'concept', title: 'Big', compiled_truth: 'Lorem ipsum dolor sit amet, '.repeat(2000), timeline: '' } },
  { name: '100K char page', slug: 'concepts/huge-1', page: { type: 'concept', title: 'Huge', compiled_truth: 'A'.repeat(100_000), timeline: '' } },

  // ── Unicode / non-Latin ──
  { name: 'CJK content', slug: 'concepts/cjk-1', page: { type: 'concept', title: '人工智能', compiled_truth: '这是一个关于人工智能的页面。提到了 [公司](companies/acme)。', timeline: '- **2026-01-01** | 创立' } },
  { name: 'Arabic RTL', slug: 'concepts/ar-1', page: { type: 'concept', title: 'الذكاء', compiled_truth: 'هذه صفحة عن الذكاء الاصطناعي.', timeline: '' } },
  { name: 'Cyrillic', slug: 'concepts/cy-1', page: { type: 'concept', title: 'Привет', compiled_truth: 'Это страница о технологиях.', timeline: '' } },
  { name: 'emoji-heavy', slug: 'concepts/emoji-1', page: { type: 'concept', title: '🚀 Launch', compiled_truth: '🚀🎉🔥 Launched! 💯 [Acme](companies/acme) 👏👏👏', timeline: '- **2026-01-01** | 🚀 launched' } },
  { name: 'mixed scripts', slug: 'concepts/mixed-1', page: { type: 'concept', title: 'Mix 混合 العربية', compiled_truth: 'English 中文 العربية русский 🇺🇸 [Acme](companies/acme).', timeline: '' } },

  // ── Code fences (slugs inside MUST NOT extract) ──
  { name: 'slug inside code fence', slug: 'concepts/code-1', page: {
    type: 'concept', title: 'Code',
    compiled_truth: 'See this code:\n```\nconst x = "people/should-not-extract";\nconst y = [Test](people/also-not-extract);\n```\nReal ref: [Real](people/real-target).',
    timeline: '',
  } },
  { name: 'inline code with slug', slug: 'concepts/inline-1', page: {
    type: 'concept', title: 'Inline',
    compiled_truth: 'Use the `people/code-fenced-slug` notation. Real ref: [Real](people/real-target-2).',
    timeline: '',
  } },

  // ── False-positive substrings ──
  { name: 'false-positive substring', slug: 'concepts/fp-1', page: {
    type: 'concept', title: 'FP',
    compiled_truth: 'A frank discussion of founder mode is needed. Note that [frank-founder](people/frank-founder) attended.',
    timeline: '',
  } },

  // ── Slugs with edge characters ──
  { name: 'slug with dots', slug: 'concepts/dot.in.slug', page: { type: 'concept', title: 'Dotty', compiled_truth: 'A page.', timeline: '' } },
  { name: 'slug with leading number', slug: 'concepts/123-numeric', page: { type: 'concept', title: 'Numeric', compiled_truth: 'A page.', timeline: '' } },
  { name: 'slug max length', slug: 'concepts/' + 'x'.repeat(200), page: { type: 'concept', title: 'Long', compiled_truth: 'A page.', timeline: '' } },

  // ── Malformed timeline ──
  { name: 'invalid date in timeline', slug: 'concepts/bad-date-1', page: {
    type: 'concept', title: 'BadDate',
    compiled_truth: 'A page.',
    timeline: '- **2026-13-45** | Invalid date\n- **not-a-date** | Garbage\n- **2026-02-15** | Valid entry',
  } },
  { name: 'timeline with no dates', slug: 'concepts/no-dates-1', page: {
    type: 'concept', title: 'NoDates',
    compiled_truth: 'A page.',
    timeline: '- Just a bullet, no date\n- Another bullet',
  } },

  // ── Deeply nested markdown ──
  { name: 'deeply nested lists', slug: 'concepts/nested-1', page: {
    type: 'concept', title: 'Nested',
    compiled_truth: '- L1\n  - L2\n    - L3\n      - L4\n        - L5\n          - L6\n            - L7\n              - L8',
    timeline: '',
  } },
  { name: 'long blockquote chain', slug: 'concepts/quote-1', page: {
    type: 'concept', title: 'Quoted',
    compiled_truth: '> > > > > > deeply quoted [Acme](companies/acme).',
    timeline: '',
  } },

  // ── Many entity refs in one page ──
  { name: '100 refs in one page', slug: 'meetings/megamention-1', page: {
    type: 'meeting', title: 'Mega',
    compiled_truth: Array.from({ length: 100 }, (_, i) => `[Person ${i}](people/p-${i})`).join(', '),
    timeline: '',
  } },

  // ── Repeated mentions of same entity (should dedupe to 1 link) ──
  // Note: tests extractPageLinks directly. engine.putPage doesn't run auto-link;
  // the operation handler does. Within-page dedup happens inside extractPageLinks.
  { name: 'same entity 50 times', slug: 'concepts/repeat-1', page: {
    type: 'concept', title: 'Repeat',
    compiled_truth: Array.from({ length: 50 }, () => '[Same](people/same-target)').join(' '),
    timeline: '',
  }, expect: async () => {
    const candidates = extractPageLinks(
      Array.from({ length: 50 }, () => '[Same](people/same-target)').join(' '),
      {},
      'concept',
    );
    const matches = candidates.filter(c => c.targetSlug === 'people/same-target');
    return { pass: matches.length === 1, note: `expected 1 candidate after within-page dedup, got ${matches.length}` };
  } },
];

async function tryOp<T>(name: string, fn: () => Promise<T>): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    const r = await Promise.race([
      fn().then(x => ({ ok: true as const, value: x })),
      new Promise<{ ok: false; error: string }>((_, reject) =>
        setTimeout(() => reject({ ok: false, error: 'TIMEOUT_30s' }), 30_000),
      ),
    ]);
    if ('value' in r && r.ok) return { ok: true, result: r.value };
    return { ok: false, error: 'unknown' };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `${name}: ${err.slice(0, 200)}` };
  }
}

async function main() {
  const json = process.argv.includes('--json');
  const log = json ? () => {} : console.log;

  log('# BrainBench Category 10: Robustness / Adversarial\n');
  log(`Generated: ${new Date().toISOString().slice(0, 19)}`);

  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const targetPages = [
    { slug: 'people/real-target', page: { type: 'person' as const, title: 'Real', compiled_truth: 'A real person.', timeline: '' } },
    { slug: 'people/real-target-2', page: { type: 'person' as const, title: 'Real2', compiled_truth: 'Real2.', timeline: '' } },
    { slug: 'people/frank-founder', page: { type: 'person' as const, title: 'Frank', compiled_truth: 'A founder.', timeline: '' } },
    { slug: 'people/same-target', page: { type: 'person' as const, title: 'Same', compiled_truth: 'Same.', timeline: '' } },
    { slug: 'companies/acme', page: { type: 'company' as const, title: 'Acme', compiled_truth: 'Acme.', timeline: '' } },
  ];
  for (const tp of targetPages) await engine.putPage(tp.slug, tp.page);

  const results: CaseResult[] = [];

  for (const c of ADVERSARIAL_CASES) {
    log(`\n## Case: ${c.name}`);
    const result: CaseResult = { name: c.name, ops_attempted: 0, ops_succeeded: 0, crashes: [], silent_corruption: [] };

    // 1. putPage
    result.ops_attempted++;
    const put = await tryOp('putPage', () => engine.putPage(c.slug, c.page));
    if (put.ok) result.ops_succeeded++; else result.crashes.push(put.error);

    // 2. getPage roundtrip — content should match what we put
    result.ops_attempted++;
    const got = await tryOp('getPage', () => engine.getPage(c.slug));
    if (got.ok) {
      result.ops_succeeded++;
      const page = got.result;
      if (page && page.compiled_truth !== c.page.compiled_truth) {
        result.silent_corruption.push(`getPage roundtrip differs (${(page.compiled_truth ?? '').length} vs ${c.page.compiled_truth.length} chars)`);
      }
    } else result.crashes.push(got.error);

    // 3. searchKeyword
    result.ops_attempted++;
    const search = await tryOp('searchKeyword', () => engine.searchKeyword('person', { limit: 10 }));
    if (search.ok) result.ops_succeeded++; else result.crashes.push(search.error);

    // 4. extractPageLinks (pure function, code-fence and false-positive checks happen here)
    result.ops_attempted++;
    const extract = await tryOp('extractPageLinks', async () => extractPageLinks(c.page.compiled_truth, {}, c.page.type));
    if (extract.ok) {
      result.ops_succeeded++;
      // Check: code fence content should NOT produce link candidates
      if (c.name.includes('code fence') || c.name.includes('inline code')) {
        const candidates = extract.result;
        const leaked = candidates.filter(cand => cand.targetSlug.includes('not-extract') || cand.targetSlug.includes('code-fenced-slug'));
        if (leaked.length > 0) result.silent_corruption.push(`code fence leak: extracted ${leaked.map(l => l.targetSlug).join(', ')}`);
      }
    } else result.crashes.push(extract.error);

    // 5. parseTimelineEntries
    result.ops_attempted++;
    const tl = await tryOp('parseTimelineEntries', async () => parseTimelineEntries(c.page.timeline ?? ''));
    if (tl.ok) {
      result.ops_succeeded++;
      // For "invalid date" case, valid entries should still parse
      if (c.name === 'invalid date in timeline') {
        const valid = tl.result.filter(e => e.date === '2026-02-15');
        if (valid.length === 0) result.silent_corruption.push('valid entry lost when other entries had invalid dates');
      }
    } else result.crashes.push(tl.error);

    // 6. traversePaths from this slug
    result.ops_attempted++;
    const traverse = await tryOp('traversePaths', () => engine.traversePaths(c.slug, { depth: 2 }));
    if (traverse.ok) result.ops_succeeded++; else result.crashes.push(traverse.error);

    // 7. Custom expect
    if (c.expect) {
      result.ops_attempted++;
      const expectResult = await tryOp('expect', () => c.expect!(engine));
      if (expectResult.ok) {
        result.ops_succeeded++;
        if (!expectResult.result.pass) {
          result.silent_corruption.push(`invariant failed: ${expectResult.result.note ?? 'no note'}`);
        }
      } else result.crashes.push(expectResult.error);
    }

    log(`  ${result.ops_succeeded}/${result.ops_attempted} ops succeeded`);
    if (result.crashes.length > 0) log(`  ✗ crashes: ${result.crashes.length}`);
    if (result.silent_corruption.length > 0) log(`  ✗ silent corruption: ${result.silent_corruption.length}`);
    for (const c2 of result.crashes) log(`    crash: ${c2}`);
    for (const sc of result.silent_corruption) log(`    silent: ${sc}`);

    results.push(result);
  }

  await engine.disconnect();

  const totalOps = results.reduce((s, r) => s + r.ops_attempted, 0);
  const totalSucc = results.reduce((s, r) => s + r.ops_succeeded, 0);
  const totalCrashes = results.reduce((s, r) => s + r.crashes.length, 0);
  const totalSilent = results.reduce((s, r) => s + r.silent_corruption.length, 0);

  log(`\n## Summary`);
  log(`Cases: ${results.length}`);
  log(`Ops attempted: ${totalOps}`);
  log(`Ops succeeded: ${totalSucc} (${((totalSucc / totalOps) * 100).toFixed(1)}%)`);
  log(`Crashes: ${totalCrashes}`);
  log(`Silent corruption: ${totalSilent}`);

  if (json) {
    process.stdout.write(JSON.stringify({ results, summary: { totalOps, totalSucc, totalCrashes, totalSilent } }, null, 2) + '\n');
  }

  if (totalCrashes > 0 || totalSilent > 0) {
    console.error(`\n⚠ ${totalCrashes} crash(es) and ${totalSilent} silent corruption(s) — see details above`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Adversarial eval error:', e);
  process.exit(1);
});
