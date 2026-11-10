/**
 * F5 reproduction: the product ranker equals the Step 1 prototype.
 *
 * 1. Protects: the A5 ranker ported from gbrain-evals (tokenizer, BM25F
 *    constants for variants D and T, tie order) ranks exactly like the
 *    prototype that produced the Step 1 numbers.
 * 2. Fails when: the tokenizer, a constant, the summation order or the tie
 *    rule drifts from the prototype.
 * 3. Fixture: test/fixtures/skill-resolver/step1-golden-gbrain.json.gz holds
 *    gbrain's own skills as the eval pinned them (this repository's text,
 *    MIT) and the Step 1 test-split turns (placeholders only), with the
 *    prototype's top-5 per turn. No third-party skill text is vendored (F6).
 *    The tolerance is zero: none of these texts contains CJK, the one place
 *    the product tokenizer differs by design (tokenizer test).
 * 4. Full reproduction over the 1,500-skill public catalog runs only when
 *    GBRAIN_TEST_SKILL_RANKER_EVAL_DIR points at a gbrain-evals checkout of
 *    docs/benchmarks/2026-11-07-skill-ranker-offline (the catalog stays in
 *    gbrain-evals, under its licences). Per cell (D and T forced, as the eval
 *    forced them, at 250, 750 and 1,500 skills) the ranker's top-5 must equal
 *    the prototype's on every turn over the catalog without CJK text. With
 *    the CJK skills in (53 of 1,500), the bigram rule changes their field
 *    lengths and so every skill's length norm, which moves some top-5 lists;
 *    hit@5 must then stay within one turn of arms-test.json (measured: D 250
 *    is one turn up, T 250 one turn down, the other four cells equal). The
 *    plan's "0.5 points" cannot be met by any non-identical ranking at n=81,
 *    where one turn is 1.23 points (delta review F5).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildSkillIndex, resolveSkills } from '../src/core/skills/resolver/index.ts';
import { CJK_SLUG_CHARS } from '../src/core/cjk.ts';
import { encodeIndex, IndexReader, VARIANT_PARAMS } from '../src/core/skills/resolver/index-format.ts';
import { rankIndex } from '../src/core/skills/resolver/rank.ts';

interface Golden {
  skills: { id: string; name: string; description: string; triggers: string[]; routing: string[]; body: string }[];
  turns: { id: string; text: string }[];
  golden: Record<'D' | 'T', Record<string, string[]>>;
}
const G = JSON.parse(gunzipSync(readFileSync(join(import.meta.dir, 'fixtures/skill-resolver/step1-golden-gbrain.json.gz'))).toString('utf8')) as Golden;

async function topFive(home: string, catalog: string, turns: { id: string; text: string }[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of turns) {
    const r = await resolveSkills({ message: t.text, top_k: 5 }, { home, catalogs: [catalog], sessionTokenBudget: 50_000 });
    out[t.id] = r.output.suggestions.map(s => s.id);
  }
  return out;
}

describe('the product ranker reproduces the Step 1 prototype', () => {
  test('the fixture has no CJK text, so the documented tokenizer difference cannot apply', () => {
    const cjk = new RegExp(`[${CJK_SLUG_CHARS}]`);
    expect(G.skills.length).toBe(71);
    expect(G.turns.length).toBe(240);
    expect(JSON.stringify(G.skills).match(cjk)).toBeNull();
    expect(G.turns.some(t => cjk.test(t.text))).toBe(false);
  });

  for (const variant of ['D', 'T'] as const) {
    test(`variant ${variant}: top-5 equals the prototype on every test turn`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'skres-repro-'));
      try {
        const skills = G.skills.map(s => ({ ...s, ...(variant === 'D' ? { triggers: [], routing: [] } : {}) }));
        // Variant T needs a quarter of the catalog to carry triggers; gbrain's own skills all do.
        const f = join(home, 'cat.json');
        writeFileSync(f, JSON.stringify(skills));
        const receipt = await buildSkillIndex({ catalog: 'golden', fromJson: f }, { home });
        expect(receipt.ranker.variant).toBe(variant);
        const got = await topFive(home, 'golden', G.turns);
        const mismatched = G.turns.filter(t => JSON.stringify(got[t.id]) !== JSON.stringify(G.golden[variant][t.id])).map(t => t.id);
        expect(mismatched).toEqual([]);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    }, 60_000);
  }
});

const EVAL = process.env.GBRAIN_TEST_SKILL_RANKER_EVAL_DIR;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PROTO = new Map<string, any>(EVAL ? [[EVAL, await import(join(EVAL, 'scripts/rank.ts'))]] : []);
describe.skipIf(!EVAL)('full Step 1 reproduction (GBRAIN_TEST_SKILL_RANKER_EVAL_DIR)', () => {
  test('the ranker equals the prototype on the CJK-free catalog, and full-catalog hit@5 is within one turn of arms-test.json', async () => {
    const dir = EVAL!;
    const rl = (p: string) => readFileSync(join(dir, p), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const all = rl('data/catalog.jsonl') as (Record<string, unknown> & { id: string; tier: string })[];
    const turns = rl('data/test.jsonl') as { id: string; text: string; acceptable: string[] }[];
    const arms = JSON.parse(readFileSync(join(dir, 'results/arms-test.json'), 'utf8')).table;
    const cjk = new RegExp(`[${CJK_SLUG_CHARS}]`);
    const tiers: Record<string, string[]> = { 250: ['core'], 750: ['core', 'pad750'], 1500: ['core', 'pad750', 'pad1500'] };
    const home = mkdtempSync(join(tmpdir(), 'skres-full-'));
    const report: string[] = [];
    try {
      for (const variant of ['D', 'T'] as const) {
        for (const size of ['250', '750', '1500']) {
          // The eval forced the variant per arm, so this encodes it directly instead of letting the build choose.
          const cat = all.filter(s => tiers[size]!.includes(s.tier)).map(s => ({ id: s.id, name: s.name as string, description: s.description as string, triggers: s.triggers as string[], routing: s.routing as string[], body: s.body as string }));
          const rankWith = (records: typeof cat, file: string) => {
            writeFileSync(join(home, file), encodeIndex(records, variant).bytes);
            const ix = IndexReader.open(join(home, file));
            return (text: string) => rankIndex(ix, text).ranked.slice(0, 5).map(r => ix.meta(r.doc).id);
          };
          const plain = cat.filter(s => !cjk.test(JSON.stringify(s)));
          const plainRank = rankWith(plain, `plain-${variant}-${size}.bin`);
          const plainGolden = goldenOf(dir, plain, variant);
          const mismatched = turns.filter(t => JSON.stringify(plainRank(t.text)) !== JSON.stringify(plainGolden(t.text))).map(t => t.id);
          expect({ variant, size, mismatched }).toEqual({ variant, size, mismatched: [] });

          const fullRank = rankWith(cat, `full-${variant}-${size}.bin`);
          const inCat = new Set(cat.map(s => s.id));
          let n = 0;
          let hits = 0;
          for (const t of turns) {
            const acc = t.acceptable.filter(id => inCat.has(id));
            if (!acc.length) continue;
            n++;
            if (fullRank(t.text).some(id => acc.includes(id))) hits++;
          }
          const wantHits = Math.round((arms[variant][size].per_turn.A5.hit5 as number) * n);
          report.push(`${variant} ${size}: ${hits}/${n} vs ${wantHits}/${n}`);
          expect(Math.abs(hits - wantHits)).toBeLessThanOrEqual(1);
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    console.log(report.join('\n'));
  }, 600_000);
});

/** The prototype's own top-5 on a record set, from the gbrain-evals checkout (scripts/rank.ts). */
function goldenOf(dir: string, cat: { id: string; name: string; description: string; triggers: string[]; routing: string[]; body: string }[], variant: 'D' | 'T') {
  const proto = PROTO.get(dir)!;
  const view = cat.map(s => (variant === 'D' ? { ...s, triggers: [], routing: [] } : s));
  const ix = proto.bm25Index(view, ['name', 'description', 'triggers', 'routing', 'body']);
  return (text: string) => (proto.rankBm25(view, ix, text, VARIANT_PARAMS[variant]).order as number[]).slice(0, 5).map(i => view[i]!.id);
}
