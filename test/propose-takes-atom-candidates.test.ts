// #5211 (wave 14 PR3 row P3.8): propose_takes never proposes from atoms. Wave
// 13 PR3 (#6446, its #5212 row) excludes the writer-stamped dream output
// (`dream_generated`, `extracted_by: extract_atoms…`, `synthesized_by:
// synthesize_concepts…`); the remaining gap is a legacy `type = 'atom'` page
// that carries neither stamp. The one-line `type IS DISTINCT FROM 'atom'` arm
// is a stack hunk on `src/core/cycle/propose-takes.ts` (wave 13 hot file) in
// `~/.capy/work/w14/pr3/stack-hunks/`. Flip `test.todo` to `test` when both
// #6446 and the hunk land.
//
// Protects: the candidate list of `listCandidatePages`. Fails when: an atom,
// a page stamped `dream_generated` or an unstamped legacy atom reaches the
// extractor, or when the ordinary note stops reaching it. Why not existing
// coverage: #6446's test covers stamped atoms only. Seam: the `extractor`
// option already exists.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseProposeTakes } from '../src/core/cycle/propose-takes.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const context = (): OperationContext => ({
  engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId: 'default',
});
const put = (slug: string, type: string, frontmatter: Record<string, unknown>) => engine.putPage(slug, {
  title: slug, type: type as never, compiled_truth: 'A strong claim lives in this page.', frontmatter, timeline: '',
});

describe('propose_takes candidate filter excludes atoms and dream output (#5211, P3.8)', () => {
  test.todo('P3.8: a stamped atom, a legacy unstamped atom and a dream_generated page are not candidates; a note is', async () => {
    await put('wiki/essays/thesis', 'analysis', {});
    await put('atoms/stamped-claim', 'atom', { dream_generated: true, extracted_by: 'extract_atoms-v0.41.2.1' });
    await put('atoms/legacy-claim', 'atom', {});
    await put('wiki/personal/reflections/2026-10-01-dream', 'note', { dream_generated: true });
    const scanned: string[] = [];
    const result = await runPhaseProposeTakes(context(), { extractor: async ({ pagePath }) => { scanned.push(pagePath); return []; } });
    expect(scanned).toEqual(['wiki/essays/thesis']);
    expect((result.details as Record<string, unknown>).pages_scanned).toBe(1);
  });
});
