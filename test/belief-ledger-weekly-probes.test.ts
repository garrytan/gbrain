/**
 * W4 acceptance: weekly-change probes from the ledger on a synthetic brain. A seeded generator writes four "weeks" of edits
 * (facts added, removed and re-scored, takes added and re-weighted, links added and removed, pages created, and edits
 * reverted inside the same week) and keeps its own record of every belief's state at each week boundary. For each week
 * the belief diff is scored against that record: set-F1 over (kind, page, belief, change) at or above 0.95, before and
 * after values exact for re-scored beliefs, and the diff's tokens against `delta`'s page list for the same week.
 * Gold model: a page created in a week is one page change plus one per fence fact and take; its links are counted on the
 * page, not listed (docs/designs/BELIEF_LEDGER.md section 15).
 */
import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import { beliefChanges, renderBeliefChange } from '../src/core/belief/changes.ts';
import { estimateTokens } from '../src/core/search/token-budget.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

interface PageState { facts: Map<string, string>; takes: Map<string, string>; links: Set<string> }
type Gold = Set<string>;

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const clone = (p: PageState): PageState => ({ facts: new Map(p.facts), takes: new Map(p.takes), links: new Set(p.links) });
const render = (slug: string, p: PageState) => beliefPage({ title: slug.split('/')[1], facts: [...p.facts].map(([claim, confidence]) => ({ claim, confidence })),
  takes: [...p.takes].map(([claim, weight]) => ({ claim, weight })), links: [...p.links] });

/** Gold changes between two states of the brain: (kind, page, belief, change), and the before/after of every re-scored belief. */
function gold(before: Map<string, PageState>, after: Map<string, PageState>): { set: Gold; values: Map<string, [string, string]> } {
  const set: Gold = new Set(); const values = new Map<string, [string, string]>();
  for (const [slug, a] of after) {
    const b = before.get(slug);
    if (!b) {
      set.add(`page|${slug}||added`);
      for (const c of a.facts.keys()) set.add(`fact|${slug}|${c}|added`);
      for (const c of a.takes.keys()) set.add(`take|${slug}|${c}|added`);
      continue;
    }
    for (const [kind, x, y] of [['fact', b.facts, a.facts], ['take', b.takes, a.takes]] as const) {
      for (const [c, v] of y) {
        if (!x.has(c)) set.add(`${kind}|${slug}|${c}|added`);
        else if (x.get(c) !== v) { set.add(`${kind}|${slug}|${c}|changed`); values.set(`${kind}|${slug}|${c}`, [x.get(c)!, v]); }
      }
      for (const c of x.keys()) if (!y.has(c)) set.add(`${kind}|${slug}|${c}|removed`);
    }
    for (const l of a.links) if (!b.links.has(l)) set.add(`link|${slug}|${l}|added`);
    for (const l of b.links) if (!a.links.has(l)) set.add(`link|${slug}|${l}|removed`);
  }
  return { set, values };
}

