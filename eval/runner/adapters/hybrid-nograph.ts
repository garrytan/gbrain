/**
 * BrainBench EXT-3: Hybrid-without-graph adapter.
 *
 * gbrain's full hybrid search (vector + keyword + RRF fusion + dedup) but
 * with the knowledge-graph layer explicitly disabled. No auto_link, no
 * typed edges, no traverse_graph, no backlink boost. Just:
 *   - putPage each page
 *   - chunking + embedding (via existing put_page pipeline)
 *   - hybridSearch(engine, query) to answer queries
 *
 * This is the closest-to-gbrain external comparator. If gbrain-after beats
 * EXT-3 significantly, the delta MUST come from the graph layer (auto_link
 * typed edges + traversePaths + backlink boost), not from better vector
 * retrieval or hybrid fusion.
 *
 * It's also the MOST HONEST baseline — "gbrain without the new knowledge
 * graph layer" answers the question "does the graph do useful work?"
 * directly. Critics can't dismiss this as "you disabled a feature you knew
 * they'd want." Everyone already knows vector+keyword hybrid is strong.
 */

import type { Adapter, AdapterConfig, BrainState, Page, Query, RankedDoc } from '../types.ts';
import { PGLiteEngine } from '../../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../../src/core/search/hybrid.ts';
import { importFromContent } from '../../../src/core/import-file.ts';

// Known-safe config: auto_link OFF at the engine layer via direct setConfig
// call. Does NOT run `extract --source db`, so typed links stay empty even
// if auto_link flipped on during put_page (belt + suspenders).

interface HybridNoGraphState {
  engine: PGLiteEngine;
}

interface HybridNoGraphConfig extends AdapterConfig {
  /** Top-K results requested from hybridSearch. Defaults to 20 so the
   *  scorer's k=5 slice has headroom. */
  limit?: number;
}

export class HybridNoGraphAdapter implements Adapter {
  readonly name = 'hybrid-nograph';

  async init(rawPages: Page[], _config: HybridNoGraphConfig): Promise<BrainState> {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    // Belt: turn off auto_link at the engine config level. Suspenders below:
    // we also skip extract --source db, so even if auto_link did fire, no
    // typed edges would exist in the graph layer. This adapter doesn't call
    // traversePaths at all, so graph state is doubly-ignored.
    await engine.setConfig('auto_link', 'false');

    // importFromContent does the chunking + embedding that hybridSearch needs.
    // Plain putPage() just writes the page row without any search infra; that's
    // fine for graph-based adapters but leaves hybridSearch with nothing to
    // rank. Silence its stdout noise during benchmark runs.
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      for (const p of rawPages) {
        const content = this.buildContentMarkdown(p);
        await importFromContent(engine, p.slug, content);
      }
    } finally {
      console.log = origLog;
      console.error = origErr;
    }

    // INTENTIONALLY do NOT call runExtract — that's what populates typed
    // links + timeline for the graph layer. Without it, traversePaths
    // would return empty. hybridSearch works entirely off chunks +
    // embeddings, which importFromContent just populated.
    return { engine } satisfies HybridNoGraphState;
  }

  async teardown(state: BrainState): Promise<void> {
    const s = state as HybridNoGraphState;
    await s.engine.disconnect();
  }

  /** Build a markdown string importFromContent can parse.
   *  Format: YAML frontmatter then body; matches what gbrain import expects. */
  private buildContentMarkdown(p: Page): string {
    const fm: string[] = [];
    fm.push(`---`);
    fm.push(`type: ${p.type}`);
    fm.push(`title: ${JSON.stringify(p.title)}`);
    fm.push(`---`);
    fm.push('');
    fm.push(`# ${p.title}`);
    fm.push('');
    fm.push(p.compiled_truth);
    if (p.timeline && p.timeline.trim().length > 0) {
      fm.push('');
      fm.push('## Timeline');
      fm.push('');
      fm.push(p.timeline);
    }
    return fm.join('\n');
  }

  async query(q: Query, state: BrainState): Promise<RankedDoc[]> {
    const s = state as HybridNoGraphState;
    const limit = 20;

    // hybridSearch returns chunks with scores. We aggregate to page-level
    // by taking each page's BEST chunk score and ranking pages by that.
    const chunkResults = await hybridSearch(s.engine, q.text, { limit: limit * 3 });

    const pageBest = new Map<string, number>();
    for (const r of chunkResults) {
      const existing = pageBest.get(r.slug);
      if (existing === undefined || r.score > existing) {
        pageBest.set(r.slug, r.score);
      }
    }
    const pageScored = Array.from(pageBest.entries())
      .map(([slug, score]) => ({ slug, score }))
      .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
      .slice(0, limit);

    return pageScored.map((p, i) => ({
      page_id: p.slug,
      score: p.score,
      rank: i + 1,
    }));
  }

  async snapshot(_state: BrainState): Promise<string> {
    return '';
  }
}

export function createHybridNoGraph(): HybridNoGraphAdapter {
  return new HybridNoGraphAdapter();
}
