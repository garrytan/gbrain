import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { PageInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

const testPage: PageInput = {
  type: 'concept',
  title: 'Pv',
  compiled_truth: 'one',
  timeline: '',
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  await (engine as any).db.exec(`TRUNCATE TABLE eval_candidates RESTART IDENTITY`);
  await (engine as any).db.exec(`TRUNCATE TABLE pages RESTART IDENTITY CASCADE`);
}

describe('page versions + soft delete (PGLite)', () => {
  beforeEach(truncateAll);

  test('revertToVersion restores prior compiled_truth', async () => {
    await engine.putPage('test/rv', { ...testPage, compiled_truth: 'alpha' });
    const vid = (await engine.createVersion('test/rv', { provenance: { source: 'snap' }, kind: 'update' })).id;
    await engine.putPage('test/rv', { ...testPage, compiled_truth: 'beta' });
    await engine.revertToVersion('test/rv', vid);
    const p = await engine.getPage('test/rv');
    expect(p?.compiled_truth).toBe('alpha');
  });

  test('softDelete hides page from default getPage/list; includeDeleted restores getPage', async () => {
    await engine.putPage('test/sd', testPage);
    await engine.softDeletePage('test/sd');
    expect(await engine.getPage('test/sd')).toBeNull();
    expect((await engine.listPages()).some(p => p.slug === 'test/sd')).toBe(false);
    const tomb = await engine.getPage('test/sd', { includeDeleted: true });
    expect(tomb?.deleted_at).toBeTruthy();
    const vv = await engine.getVersions('test/sd', { includeDeletedPage: true });
    expect(vv.some(v => v.kind === 'delete')).toBe(true);
  });

  test('resurrectSoftDeletedPage clears tombstone visibility', async () => {
    await engine.putPage('test/rs', testPage);
    await engine.softDeletePage('test/rs');
    await engine.resurrectSoftDeletedPage('test/rs');
    const p = await engine.getPage('test/rs');
    expect(p).not.toBeNull();
    expect(p?.deleted_at == null).toBe(true);
  });

  test('diffPageVersions returns both bodies', async () => {
    await engine.putPage('test/diff', { ...testPage, compiled_truth: 'a' });
    const a = (await engine.createVersion('test/diff', { kind: 'update', provenance: { source: 't' } })).id;
    await engine.putPage('test/diff', { ...testPage, compiled_truth: 'b' });
    const b = (await engine.createVersion('test/diff', { kind: 'update', provenance: { source: 't' } })).id;
    const d = await engine.diffPageVersions('test/diff', a, b);
    expect(d.compiled_truth.from).toBe('a');
    expect(d.compiled_truth.to).toBe('b');
  });

  test('deleteEvalCandidatesBefore readToolsOnly keeps query rows', async () => {
    const base = {
      query: 'x',
      retrieved_slugs: [] as string[],
      retrieved_chunk_ids: [] as number[],
      source_ids: [] as string[],
      detail: null,
      detail_resolved: null,
      expand_enabled: null,
      vector_enabled: false,
      expansion_applied: false,
      latency_ms: 1,
      remote: true,
      job_id: null,
      subagent_id: null,
    };
    await engine.logEvalCandidate({ ...base, tool_name: 'get_page' });
    await engine.logEvalCandidate({ ...base, tool_name: 'query', query: 'q' });
    const old = new Date(Date.now() - 86400000 * 400);
    await engine.executeRaw(`UPDATE eval_candidates SET created_at = $1`, [old]);
    const n = await engine.deleteEvalCandidatesBefore(new Date(Date.now() - 86400000), { readToolsOnly: true });
    expect(n).toBe(1);
    const rows = await engine.listEvalCandidates({ since: new Date(0), limit: 100 });
    expect(rows.some(r => r.tool_name === 'query')).toBe(true);
    expect(rows.some(r => r.tool_name === 'get_page')).toBe(false);
  });
});
