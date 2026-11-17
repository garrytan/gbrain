import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { derivedRowsFrom } from '../src/core/facts/derivation-inputs.ts';
import { lowerDerivedPage } from '../src/core/trust/taint.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('a re-published page keeps only its current derivation inputs', async () => {
  const put = (slug: string) => engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body text`, frontmatter: {} }, { sourceId: 'default' });
  const concept = await put('concepts/c9653');
  const oldAtom = await put('atoms/old-9653');
  const newAtom = await put('atoms/new-9653');
  const inputs = (...ids: number[]) => ({ trust: { tier: 'operator_curated' as const, origin: { channel: 'test' } },
    inputs: ids.map(id => ({ table: 'pages' as const, id, tier: 'operator_curated' as const })) });
  await lowerDerivedPage(engine, inputs(oldAtom.id), 'default', 'concepts/c9653');
  await lowerDerivedPage(engine, inputs(newAtom.id), 'default', 'concepts/c9653');
  const walked = await derivedRowsFrom(engine, [{ table: 'pages', id: oldAtom.id }]);
  expect(walked.rows.map(r => r.id)).not.toContain(String(concept.id));
  const kept = await derivedRowsFrom(engine, [{ table: 'pages', id: newAtom.id }]);
  expect(kept.rows.map(r => r.id)).toContain(String(concept.id));
});
