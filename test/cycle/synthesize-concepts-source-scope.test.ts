// #4416 — synthesize_concepts must thread the cycle's resolved source
// (opts.sourceId) into its page/receipt/rollup writes. (Fix adopted from the
// open PR #4417 by its reporter.)
//
// Before the fix the phase wrote concept pages via importFromContent with no
// sourceId and hardcoded source_id: 'default' into the receipt + rollup.
// Every write in that path substitutes the literal 'default' when sourceId
// is undefined, so on a brain whose content lives in a source not named
// 'default' (the one-brain-one-source layout in
// docs/architecture/brains-and-sources.md) every synthesized concept page
// silently lands under the seeded 'default' source instead of the cycle's
// source — wrong provenance, invisible to source-scoped reads.

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesizeConcepts } from '../../src/core/cycle/synthesize-concepts.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

let engine: PGLiteEngine;

// Generous hook timeouts: PGLite WASM cold-start + initSchema can exceed the
// 60s default on loaded CI/dev hosts.
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('personal', 'Personal') ON CONFLICT (id) DO NOTHING`,
    [],
  );
}, 120000);

// Two atoms sharing one concept ref → deterministic-tier narrative, no LLM.
const atoms = [
  { slug: 'a1', title: 'A1', body: 'b1', concept_refs: ['theme'] },
  { slug: 'a2', title: 'A2', body: 'b2', concept_refs: ['theme'] },
];

describe('synthesize_concepts source scoping (#4416)', () => {
  test('writes concept page + rollup under opts.sourceId; re-run (update path) survives on a non-default source', async () => {
    const first = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'personal' });
    expect(first.status).toBe('ok');

    const pages = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = 'concepts/theme'`,
      [],
    );
    expect(pages.length).toBe(1);
    expect(pages[0].source_id).toBe('personal');

    // Update path: importFromContent finds the existing page, then the
    // version write must target the page's REAL source. Pre-fix this path
    // targeted (source=default) and failed on a brain without that source.
    const second = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms, sourceId: 'personal' });
    expect(second.status).toBe('ok');

    const rollup = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM extract_rollup_7d WHERE kind = 'concepts'`,
      [],
    );
    expect(rollup.length).toBeGreaterThan(0);
    expect(rollup.every((r) => r.source_id === 'personal')).toBe(true);
  }, 120000);

  test('omitting sourceId keeps the legacy default fallback', async () => {
    const result = await runPhaseSynthesizeConcepts(engine, { _atoms: atoms });
    expect(result.status).toBe('ok');

    const pages = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = 'concepts/theme'`,
      [],
    );
    expect(pages.length).toBe(1);
    expect(pages[0].source_id).toBe('default');

    const rollup = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM extract_rollup_7d WHERE kind = 'concepts'`,
      [],
    );
    expect(rollup.length).toBeGreaterThan(0);
    expect(rollup.every((r) => r.source_id === 'default')).toBe(true);
  }, 120000);
});