const at = async (b: BeliefBrain) => { await new Promise(r => setTimeout(r, 25)); const t = new Date((await b.engine.executeRaw<{ t: string }>('SELECT clock_timestamp() AS t'))[0]!.t).toISOString(); await new Promise(r => setTimeout(r, 25)); return t; };

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger weekly change probes (${engineCase.name})`, () => {
    test('four synthetic weeks: set-F1 >= 0.95, exact before/after, tokens against the page list', () => beliefBrain(async b => {
      const rand = rng(20261016);
      const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
      const scores = ['0.5', '0.6', '0.7', '0.8', '0.9'];
      let n = 0;
      const brain = new Map<string, PageState>();
      const write = async (slug: string, p: PageState) => { await b.put(slug, render(slug, p)); brain.set(slug, clone(p)); };
      for (let i = 0; i < 6; i++) {
        const slug = `companies/co-${i}`;
        await write(slug, { facts: new Map([[`Company ${i} fact ${n++}`, '0.7'], [`Company ${i} fact ${n++}`, '0.8']]), takes: new Map([[`Company ${i} take ${n++}`, '0.5']]), links: new Set() });
      }
      const report: Array<Record<string, number>> = [];
      let tp = 0, fp = 0, fn = 0;
      for (let week = 0; week < 4; week++) {
        const start = new Map([...brain].map(([k, v]) => [k, clone(v)]));
        const t0 = await at(b);
        for (let op = 0; op < 10; op++) {
          const slugs = [...brain.keys()];
          const slug = pick(slugs);
          const p = clone(brain.get(slug)!);
          const roll = rand();
          if (roll < 0.15) { p.facts.set(`${slug} fact ${n++}`, pick(scores)); }
          else if (roll < 0.3 && p.facts.size > 1) { p.facts.delete(pick([...p.facts.keys()])); }
          else if (roll < 0.45 && p.facts.size) { const c = pick([...p.facts.keys()]); p.facts.set(c, pick(scores.filter(s => s !== p.facts.get(c)))); }
          else if (roll < 0.55) { p.takes.set(`${slug} take ${n++}`, pick(scores)); }
          else if (roll < 0.65 && p.takes.size) { const c = pick([...p.takes.keys()]); p.takes.set(c, pick(scores.filter(s => s !== p.takes.get(c)))); }
          else if (roll < 0.75) { const target = pick(slugs.filter(s => s !== slug)); if (p.links.has(target)) p.links.delete(target); else p.links.add(target); }
          else if (roll < 0.85) {
            const fresh = `companies/new-${week}-${op}`;
            await write(fresh, { facts: new Map([[`${fresh} fact ${n++}`, '0.6']]), takes: new Map([[`${fresh} take ${n++}`, '0.4']]), links: new Set([slug]) });
            continue;
          } else {
            // An edit reverted inside the week nets to nothing.
            const c = `${slug} transient ${n++}`;
            await b.put(slug, render(slug, { ...p, facts: new Map([...p.facts, [c, '0.5']]) }));
          }
          await write(slug, p);
        }
        const t1 = await at(b);
        const expected = gold(start, brain);
        const diff = await beliefChanges(b.engine, { sourceId: b.sourceId, since: t0, until: t1, remote: false, limit: 10_000 });
        const got = new Set(diff.changes.filter(c => c.kind !== 'link_transition').map(c => {
          const belief = c.kind === 'page' ? '' : c.kind === 'link' ? String(c.subject.to) : String(c.subject.claim);
          return `${c.kind}|${c.slug}|${belief}|${c.change}`;
        }));
        const hit = [...got].filter(x => expected.set.has(x)).length;
        tp += hit; fp += got.size - hit; fn += expected.set.size - hit;
        // Every gold re-score is reported as changed with its exact before and after, and nothing else is.
        const rescored = Object.fromEntries(diff.changes.filter(c => c.change === 'changed' && (c.kind === 'fact' || c.kind === 'take')).map(c => {
          const field = c.kind === 'fact' ? 'confidence' : 'weight';
          return [`${c.kind}|${c.slug}|${c.subject.claim}`, [Number(c.before![field]), Number(c.after![field])]];
        }));
        expect(rescored).toEqual(Object.fromEntries([...expected.values].map(([k, v]) => [k, v.map(Number)])));
        await new Promise(r => setTimeout(r, 2_200));
        const delta = await operationsByName.delta!.handler(b.ctx, { since: t0 }) as { pages: unknown[]; text: string };
        const beliefText = diff.changes.map(renderBeliefChange).join('\n');
        report.push({ week, gold: expected.set.size, reported: got.size, matched: hit, page_list_pages: delta.pages.length,
          page_list_tokens: estimateTokens(delta.text), belief_diff_tokens: estimateTokens(beliefText) });
      }
      const precision = tp / (tp + fp), recall = tp / (tp + fn), f1 = 2 * precision * recall / (precision + recall);
      console.log(`[w4-weekly-probe] ${engineCase.name} ${JSON.stringify({ f1: Number(f1.toFixed(4)), precision: Number(precision.toFixed(4)), recall: Number(recall.toFixed(4)), tp, fp, fn, weeks: report })}`);
      expect(f1).toBeGreaterThanOrEqual(0.95);
    }, { managed: true, databaseUrl: engineCase.databaseUrl }), 300_000);
  });
}
