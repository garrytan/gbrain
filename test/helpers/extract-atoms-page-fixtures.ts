import type { BrainEngine } from '../../src/core/engine.ts';
import { runPhaseExtractAtoms, type ExtractAtomsOpts } from '../../src/core/cycle/extract-atoms.ts';

export async function runPhaseWithStoredPageFixtures(engine: BrainEngine, opts: ExtractAtomsOpts = {}) {
  const sourceId = opts.sourceId ?? 'default';
  for (const page of opts._pages ?? []) {
    const stored = await engine.getPage(page.slug, { sourceId })
      ?? await engine.putPage(page.slug, { type: 'note', title: page.slug, compiled_truth: page.content, timeline: '' }, { sourceId });
    await engine.executeRaw(`UPDATE pages SET compiled_truth=$1, content_hash=$2, slug=$4 WHERE source_id=$3 AND id=$5`,
      [page.content, page.contentHash, sourceId, page.slug, stored.id]);
  }
  return runPhaseExtractAtoms(engine, opts);
}
