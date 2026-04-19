/**
 * BrainBench — per-link-type accuracy on the 240-page rich-prose corpus.
 *
 * This is the measurement tool for v0.10.5+ extraction work. It:
 *   1. Loads all pages from eval/data/world-v1/
 *   2. Derives GOLD expected links per page from `_facts` metadata
 *      (founders → founded, investors → invested_in, advisors → advises,
 *       employees → works_at, attendees → attended, primary_affiliation →
 *       works_at or founded based on role)
 *   3. Runs extractPageLinks on each page → INFERRED links
 *   4. Compares gold vs inferred per link type:
 *       - correctly_typed: gold (src, tgt) exists AND inferred type matches
 *       - mistyped:         gold (src, tgt) exists AND inferred type differs
 *       - missed:           gold (src, tgt) exists AND no inferred edge
 *       - spurious:         inferred (src, tgt) with no gold edge at all
 *
 * Emits a per-link-type table with type accuracy per type + overall.
 * Headline metric: TYPE ACCURACY = correctly_typed / (correctly_typed + mistyped)
 * conditional on the edge being found at all (excludes missed).
 *
 * Also emits a COMBINED metric: F1 per link type treating type as part of
 * the identity — (src, tgt, type) triple must match. Catches both the
 * extraction-recall problem and the type-accuracy problem in one number.
 *
 * Usage: bun eval/runner/type-accuracy.ts [--json]
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { extractPageLinks } from '../../src/core/link-extraction.ts';
import type { PageType } from '../../src/core/types.ts';

interface RichPage {
  slug: string;
  type: 'person' | 'company' | 'meeting' | 'concept';
  title: string;
  compiled_truth: string;
  timeline: string;
  _facts: {
    type: string;
    name?: string;
    role?: string;
    industry?: string;
    primary_affiliation?: string;
    secondary_affiliations?: string[];
    founders?: string[];
    employees?: string[];
    investors?: string[];
    advisors?: string[];
    attendees?: string[];
    related_companies?: string[];
  };
}

interface GoldEdge {
  from: string;
  to: string;
  type: string;
}

/** Load all rich-prose pages from the world-v1 shard directory. */
function loadCorpus(dir: string): RichPage[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const out: RichPage[] = [];
  for (const f of files) {
    const p = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
    if (Array.isArray(p.timeline)) p.timeline = p.timeline.join('\n');
    if (Array.isArray(p.compiled_truth)) p.compiled_truth = p.compiled_truth.join('\n\n');
    p.title = String(p.title ?? '');
    p.compiled_truth = String(p.compiled_truth ?? '');
    p.timeline = String(p.timeline ?? '');
    out.push(p as RichPage);
  }
  return out;
}

/**
 * Derive the gold edge set from `_facts` metadata. Only edges where both
 * endpoints are real pages in the corpus count (FK-constraint style).
 *
 * Rules:
 *   company.founders  -> founded (person -> company)
 *   company.employees -> works_at (person -> company)
 *   company.investors -> invested_in (person -> company)
 *   company.advisors  -> advises (person -> company)
 *   meeting.attendees -> attended (person -> meeting)
 *   person.primary_affiliation + role=founder       -> founded
 *   person.primary_affiliation + role∈{engineer,...}-> works_at
 *   person.primary_affiliation + role=advisor       -> advises
 *   person.primary_affiliation + role=investor/partner -> invested_in
 *   person.secondary_affiliations + role=advisor    -> advises
 */
