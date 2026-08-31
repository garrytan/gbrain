/**
 * F-Eval — hermetic $0 write-path mini-eval (eval fix wave, CEO-review E1).
 *
 * A frozen 3-transcript mini-corpus with expected salient units drives the
 * REAL runPhaseSynthesize end to end on PGLite: real triage parse + gate
 * (incl. the F2 rescue), real fan-out + oneshot drain, real quote
 * verify/repair, real provenance stamp + reverse-write + telemetry. The ONLY
 * stub is the gateway chat transport (__setChatTransportForTests — the
 * test/e2e/dream-synthesize-pglite.test.ts seam), serving a scripted triage
 * judge and a scripted oneshot child.
 *
 * HONESTY (outside-voice amendment 6): a scripted child cannot measure
 * whether PROMPT changes improve model output — that is the paid Cat 35
 * benchmark's job. This harness is the $0 regression pin for the MECHANICAL
 * write path: gate/rescue admission, page emission, the repair ladder acting
 * on real written pages, file dual-write, and telemetry shape. The
 * salient-unit presence score at the bottom is the canary: any mechanical
 * regression (emission, chunk slug rewrite, repair over-deletion) drops it
 * below 100%.
 *
 * Corpus discipline: fixtures are frozen HERE, distinct from the Cat 35
 * corpus (no tuning coupling), placeholder names only.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { normForGrounding } from '../src/core/cycle/synthesize-verify.ts';
import { __setChatTransportForTests, resetGateway, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';

// ── The frozen mini-corpus ────────────────────────────────────────────────

interface MiniFixture {
  basename: string;
  band: 'high' | 'buried' | 'routine';
  content: string;
  /** Verbatim salient anchors that MUST survive into a written page. */
  expect_units: string[];
  /** Judge segments (verbatim slices) served by the scripted triage. */
  segments: string[];
}

const PAD = 'User: also check the build status.\nAssistant: Green.\n'.repeat(30);

const FIXTURES: MiniFixture[] = [
  {
    basename: '2026-08-30-high-thesis.txt',
    band: 'high',
    expect_units: [
      'memory portability is the wedge because nobody wants memories locked to an agent vendor',
      'we charge for durability, not storage',
    ],
    segments: [
      'memory portability is the wedge because nobody wants memories locked to an agent vendor',
      'we charge for durability, not storage',
    ],
    content: `User: Two things crystallized today. First: memory portability is the wedge because nobody wants memories locked to an agent vendor. Second: we charge for durability, not storage — storage is a race to zero.\nAssistant: Both worth pages.\n${PAD}`,
  },
  {
    basename: '2026-08-30-buried-nugget.txt',
    band: 'buried',
    expect_units: [
      'our churn spikes line up with the annual renewal emails, not with outages',
      'rewrite renewal emails as value receipts sixty days before the invoice',
    ],
    segments: [
      'our churn spikes line up with the annual renewal emails, not with outages',
      'rewrite renewal emails as value receipts sixty days before the invoice',
    ],
    content: `${PAD}User: Oh, while I remember — I finally see it: our churn spikes line up with the annual renewal emails, not with outages. So: rewrite renewal emails as value receipts sixty days before the invoice.\nAssistant: Noted.\n${PAD}`,
  },
  {
    basename: '2026-08-30-routine-control.txt',
    band: 'routine',
    expect_units: [],
    segments: [],
    content: `User: Move my 9am and file the parking receipt.\nAssistant: Done and filed.\n${PAD}`,
  },
];

// The scripted child writes ONE reflections page per transcript. Its body
// exercises the repair ladder deliberately:
//   - an EXACT quote (survives untouched),
//   - a normalized-drift quote (straight apostrophe + hyphen where the
//     transcript has none → actually: whitespace drift) → repaired verbatim,
//   - a FABRICATED quote → stripped (text kept, marks removed),
// plus every expected salient unit as plain prose (the presence canary).
const FABRICATED = 'we should rewrite the entire product in a weekend, obviously';

