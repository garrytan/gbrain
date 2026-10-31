/**
 * #7119: resolve_symbol_edges walks only chunks that own a code_edges_symbol
 * row. A source with no code edges (a markdown-only brain) gets no watermark
 * stamps, because each stamp is a non-HOT content_chunks update that rewrites
 * every index entry of the row. A code source still resolves and stamps the
 * chunks that own edges, and edge readiness reaches `ready` while a code chunk
 * that owns no edge keeps a NULL watermark.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { importCodeFile, importFromContent } from '../src/core/import-file.ts';
import { resolveSymbolEdgesIncremental } from '../src/core/chunkers/symbol-resolver.ts';
import { resolveCodeReadiness } from '../src/core/code-graph-readiness.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const pad = (name: string) => Array.from({ length: 5 }, (_, i) => `  // ${name} line ${i}: padding keeps this chunk above the small-sibling merge threshold so it keeps its own symbol.`).join('\n');
const SAMPLE = `export function alphaExample(x) {
${pad('alpha')}
  return betaExample(x) + 1;
}

export function betaExample(y) {
${pad('beta')}
  return y * 2;
}
`;

async function watermarks(sourceId: string) {
  return engine.executeRaw<{ owns_edge: boolean; stamped: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM code_edges_symbol e WHERE e.from_chunk_id = cc.id) AS owns_edge, cc.edges_backfilled_at IS NOT NULL AS stamped
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.source_id = $1 ORDER BY cc.id`, [sourceId]);
}

test('#7119: a markdown-only source gets no edges_backfilled_at stamps', async () => {
  for (let i = 0; i < 3; i++) {
    await importFromContent(engine, `notes/note-${i}`, `---\ntitle: Note ${i}\ntype: note\n---\nA plain markdown note number ${i}.`, { noEmbed: true });
  }
  expect((await watermarks('default')).length).toBeGreaterThan(0);
  const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
  expect(stats.chunks_walked).toBe(0);
  expect((await watermarks('default')).every(row => !row.stamped)).toBe(true);
});

test('#7119: a code source resolves and stamps only the chunks that own edges, and edge readiness reaches ready', async () => {
  await importCodeFile(engine, 'src/sample.ts', SAMPLE, { noEmbed: true });
  await importFromContent(engine, 'notes/readme', '---\ntitle: Readme\ntype: note\n---\nA markdown page beside the code.', { noEmbed: true });
  const before = await watermarks('default');
  expect(before.some(row => row.owns_edge)).toBe(true);
  expect(before.some(row => !row.owns_edge)).toBe(true);
  const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
  expect(stats.edges_resolved).toBe(1);
  expect((await watermarks('default')).map(row => row.stamped)).toEqual(before.map(row => row.owns_edge));
  expect(await resolveCodeReadiness(engine, { sourceId: 'default', kind: 'edge', count: 0, remote: false }))
    .toMatchObject({ status: 'ready', ready: true, pending_edges: false });
  expect((await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' })).chunks_walked).toBe(0);
});

test('#7119: edge readiness ignores a code chunk that owns no edge', async () => {
  await importCodeFile(engine, 'src/sample.ts', SAMPLE, { noEmbed: true });
  await engine.executeRaw('UPDATE content_chunks cc SET edges_backfilled_at = NOW() WHERE EXISTS(SELECT 1 FROM code_edges_symbol e WHERE e.from_chunk_id = cc.id)');
  expect((await watermarks('default')).some(row => !row.owns_edge && !row.stamped)).toBe(true);
  expect(await resolveCodeReadiness(engine, { sourceId: 'default', kind: 'edge', count: 0, remote: false }))
    .toMatchObject({ status: 'ready', ready: true, pending_edges: false });
});