function buildGoldEdges(pages: RichPage[]): GoldEdge[] {
  const existing = new Set(pages.map(p => p.slug));
  const edges: GoldEdge[] = [];
  const push = (from: string, to: string, type: string) => {
    if (!existing.has(from) || !existing.has(to)) return;
    if (from === to) return;
    edges.push({ from, to, type });
  };

  // Company-page -> incoming edges from people referenced in _facts arrays.
  for (const p of pages) {
    if (p._facts.type === 'company') {
      for (const f of p._facts.founders ?? []) push(f, p.slug, 'founded');
      for (const e of p._facts.employees ?? []) {
        // Avoid double-labeling: if e is also a founder, prefer founded (more specific).
        if ((p._facts.founders ?? []).includes(e)) continue;
        push(e, p.slug, 'works_at');
      }
      for (const i of p._facts.investors ?? []) push(i, p.slug, 'invested_in');
      for (const a of p._facts.advisors ?? []) push(a, p.slug, 'advises');
    }
    if (p._facts.type === 'meeting') {
      // Direction: extractPageLinks on a meeting page produces
      // (meeting_slug, person_slug, 'attended') because the person slugs
      // appear as entity refs inside the meeting page's content. Match that
      // direction in the gold so (from, to) pairs align with the inferred set.
      for (const a of p._facts.attendees ?? []) push(p.slug, a, 'attended');
    }
  }

  // Person-page -> outgoing primary_affiliation + secondaries.
  for (const p of pages) {
    if (p._facts.type !== 'person') continue;
    const role = (p._facts.role ?? '').toLowerCase();
    const primary = p._facts.primary_affiliation;
    if (primary && existing.has(primary)) {
      if (['founder', 'co-founder'].includes(role)) push(p.slug, primary, 'founded');
      else if (role === 'advisor') push(p.slug, primary, 'advises');
      else if (['partner', 'investor', 'vc'].includes(role)) push(p.slug, primary, 'invested_in');
      else push(p.slug, primary, 'works_at');
    }
    for (const sec of p._facts.secondary_affiliations ?? []) {
      if (!existing.has(sec)) continue;
      // Secondary affiliations are typically advisory / board work.
      if (role === 'advisor') push(p.slug, sec, 'advises');
      else if (['partner', 'investor', 'vc'].includes(role)) push(p.slug, sec, 'invested_in');
      else push(p.slug, sec, 'mentions');
    }
  }

  // Dedup (same from/to/type edge could be added via multiple rules).
  const seen = new Set<string>();
  const dedup: GoldEdge[] = [];
  for (const e of edges) {
    const k = `${e.from}\u0000${e.to}\u0000${e.type}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(e);
  }
  return dedup;
}

/** Run extractPageLinks on every page; return flat list of inferred edges. */
function inferAllEdges(pages: RichPage[]): GoldEdge[] {
  const edges: GoldEdge[] = [];
  for (const p of pages) {
    const content = `${p.title}\n\n${p.compiled_truth}\n\n${p.timeline}`;
    const candidates = extractPageLinks(content, {}, p.type as PageType);
    for (const c of candidates) {
      edges.push({ from: p.slug, to: c.targetSlug, type: c.linkType });
    }
  }
  return edges;
}

interface PerTypeResult {
  linkType: string;
  gold: number;
  correctly_typed: number;  // gold edge present AND inferred type matches
  mistyped: number;         // gold edge present AND inferred type differs
  missed: number;           // gold edge present AND no inferred edge
  spurious: number;         // inferred edge (this type) with no matching gold (any type) for (from, to)
  type_accuracy: number;    // correctly_typed / (correctly_typed + mistyped)  [conditional on finding the edge]
  recall: number;           // correctly_typed / gold
  precision: number;        // correctly_typed / (correctly_typed + spurious_this_type_and_mistyped_from_other_types_into_this_type)
  f1_strict: number;        // F1 where (from, to, type) triple must match exactly
}

interface ConfusionMatrix {
  // matrix[goldType][inferredType] = count
  [goldType: string]: Record<string, number>;
}

function score(gold: GoldEdge[], inferred: GoldEdge[]): {
  perType: PerTypeResult[];
  confusion: ConfusionMatrix;
  overallTypeAccuracy: number;
  overallStrictF1: number;
} {
  // Index gold by (from, to) pair — regardless of type.
  const goldByPair = new Map<string, string>();  // key: from\u0000to → type
  for (const g of gold) {
    goldByPair.set(`${g.from}\u0000${g.to}`, g.type);
  }

  // Index inferred by (from, to, type).
  const inferredByPair = new Map<string, string>();
  for (const i of inferred) {
    const key = `${i.from}\u0000${i.to}`;
    // Keep the first inferred type for each pair; extractPageLinks already dedupes by (targetSlug, linkType).
    if (!inferredByPair.has(key)) {
      inferredByPair.set(key, i.type);
    }
  }

  const linkTypes = new Set<string>();
  for (const g of gold) linkTypes.add(g.type);
  for (const i of inferred) linkTypes.add(i.type);

  // Build confusion matrix: gold type → inferred type counts.
  const confusion: ConfusionMatrix = {};
  for (const t of linkTypes) confusion[t] = {};

  for (const [pair, goldType] of goldByPair) {
    const inferredType = inferredByPair.get(pair) ?? '(missing)';
    confusion[goldType][inferredType] = (confusion[goldType][inferredType] ?? 0) + 1;
  }
  // Spurious edges (inferred without gold) tracked under '(no-gold)' rows.
  confusion['(no-gold)'] = {};
  for (const [pair, inferredType] of inferredByPair) {
    if (!goldByPair.has(pair)) {
      confusion['(no-gold)'][inferredType] = (confusion['(no-gold)'][inferredType] ?? 0) + 1;
    }
  }

  const perType: PerTypeResult[] = [];
  let overallCorrectlyTyped = 0;
  let overallFound = 0;
  let overallGold = 0;
  let overallInferredThisTypeOrMistyped = 0;
  // For overall strict F1:
  let overallStrictTP = 0;
  let overallStrictFP = 0;
  let overallStrictFN = 0;

  for (const t of linkTypes) {
    if (t === '(no-gold)' || t === '(missing)') continue;
    const goldCount = Object.values(confusion[t] ?? {}).reduce((a, b) => a + b, 0);
    const correctly_typed = confusion[t]?.[t] ?? 0;
    const missed = confusion[t]?.['(missing)'] ?? 0;
    const mistyped = goldCount - correctly_typed - missed;

    // Spurious for this type: inferred as this type, but gold had a different type OR no gold edge.
    let spurious = 0;
    // (a) inferred as t where gold was a DIFFERENT type: sum column t across other goldTypes
    for (const gt of Object.keys(confusion)) {
      if (gt === t || gt === '(missing)' || gt === '(no-gold)') continue;
      spurious += confusion[gt]?.[t] ?? 0;
    }
    // (b) inferred as t with no gold edge at all
    spurious += confusion['(no-gold)']?.[t] ?? 0;

    const found = correctly_typed + mistyped;  // edge found (any type) where gold existed
    const type_accuracy = found > 0 ? correctly_typed / found : 0;
    const recall = goldCount > 0 ? correctly_typed / goldCount : 0;
    const precisionDenom = correctly_typed + spurious;
    const precision = precisionDenom > 0 ? correctly_typed / precisionDenom : 0;
    const f1_strict =
      precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

    perType.push({
      linkType: t,
      gold: goldCount,
      correctly_typed,
      mistyped,
      missed,
      spurious,
      type_accuracy,
      recall,
      precision,
      f1_strict,
    });

    overallCorrectlyTyped += correctly_typed;
    overallFound += found;
    overallGold += goldCount;
    overallInferredThisTypeOrMistyped += correctly_typed + spurious;
    overallStrictTP += correctly_typed;
    overallStrictFN += mistyped + missed;  // gold edges not correctly-typed
    overallStrictFP += spurious;
  }

  const overallTypeAccuracy = overallFound > 0 ? overallCorrectlyTyped / overallFound : 0;
  const overallStrictPrecision =
    overallStrictTP + overallStrictFP > 0
      ? overallStrictTP / (overallStrictTP + overallStrictFP)
      : 0;
  const overallStrictRecall =
    overallStrictTP + overallStrictFN > 0
      ? overallStrictTP / (overallStrictTP + overallStrictFN)
      : 0;
  const overallStrictF1 =
    overallStrictPrecision + overallStrictRecall > 0
      ? (2 * overallStrictPrecision * overallStrictRecall) /
        (overallStrictPrecision + overallStrictRecall)
      : 0;

  // Sort perType by gold count descending (most common first).
  perType.sort((a, b) => b.gold - a.gold);

  return { perType, confusion, overallTypeAccuracy, overallStrictF1 };
}

function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

async function main() {
  const json = process.argv.includes('--json');
  const dir = process.argv.find(a => a.startsWith('--dir='))?.slice('--dir='.length) ??
    'eval/data/world-v1';
  const log = json ? () => {} : console.log;

  log('# BrainBench — type accuracy on rich-prose corpus\n');
  log(`Generated: ${new Date().toISOString().slice(0, 19)}`);
  log(`Corpus: ${dir}/`);

  const pages = loadCorpus(dir);
  log(`Loaded ${pages.length} pages.\n`);

  const gold = buildGoldEdges(pages);
  const inferred = inferAllEdges(pages);

  log(`Gold edges (from _facts):     ${gold.length}`);
  log(`Inferred edges (extractPageLinks): ${inferred.length}\n`);

  const { perType, confusion, overallTypeAccuracy, overallStrictF1 } = score(gold, inferred);

  log('## Per-link-type results\n');
  log('| Link type    | Gold | Correct | Mistyped | Missed | Spurious | Type acc | Recall | Prec   | F1 (strict) |');
  log('|--------------|------|---------|----------|--------|----------|----------|--------|--------|-------------|');
  for (const r of perType) {
    log(
      `| ${r.linkType.padEnd(12)} | ${String(r.gold).padStart(4)} | ${String(r.correctly_typed).padStart(7)} | ${String(r.mistyped).padStart(8)} | ${String(r.missed).padStart(6)} | ${String(r.spurious).padStart(8)} | ${pct(r.type_accuracy).padStart(8)} | ${pct(r.recall).padStart(6)} | ${pct(r.precision).padStart(6)} | ${pct(r.f1_strict).padStart(11)} |`,
    );
  }
  log('');
  log('**Columns:**');
  log('- *Type acc*: given the edge was found at all, was it typed correctly? `correct / (correct + mistyped)`.');
  log('- *Recall*: of gold edges, how many did we correctly find AND type? `correct / gold`.');
  log('- *Precision*: of edges we inferred as this type, how many were actually this type? `correct / (correct + spurious)`.');
  log('- *F1 (strict)*: strict `(from, to, type)` triple match. Catches both extraction-recall and type-accuracy misses in one number.\n');

  log('## Overall\n');
  log(`- Overall type accuracy (conditional on finding the edge): **${pct(overallTypeAccuracy)}**`);
  log(`- Overall strict F1 (triple match): **${pct(overallStrictF1)}**\n`);

  log('## Confusion matrix (rows = gold type, cols = inferred type)\n');
  const inferredCols = Array.from(
    new Set(
      Object.values(confusion).flatMap(row => Object.keys(row)),
    ),
  ).sort();
  const rowKeys = Object.keys(confusion).filter(k => k !== '(no-gold)').sort();
  rowKeys.push('(no-gold)');

  const header = ['gold \\ inferred', ...inferredCols];
  log('| ' + header.map(h => h.padEnd(14)).join(' | ') + ' |');
  log('|' + header.map(() => '----------------').join('|') + '|');
  for (const g of rowKeys) {
    if (!confusion[g]) continue;
    const row = [g, ...inferredCols.map(ic => String(confusion[g][ic] ?? 0))];
    log('| ' + row.map(v => v.padEnd(14)).join(' | ') + ' |');
  }
  log('');

  if (json) {
    console.log(JSON.stringify({
      overallTypeAccuracy,
      overallStrictF1,
      perType,
      confusion,
      goldTotal: gold.length,
      inferredTotal: inferred.length,
    }, null, 2));
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