function scriptedTransport(brainScaffoldSlug: string) {
  return async (opts: ChatOpts): Promise<ChatResult> => {
    const system = opts.system ?? '';
    const userMsg = String(opts.messages?.[0]?.content ?? '');
    let text: string;
    if (system.startsWith('You triage a conversation transcript')) {
      // The triage user message carries the extension-less basename; match on
      // the stem so the scripted judge maps to the right fixture.
      const f = FIXTURES.find(x => userMsg.includes(x.basename.replace(/\.txt$/, '')));
      const band = f?.band ?? 'routine';
      const score = band === 'high' ? 0.85 : band === 'buried' ? 0.4 : 0.1;
      text = JSON.stringify({
        score,
        content_type: band === 'high' ? 'reflection' : band === 'buried' ? 'mixed' : 'routine',
        segments: (f?.segments ?? []).map(q => ({ quote: q, note: 'scripted' })),
        entities: [],
        reasons: [band],
      });
    } else if (system.startsWith('You are a knowledge-synthesis engine')) {
      const f = FIXTURES.find(x => userMsg.includes(x.content.slice(0, 60)))
        ?? FIXTURES.find(x => (x.segments[0] ? userMsg.includes(x.segments[0]) : false));
      const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(userMsg)?.[1] ?? 'nohash';
      const units = f?.expect_units ?? [];
      const exact = f?.segments[0] ?? 'no segment';
      // Normalized drift: collapse the exact quote's spaces oddly + uppercase
      // one word — repairable to the verbatim transcript slice (rung 2).
      const drifted = (f?.segments[1] ?? 'no second segment').replace(/^rewrite|^we/, m => m.toUpperCase()).replace(/ /g, '  ');
      const body = [
        `A working session distilled. See [[${brainScaffoldSlug}]] for context.`,
        '',
        `Key units: ${units.join('; ')}.`,
        '',
        `The user said: "${exact}"`,
        '',
        `They also said: "${drifted}"`,
        '',
        `And allegedly: "${FABRICATED}"`,
      ].join('\n');
      text = JSON.stringify({
        pages: [{
          slug: `wiki/personal/reflections/2026-08-30-mini-eval-${hash}`,
          title: 'Mini-eval reflection',
          type: 'note',
          body,
        }],
        skipped: false,
        skip_reason: null,
      });
    } else {
      text = '{}';
    }
    return {
      text,
      blocks: [{ type: 'text', text } as never],
      stopReason: 'end',
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: opts.model ?? 'anthropic:scripted',
      providerId: 'anthropic',
    };
  };
}

