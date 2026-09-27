import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { OperationError } from '../ops/contract.ts';
import { renderTimelineEntry, spliceTimelineBlock } from '../timeline-write-through.ts';
import { extractTimelineFromContent } from '../timeline-extract.ts';
import { preparePageMutation } from './page-prepare.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';
import { assertPageRevision } from '../page-state/types.ts';
import { engineMutationPrecondition, parseMutationPrecondition } from './preconditions.ts';

function hasExactBlock(text: string, block: string): boolean {
  const wanted = block.trimEnd().split('\n');
  const lines = text.split('\n');
  return lines.some((_, index) => wanted.every((line, offset) => lines[index + offset] === line));
}
export async function prepareSemanticPageMutation(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || snapshot.page.id !== row.page_id) throw new OperationError('page_identity_changed', 'The accepted page no longer exists.');
  const p = row.intent!;
  if (p.expected_revision !== undefined) assertPageRevision(snapshot,engineMutationPrecondition(parseMutationPrecondition(p)));
  if (row.operation === 'add_tag' || row.operation === 'remove_tag') {
    if (typeof p.tag !== 'string' || !p.tag.trim()) throw new OperationError('invalid_params', 'A tag must be nonempty.');
    const tag = p.tag.trim();
    const tags = row.operation === 'add_tag' ? [...new Set([...snapshot.tags, tag])].sort() : snapshot.tags.filter(value => value !== tag);
    const prepared = await preparePageMutation(engine, row, config, {
      expectedRevision: snapshot.revision, tags, content: serializePageToMarkdown(snapshot.page, tags),
    });
    return { ...prepared, apply: async tx => ({ ...await prepared.apply(tx), status: 'ok', tag }) };
  }
  if (row.operation !== 'add_timeline_entry') throw new OperationError('writer_coordinator_required', 'This semantic writer has no registered preparation handler.');
  const entry = { date: String(p.date), summary: String(p.summary), source: String(p.source ?? ''), detail: String(p.detail ?? '') };
  const rendered = renderTimelineEntry(entry, row.slug);
  if (!rendered) throw new OperationError('invalid_params', 'The timeline entry cannot be represented losslessly in Markdown.');
  const exact = hasExactBlock(snapshot.page.timeline, rendered.block);
  const tuples = extractTimelineFromContent(`${snapshot.page.compiled_truth}\n<!-- timeline -->\n${snapshot.page.timeline}`, row.slug);
  if (!exact && tuples.some(tuple => tuple.date === rendered.canonical.date && tuple.source === rendered.canonical.source && tuple.summary === rendered.canonical.summary)) {
    throw new OperationError('invalid_params', 'This timeline identity already exists with different detail.', 'Read and conditionally edit the existing page to change that entry.');
  }
  const page = { ...snapshot.page, timeline: exact ? snapshot.page.timeline : spliceTimelineBlock(snapshot.page.timeline, entry.date, rendered.block) };
  const prepared = await preparePageMutation(engine, row, config, {
    expectedRevision: snapshot.revision, content: serializePageToMarkdown(page, snapshot.tags),
  });
  return { ...prepared, apply: async tx => {
    const outcome = await prepared.apply(tx);
    const inserted = await tx.addTimelineEntry(row.slug, { ...rendered.canonical, detail: rendered.detail }, { sourceId: row.source_id });
    return { ...outcome, status: exact && !inserted ? 'skipped' : 'ok', ...(exact && !inserted ? { reason: 'duplicate' } : {}), entry: rendered.canonical };
  } };
}
