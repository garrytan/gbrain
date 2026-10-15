import { expect, test } from 'bun:test';
import { hydraHits, hydraRelatedHits, hydraMarkdown, attachHydraMarkdown, markdownForHydraRows, carryHydraRenderers } from '../src/core/hydradb-response.ts';

const source = (id: string) => ({ id, title: `Source ${id}`, additional_metadata: { gbrain_source: 'public-fixtures', gbrain_slug: `notes/${id}` } });

test('unified response evidence retains enrichment, dated facts and graph support', () => {
  const response = { sources: [source('a'), source('b')], chunks: [
    { context_id: 'a', chunk_id: 'ca', content: 'Primary passage.', enrichment: 'Authorized enrichment.', temporal: [{ content: 'The meeting is Thursday.' }] },
    { context_id: 'b', chunk_id: 'cb', content: 'Supporting passage.' }],
    graph: [{ path_summary: 'Authorized relation.', triplets: [{ source: { name: 'Meeting' }, target: { name: 'Thursday' }, relation: { chunk_id: 'ca', predicate: 'scheduled_for', context: 'Primary evidence.' } },
      { source: { name: 'Owner' }, target: { name: 'Team' }, relation: { chunk_id: 'cb', predicate: 'belongs_to', context: 'Supporting evidence.' } }] }] };
  const hits = hydraHits(response);
  const text = hydraMarkdown(hits[0]!, hits[0]!.text, new Set(['ca', 'cb', 'a', 'b']), hits);
  for (const marker of ['Authorized enrichment.', 'The meeting is Thursday.', 'Authorized relation.', 'Supporting passage.']) expect(text).toContain(marker);
  const filtered = hydraMarkdown(hits[0]!, hits[0]!.text, new Set(['ca', 'a']), hits);
  expect(filtered).not.toContain('Authorized relation.');
  expect(filtered).not.toContain('Supporting passage.');
});

test('foreign auxiliary evidence blocks whole Markdown even when primary chunks are allowed', () => {
  const response = { sources: [source('a')], chunks: [{ id: 'a', chunk_uuid: 'ca', chunk_content: 'Public passage.' }],
    forceful_relations: { declared: [{ chunk: { id: 'foreign', chunk_uuid: 'secret', chunk_content: 'PRIVATE_AUXILIARY' } }] }, llm_prompt: 'PRIVATE_CANONICAL' };
  const hits = hydraHits(response), related = hydraRelatedHits(response);
  const rows = [{ title: 'Allowed', chunk_text: 'Public passage.' }];
  attachHydraMarkdown(rows, hits, related, new Set(['ca', 'a']), hits);
  expect(markdownForHydraRows(rows)).not.toContain('PRIVATE_');
});

test('post-retrieval redaction, truncation and budget disable whole server Markdown', () => {
  const response = { sources: [source('a')], chunks: [{ id: 'a', chunk_uuid: 'ca', chunk_content: 'Full evidence.' }], llm_prompt: 'WHOLE_SERVER_PROMPT' };
  const hits = hydraHits(response), rows = [{ title: 'Allowed', chunk_text: 'Full evidence.' }];
  attachHydraMarkdown(rows, hits, [], new Set(['ca', 'a']), hits);
  expect(markdownForHydraRows(rows)).toBe('WHOLE_SERVER_PROMPT');
  expect(markdownForHydraRows([{ title: 'Allowed', chunk_text: 'Redacted evidence.' }], rows)).not.toContain('WHOLE_SERVER_PROMPT');
  expect(markdownForHydraRows(rows, rows, true)).toBe('Full evidence.');
  expect(markdownForHydraRows([], rows)).not.toContain('WHOLE_SERVER_PROMPT');
});

test('expanded evidence respects stale revisions and explicit presentation budgets', () => {
  const response = { sources: [source('a')], chunks: [{ id: 'a', chunk_uuid: 'ca', chunk_content: 'Ranked passage.',
    additional_metadata: { ...source('a').additional_metadata, gbrain_revision: 'revision-one' } }],
    graph_context: { query_paths: [{ source_chunk_ids: ['ca'], combined_context: 'ORIGINAL_GRAPH', triplets: [] }] } };
  const hits = hydraHits(response);
  const original = [{ slug: 'notes/a', source_id: 'public-fixtures', chunk_id: 1, title: 'Source a', chunk_text: 'Ranked passage.' }];
  attachHydraMarkdown(original, hits, [], new Set(['a', 'ca']), hits);
  const expanded = [{ ...original[0], chunk_text: 'Authoritative full page.', delivered: { unit: 'page', revision: 'revision-one', truncated: false } }];
  carryHydraRenderers(expanded as never, original as never);
  expect(markdownForHydraRows(expanded)).toContain('ORIGINAL_GRAPH');
  expect(markdownForHydraRows(expanded, expanded, true)).toBe('Authoritative full page.');
  expanded[0]!.delivered.revision = 'revision-two';
  expect(markdownForHydraRows(expanded)).not.toContain('ORIGINAL_GRAPH');
  expect(markdownForHydraRows(expanded)).toContain('Authoritative full page.');
});
