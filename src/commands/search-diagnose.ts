/**
 * `gbrain search diagnose "<query>" --target <slug> [--json] [--source <id>]`
 * (T0 — Phase-0 retrieval diagnostic).
 *
 * Traces WHERE a target page surfaces (or fails to) across the retrieval
 * pipeline, so an operator can pin which layer is responsible for an incident
 * like "Greek amphitheater missed the Mingtang page":
 *
 *   keyword  — rank + score of the target in searchKeyword (ts_rank path)
 *   vector   — rank + score of the target in searchVector (per-page max-pool);
 *              best-chunk cosine; skipped if no embedding provider
 *   alias    — is the normalized query a registered page_aliases alias of the target?
 *   hybrid   — final rank + evidence + create_safety + which boosts fired
 *
 * The verdict names the layer that DOES surface the target (or "none"), which
 * tells you whether the fix is max-pool/innerLimit (vector) vs title/alias.
 */

import type { BrainEngine } from '../core/engine.ts';
import { hybridSearch } from '../core/search/hybrid.ts';
import { normalizeAlias } from '../core/search/alias-normalize.ts';

interface LayerProbe {
  rank: number | null;     // 1-based rank of the target, null if absent
  score: number | null;
  top_slug: string | null;
  note?: string;
}

function rankOf(slugs: string[], target: string): number | null {
  const i = slugs.indexOf(target);
  return i >= 0 ? i + 1 : null;
}

export async function runSearchDiagnose(engine: BrainEngine, args: string[]): Promise<void> {
  const json = args.includes('--json');
  const targetIdx = args.indexOf('--target');
  const target = targetIdx >= 0 ? args[targetIdx + 1] : undefined;
  const sourceIdx = args.indexOf('--source');
  const sourceId = sourceIdx >= 0 ? args[sourceIdx + 1] : undefined;
  // 'diagnose' is args[0]; the query is the first non-flag token after it.
  const query = args.slice(1).find((a, i) => !a.startsWith('--') && args.slice(1)[i - 1] !== '--target' && args.slice(1)[i - 1] !== '--source');

  if (!query || !target) {
    console.error('Usage: gbrain search diagnose "<query>" --target <slug> [--json] [--source <id>]');
    process.exit(2);
  }

  const scope = sourceId ? { sourceId } : {};
  const limit = 50;

  // Keyword layer.
  const kw = await engine.searchKeyword(query, { limit, ...scope });
  const keyword: LayerProbe = {
    rank: rankOf(kw.map(r => r.slug), target),
    score: kw.find(r => r.slug === target)?.score ?? null,
    top_slug: kw[0]?.slug ?? null,
  };

  // Vector layer (skip if no embedding provider).
  let vector: LayerProbe;
  const { isAvailable, embedQuery } = await import('../core/ai/gateway.ts');
  if (!isAvailable('embedding')) {
    vector = { rank: null, score: null, top_slug: null, note: 'skipped — no embedding provider configured' };
  } else {
    try {
      const qvec = await embedQuery(query);
      const vec = await engine.searchVector(qvec, { limit, ...scope });
      vector = {
        rank: rankOf(vec.map(r => r.slug), target),
        score: vec.find(r => r.slug === target)?.score ?? null,
        top_slug: vec[0]?.slug ?? null,
      };
    } catch (e) {
      vector = { rank: null, score: null, top_slug: null, note: `vector probe failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // Alias layer.
  const qNorm = normalizeAlias(query);
  let aliasMatch = false;
  try {
    const m = await engine.resolveAliases([qNorm], scope);
    aliasMatch = (m.get(qNorm) ?? []).some(r => r.slug === target);
  } catch { /* pre-v110: no alias layer */ }

  // Hybrid layer (the production path).
  const hy = await hybridSearch(engine, query, { limit, ...scope });
  const hyTarget = hy.find(r => r.slug === target);
  const hybrid = {
    rank: rankOf(hy.map(r => r.slug), target),
    score: hyTarget?.score ?? null,
    base_score: hyTarget?.base_score ?? null,
    evidence: hyTarget?.evidence ?? null,
    create_safety: hyTarget?.create_safety ?? null,
    title_match_boost: hyTarget?.title_match_boost ?? null,
    alias_hit: hyTarget?.alias_hit ?? false,
    top_slug: hy[0]?.slug ?? null,
  };

  // Verdict: which layer surfaces the target at rank 1?
  const surfacing: string[] = [];
  if (keyword.rank === 1) surfacing.push('keyword');
  if (vector.rank === 1) surfacing.push('vector');
  if (aliasMatch) surfacing.push('alias');
  if (hybrid.rank === 1) surfacing.push('hybrid(final)');
  const verdict = hybrid.rank === 1
    ? `target is rank 1 in hybrid (via: ${surfacing.join(', ') || 'unknown'})`
    : hybrid.rank
      ? `target is rank ${hybrid.rank} in hybrid — NOT rank 1. Strongest layer: ${surfacing.join(', ') || 'none'}`
      : `target ABSENT from hybrid top-${limit}. keyword rank=${keyword.rank ?? 'absent'}, vector rank=${vector.rank ?? 'absent'}, alias=${aliasMatch}`;

  const report = { query, target, source_id: sourceId ?? 'default', keyword, vector, alias_match: aliasMatch, hybrid, verdict };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Diagnose: "${query}"  →  target ${target}\n`);
  console.log(`  keyword:  rank=${keyword.rank ?? 'absent'}  score=${fmt(keyword.score)}  (top: ${keyword.top_slug ?? '—'})`);
  console.log(`  vector:   rank=${vector.rank ?? 'absent'}  score=${fmt(vector.score)}  (top: ${vector.top_slug ?? '—'})${vector.note ? `  [${vector.note}]` : ''}`);
  console.log(`  alias:    ${aliasMatch ? 'query IS a registered alias of the target' : 'no alias match'}`);
  console.log(`  hybrid:   rank=${hybrid.rank ?? 'absent'}  score=${fmt(hybrid.score)}  base=${fmt(hybrid.base_score)}  evidence=${hybrid.evidence ?? '—'}  create_safety=${hybrid.create_safety ?? '—'}`);
  console.log(`            boosts: title=${hybrid.title_match_boost ?? '—'}  alias_hit=${hybrid.alias_hit}`);
  console.log(`\n  VERDICT: ${verdict}`);
}

function fmt(n: number | null): string {
  return n === null ? '—' : n.toFixed(4);
}
