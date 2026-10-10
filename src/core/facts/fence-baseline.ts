import type { BrainEngine } from '../engine.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';

/** Recover missing file bytes only from a losslessly rendered, source-scoped snapshot. */
export async function readFenceBaseline(engine: BrainEngine, slug: string, sourceId: string) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot) return { body: null, revision: null };
  const body = serializePageToMarkdown(snapshot.page, snapshot.tags);
  const parsed = parseMarkdown(body, `${slug}.md`);
  // The renderer/parser can reinterpret a sentinel embedded in DB-only prose.
  // Refuse that shape rather than let the later body mirror destroy content.
  if (parsed.compiled_truth.trim() !== (snapshot.page.compiled_truth ?? '').trim()
    || parsed.timeline.trim() !== (snapshot.page.timeline ?? '').trim()) {
    throw new Error('facts_baseline_roundtrip_changed_content');
  }
  return { body, revision: snapshot.revision };
}

/** Recheck a recovered baseline before publishing the candidate file. */
export async function assertFenceBaseline(engine: BrainEngine, slug: string, sourceId: string, revision: string | null) {
  const current = await engine.readPageSnapshot(slug, { sourceId });
  if ((current?.revision ?? null) !== revision) throw new Error('facts_baseline_changed');
}