describe('F-Eval: hermetic write-path mini-eval (real phase, scripted transport)', () => {
  let engine: PGLiteEngine;
  let brainDir: string;
  let corpusDir: string;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    brainDir = mkdtempSync(join(tmpdir(), 'gbrain-minieval-brain-'));
    corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-minieval-corpus-'));
  });
  afterAll(async () => {
    __setChatTransportForTests(null);
    resetGateway();
    try { await engine.disconnect(); } catch { /* best-effort */ }
    try { rmSync(brainDir, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(corpusDir, { recursive: true, force: true }); } catch { /* */ }
  });

  test('gate+rescue admit the right transcripts; repair ladder fixes real pages; units survive to disk', async () => {
    {
      // Scaffold page so the wikilink mandate is satisfiable (Cat 35 pattern).
      const scaffold = 'people/alice-example';
      await importFromContent(engine, scaffold, '---\ntype: person\n---\nAlice Example, a founder.', { noEmbed: true, remote: false, sourceId: 'default' });

      await engine.setConfig('dream.synthesize.enabled', 'true');
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
      await engine.setConfig('dream.synthesize.cooldown_hours', '0');
      // The frozen fixtures are deliberately small; the 2000-char discovery
      // floor is not what this harness pins.
      await engine.setConfig('dream.synthesize.min_chars', '200');
      for (const f of FIXTURES) writeFileSync(join(corpusDir, f.basename), f.content);

      __setChatTransportForTests(scriptedTransport(scaffold));
      // Fake key via withEnv (R1): hasAnthropicKey() must see one so the
      // judge client exists — the transport stub intercepts every real call.
      const result = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-mini-eval' }, () =>
        runPhaseSynthesize(engine, { brainDir, dryRun: false }));
      expect(result.status).toBe('ok');
      const details = result.details as {
        pages_written: number;
        written_slugs: string[];
        verdicts: Array<{ filePath: string; worth: boolean; rescued?: boolean; score: number | null }>;
        triage: { rescue_fired: number; rescue_checked: number; below_threshold: number; tokens_in: number };
        synthesis: {
          quote_verify: { pages_checked: number; quotes_total: number; exact: number; normalized_fixed: number; near_fixed: number; stripped: number; pages_repaired: number; errors: number } | null;
          spend: { cost_basis: string; children: { tokens_in: number }; triage: { tokens_in: number } };
          children_zero_pages: number;
        };
      };

      // ── Admission: high passes plainly, buried passes VIA RESCUE, routine never fires.
      const byPath = new Map(details.verdicts.map(v => [v.filePath, v]));
      const v = (name: string) => byPath.get(join(corpusDir, name))!;
      expect(v('2026-08-30-high-thesis.txt').worth).toBe(true);
      expect(v('2026-08-30-high-thesis.txt').rescued).toBeUndefined();
      expect(v('2026-08-30-buried-nugget.txt').worth).toBe(true);
      expect(v('2026-08-30-buried-nugget.txt').rescued).toBe(true);
      expect(v('2026-08-30-routine-control.txt').worth).toBe(false);
      expect(details.triage.rescue_fired).toBe(1);
      expect(details.triage.below_threshold).toBe(1); // routine only — rescued is NOT below-threshold
      expect(details.pages_written).toBe(2);

      // ── Repair ladder on the REAL written pages (per page: 1 exact, 1 repaired, 1 stripped).
      const qv = details.synthesis.quote_verify!;
      expect(qv.pages_checked).toBe(2);
      expect(qv.errors).toBe(0);
      expect(qv.exact).toBe(2);
      expect(qv.normalized_fixed).toBe(2);
      expect(qv.stripped).toBe(2);
      expect(qv.pages_repaired).toBe(2);

      // ── Salient-unit presence canary: every expected unit, normalized, in a written page body.
      let present = 0;
      let total = 0;
      const bodies: string[] = [];
      for (const slug of details.written_slugs) {
        const page = await engine.getPage(slug, { sourceId: 'default' });
        bodies.push(normForGrounding(`${page?.compiled_truth ?? ''}\n${page?.timeline ?? ''}`));
      }
      for (const f of FIXTURES) {
        for (const u of f.expect_units) {
          total++;
          if (bodies.some(b => b.includes(normForGrounding(u)))) present++;
        }
      }
      expect(total).toBe(4);
      expect(present).toBe(total); // 100% — the mechanical canary

      // ── Dual-write: the reverse-written .md carries the REPAIRED body.
      const mdPaths = details.written_slugs.map(s => join(brainDir, `${s}.md`));
      for (const p of mdPaths) expect(existsSync(p)).toBe(true);
      const mdAll = mdPaths.map(p => readFileSync(p, 'utf8')).join('\n');
      expect(normForGrounding(mdAll)).toContain(normForGrounding(FABRICATED));
      expect(mdAll).not.toContain(`"${FABRICATED}"`); // stripped, not quoted
      // The drifted quote was repaired to a verbatim transcript slice.
      expect(normForGrounding(mdAll)).toContain(normForGrounding('rewrite renewal emails as value receipts sixty days before the invoice'));

      // ── Telemetry shape: spend block + rule-D counter present and honest.
      expect(details.synthesis.spend.cost_basis).toBe('in+out+cache_read');
      expect(details.synthesis.spend.triage.tokens_in).toBeGreaterThan(0);
      expect(details.synthesis.children_zero_pages).toBe(0);
    }
  }, 120_000);

  test('kill switch: quote_verify=false leaves fabricated quotes intact and reports quote_verify null; a declining child counts in children_zero_pages', async () => {
    const brainDir2 = mkdtempSync(join(tmpdir(), 'gbrain-minieval-brain2-'));
    const corpusDir2 = mkdtempSync(join(tmpdir(), 'gbrain-minieval-corpus2-'));
    try {
      const scaffold = 'people/alice-example';
      await importFromContent(engine, scaffold, '---\ntype: person\n---\nAlice Example, a founder.', { noEmbed: true, remote: false, sourceId: 'default' });
      await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir2);
      await engine.setConfig('dream.synthesize.quote_verify', 'false');   // the incident escape hatch
      await engine.setConfig('dream.synthesize.last_completion_ts', '');
      // One signal transcript (child writes, quotes unrepaired) + one that the
      // child DECLINES (task D) despite passing the gate — the rule-D case.
      // Distinct content from test 1 (different content hash → fresh
      // idempotency keys, fresh slugs — no cross-test page reuse).
      const high = { ...FIXTURES[0], basename: '2026-08-31-killswitch-writer.txt', content: `KILLSWITCH RUN.\n${FIXTURES[0].content}` };
      writeFileSync(join(corpusDir2, high.basename), high.content);
      const decliner = { basename: '2026-08-31-decliner.txt', content: `DECLINER RUN.\n${FIXTURES[0].content}` };
      writeFileSync(join(corpusDir2, decliner.basename), decliner.content);

      __setChatTransportForTests(async (opts) => {
        const system = opts.system ?? '';
        const userMsg = String(opts.messages?.[0]?.content ?? '');
        const isDecliner = userMsg.includes('decliner');
        let text: string;
        if (system.startsWith('You triage a conversation transcript')) {
          text = JSON.stringify({ score: 0.85, content_type: 'reflection', segments: [{ quote: high.segments[0], note: 's' }], entities: [], reasons: ['high'] });
        } else if (isDecliner) {
          text = JSON.stringify({ pages: [], skipped: true, skip_reason: 'still routine' });
        } else {
          const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(userMsg)?.[1] ?? 'nohash';
          text = JSON.stringify({ pages: [{ slug: `wiki/personal/reflections/2026-08-30-killswitch-${hash}`, title: 'T', type: 'note', body: `Body. See [[${scaffold}]].\n\nAlleged: "${FABRICATED}"` }], skipped: false, skip_reason: null });
        }
        return { text, blocks: [{ type: 'text', text } as never], stopReason: 'end', usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:scripted', providerId: 'anthropic' };
      });

      const result = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-mini-eval' }, () =>
        runPhaseSynthesize(engine, { brainDir: brainDir2, dryRun: false }));
      expect(result.status).toBe('ok');
      const d = result.details as { written_slugs: string[]; synthesis: { quote_verify: unknown; children_zero_pages: number } };
      expect(d.synthesis.quote_verify).toBeNull();               // pass skipped entirely
      expect(d.synthesis.children_zero_pages).toBe(1);           // rule-D decliner counted
      const killSlug = d.written_slugs.find(s => s.includes('killswitch'));
      expect(killSlug).toBeDefined();
      const page = await engine.getPage(killSlug!, { sourceId: 'default' });
      expect(`${page?.compiled_truth ?? ''}`).toContain(`"${FABRICATED}"`); // unrepaired, marks intact
    } finally {
      await engine.setConfig('dream.synthesize.quote_verify', 'true');
      try { rmSync(brainDir2, { recursive: true, force: true }); } catch { /* */ }
      try { rmSync(corpusDir2, { recursive: true, force: true }); } catch { /* */ }
    }
  }, 120_000);
});
