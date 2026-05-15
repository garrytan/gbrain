/**
 * v0.34 pre-w0 — retrieval strategies for the code-retrieval eval.
 *
 * Two strategies ship in the pre-w0 PR:
 *   - baseline: query + search via hybridSearch (today's gbrain)
 *   - with-code-intel: code_blast / code_flow / code_def / etc.
 *
 * The with-code-intel strategy is a stub until v0.34 W3 lands; the harness
 * runs against it and produces a meaningful "what does v0.34 need to beat"
 * number purely from the baseline. After W3 lands, the stub fills in and
 * the gate becomes a real comparison.
 *
 * Strategies are split into their own module so the harness module stays
 * engine-free and unit-testable.
 */

import type { BrainEngine } from '../../core/engine.ts';
import { hybridSearch } from '../../core/search/hybrid.ts';
import type { CodeQuestion, RetrievalStrategy } from './harness.ts';

// ─────────────────────────────────────────────────────────────────
// Baseline: hybridSearch over the same brain
// ─────────────────────────────────────────────────────────────────

export class BaselineStrategy implements RetrievalStrategy {
  readonly mode = 'baseline' as const;

  constructor(private readonly engine: BrainEngine, private readonly sourceId: string) {}

  async retrieve(q: CodeQuestion, k: number): Promise<{ files: string[]; latency_ms: number }> {
    const t0 = Date.now();
    // Query string is the natural-language question. hybridSearch returns
    // chunks; we collapse to unique file paths in rank order.
    const results = await hybridSearch(this.engine, q.query, {
      limit: Math.max(k * 3, 10), // overshoot to get distinct files
      strategy: 'hybrid',
      expand: false, // deterministic; no multi-query expansion
    } as any);
    const latency_ms = Date.now() - t0;
    const filesSeen = new Set<string>();
    const files: string[] = [];
    for (const r of results) {
      const path = pickFilePath(r);
      if (!path) continue;
      if (filesSeen.has(path)) continue;
      filesSeen.add(path);
      files.push(path);
      if (files.length >= k) break;
    }
    return { files, latency_ms };
  }
}

// ─────────────────────────────────────────────────────────────────
// With-code-intel: code_blast / code_flow / etc.
//
// Until v0.34 W3 lands, this strategy falls through to a noop that
// returns zero results. The eval harness handles empty results as
// "question not answered" — which is the truth pre-W3.
// ─────────────────────────────────────────────────────────────────

export class WithCodeIntelStrategy implements RetrievalStrategy {
  readonly mode = 'with-code-intel' as const;

  constructor(private readonly engine: BrainEngine, private readonly sourceId: string) {}

  async retrieve(q: CodeQuestion, k: number): Promise<{ files: string[]; latency_ms: number }> {
    const t0 = Date.now();
    // STUB: post-v0.34 W3 ships actual op handlers; until then, this strategy
    // returns nothing. The harness records this as "answered: false" which
    // is the honest pre-W3 baseline for this mode.
    //
    // When W3 lands, this method dispatches by question kind:
    //   q.kind === 'callers' / 'blast_radius' → call code_blast op
    //   q.kind === 'callees' / 'execution_flow' → call code_flow op
    //   q.kind === 'definition' → call code_def op (MCP-exposed in W3)
    //   q.kind === 'references' → call code_refs op
    //   q.kind === 'cluster_membership' → call code_cluster_get op
    //
    // For now: noop.
    const latency_ms = Date.now() - t0;
    return { files: [], latency_ms };
  }
}

// ─────────────────────────────────────────────────────────────────
// File-path extraction from a search result
//
// Brain pages of kind 'code' carry the file path as the slug suffix
// (e.g. slug `code/src/core/markdown.ts`). For non-code pages, we
// skip — the eval is about code retrieval.
// ─────────────────────────────────────────────────────────────────

function pickFilePath(result: any): string | null {
  if (!result?.slug) return null;
  const slug: string = result.slug;
  if (slug.startsWith('code/')) {
    return slug.slice('code/'.length);
  }
  // Some code pages may sit under different prefixes depending on source
  // config; for now, only handle the canonical 'code/' prefix.
  return null;
}
