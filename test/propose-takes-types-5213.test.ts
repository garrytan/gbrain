// #5213 (wave 15 P7.1): `cycle.propose_takes.types` restricts the propose_takes
// candidate list to the listed page types. Unset keeps every type eligible
// (today's behavior); a malformed value is ignored with one stderr line, never
// a crash; the source scope of the candidate query is unchanged.
//
// Protects: the candidate list of `listCandidatePages`. Fails when: a page
// whose type is not in the list reaches the extractor, when a listed type
// stops reaching it, when a bad value crashes the phase, or when the type
// filter widens the source scope. Why not existing coverage: #5211/#5212
// pin the built-in exclusions only. Seam: the existing `extractor` option.

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

const context = (sourceId = 'default'): OperationContext => ({
  engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId,
});
const put = (slug: string, type: string, sourceId = 'default') => engine.putPage(slug, {
  title: slug, type: type as never, compiled_truth: 'A strong claim lives in this page.', frontmatter: {}, timeline: '',
}, { sourceId });

async function scanned(ctx: OperationContext): Promise<string[]> {
  const seen: string[] = [];
  await runPhaseProposeTakes(ctx, { extractor: async ({ pagePath }) => { seen.push(pagePath); return []; } });
  return seen.sort();
}

describe('cycle.propose_takes.types (#5213, P7.1)', () => {
  beforeEach(async () => {
    await put('meetings/2026-10-01', 'meeting');
    await put('notes/scratch', 'note');
    await put('handoffs/weekly', 'handoff');
  });

  test('unset: every type is a candidate', async () => {
    expect(await scanned(context())).toEqual(['handoffs/weekly', 'meetings/2026-10-01', 'notes/scratch']);
  });

  test('a JSON array of types restricts the candidates to those types', async () => {
    await engine.setConfig('cycle.propose_takes.types', '["meeting"]');
    expect(await scanned(context())).toEqual(['meetings/2026-10-01']);
  });

  test('several listed types are all candidates; the unlisted one is not', async () => {
    await engine.setConfig('cycle.propose_takes.types', '["meeting", " handoff "]');
    expect(await scanned(context())).toEqual(['handoffs/weekly', 'meetings/2026-10-01']);
  });

  test('a malformed value is ignored with one stderr line and every type stays a candidate', async () => {
    await engine.setConfig('cycle.propose_takes.types', 'meeting');
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    (process.stderr as { write: unknown }).write = (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; };
    try {
      expect(await scanned(context())).toEqual(['handoffs/weekly', 'meetings/2026-10-01', 'notes/scratch']);
    } finally {
      (process.stderr as { write: unknown }).write = write;
    }
    expect(lines.filter(l => l.includes('cycle.propose_takes.types'))).toHaveLength(1);
  });

  test('the type filter keeps the source scope: a listed type in another source is not a candidate', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('other', 'other', '/tmp/other')`);
    await put('meetings/elsewhere', 'meeting', 'other');
    await engine.setConfig('cycle.propose_takes.types', '["meeting"]');
    expect(await scanned(context())).toEqual(['meetings/2026-10-01']);
    expect(await scanned(context('other'))).toEqual(['meetings/elsewhere']);
  });
});
