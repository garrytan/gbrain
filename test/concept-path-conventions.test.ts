// Protects synthesis and creator filing paths matching bundled concept prefixes.
// Removing concepts/ reproduces the mismatch; existing synthesis tests only
// check page identity. Uses existing seams, with no new production seam.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { mergeInheritedManifest } from '../src/core/schema-pack/merge.ts';
import { inferTypeFromPack } from '../src/core/markdown.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240000);
afterAll(async () => { await engine.disconnect(); });

const load = (name: string) => loadPackFromFile(join(import.meta.dir,
  '../src/core/schema-pack/base', `${name}.yaml`));

test('synthesized concepts and creator filing paths match declared concept prefixes', async () => {
  await runPhaseSynthesizeConcepts(engine, {
    sourceId: 'default',
    _atoms: [0, 1].map(i => ({
      slug: `atoms/sample-${i}`, title: `Sample ${i}`, body: 'A shared theme.',
      concept_refs: ['shared-theme'],
    })),
    _chat: async () => { throw new Error('Model calls are unnecessary'); },
  });
  const page = await engine.getPage('concepts/shared-theme', { sourceId: 'default' });
  expect(page).not.toBeNull();
  expect(page!.type).toBe('concept');
  const base = load('gbrain-base');
  const creator = mergeInheritedManifest([base], load('gbrain-creator'), {
    page_types: [], link_types: [],
  });
  const filing = creator.filing_rules.find(rule => rule.kind === 'concept')!;
  expect(filing.directory).toBe('concepts/');
  for (const pack of [base, load('gbrain-base-v2'), creator]) {
    const concept = pack.page_types.find(type => type.name === 'concept')!;
    for (const slug of [page!.slug, `${filing.directory}sample`,
      'wiki/concepts/sample', 'wiki/concept/sample']) {
      // Inference alone is insufficient: its unmatched-path fallback is concept.
      expect(concept.path_prefixes.some(prefix => slug.startsWith(prefix))).toBe(true);
      expect(inferTypeFromPack(`${slug}.md`, pack)).toBe('concept');
    }
    expect(concept.extractable).toBe(true);
  }
}, 120000);
