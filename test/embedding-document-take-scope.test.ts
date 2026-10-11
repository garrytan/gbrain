import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { embedStaleTakes } from '../src/core/embed-takes.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
let engine: BrainEngine;

beforeAll(async () => {
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
  const pglite = new PGLiteEngine();
  engine = pglite;
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('embedding_model', MODEL);
  await engine.setConfig('embedding_dimensions', String(DIMS));
  await engine.executeRaw(`INSERT INTO sources (id,name) VALUES ('take-scope','take-scope'),('take-scope-other','take-scope-other') ON CONFLICT (id) DO NOTHING`);
});

afterAll(async () => { await engine.disconnect(); resetGateway(); });

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM takes');
  await engine.executeRaw('UPDATE pages SET deleted_at=NULL');
  await engine.executeRaw('UPDATE sources SET archived=false');
});

async function seed(slug: string, sourceId: string, claim = `Claim for ${slug}`): Promise<number> {
  const page = await engine.putPage(slug, { type: 'person', title: slug, compiled_truth: `# ${slug}` }, { sourceId });
  await engine.addTakesBatch([{ page_id: page.id, row_num: 1, claim, kind: 'fact', holder: 'world', weight: 1, active: true, superseded_by: null }]);
  const [take] = await engine.executeRaw<{ id: number }>('SELECT id FROM takes WHERE page_id=$1', [page.id]);
  return Number(take.id);
}

const vector = () => new Float32Array(DIMS).fill(0.001);

describe('source-scoped take embedding installation', () => {
  for (const [change, mutate] of [
    ['moved', () => engine.executeRaw('UPDATE pages SET source_id=$2 WHERE slug=$1', ['take-scope/moved', 'take-scope-other'])],
    ['deleted', () => engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE slug=$1', ['take-scope/deleted'])],
    ['archived', () => engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', ['take-scope'])],
  ] as const) {
    test(`discards a row ${change} during embedding`, async () => {
      const take = await seed(`take-scope/${change}`, 'take-scope');
      const result = await embedStaleTakes(engine, {
        sourceId: 'take-scope',
        embedFn: async texts => { await mutate(); return texts.map(vector); },
      });
      expect(result).toMatchObject({ total_stale: 1, embedded: 0, discarded: 1, failures: 0 });
      const [row] = await engine.executeRaw<{ embedding: unknown }>('SELECT embedding FROM takes WHERE id=$1', [take]);
      expect(row.embedding).toBeNull();
    });
  }

  test('locks scoped membership in the owned install transaction and retains claim CAS', async () => {
    const current = await seed('take-scope/current', 'take-scope');
    const edited = await seed('take-scope/edited', 'take-scope');
    let ownershipChecks = 0;

    const result = await embedStaleTakes(engine, {
      sourceId: 'take-scope',
      assertOwned: async tx => {
        ownershipChecks++;
        expect(tx).not.toBe(engine);
        await tx.executeRaw('SELECT id FROM takes WHERE id=$1', [current]);
      },
      embedFn: async texts => {
        await engine.executeRaw('UPDATE takes SET claim=$2, embedding=NULL, embedding_model=NULL, embedded_text_hash=NULL WHERE id=$1', [edited, 'edited while embedding']);
        return texts.map(vector);
      },
    });

    expect(ownershipChecks).toBe(1);
    expect(result).toMatchObject({ total_stale: 2, embedded: 1, discarded: 1, failures: 0 });
    const rows = await engine.executeRaw<{ id: number; claim: string; embedding: unknown }>('SELECT id,claim,embedding FROM takes WHERE id=ANY($1::bigint[])', [[current, edited]]);
    expect(rows.find(row => Number(row.id) === current)?.embedding).not.toBeNull();
    expect(rows.find(row => Number(row.id) === edited)).toMatchObject({ claim: 'edited while embedding', embedding: null });
  });

  test('keeps unscoped embedding behavior', async () => {
    const take = await seed('take-scope/unscoped', 'take-scope-other');
    const result = await embedStaleTakes(engine, { embedFn: async texts => texts.map(vector) });
    expect(result).toMatchObject({ total_stale: 1, embedded: 1, discarded: 0, failures: 0 });
    const [row] = await engine.executeRaw<{ embedding: unknown }>('SELECT embedding FROM takes WHERE id=$1', [take]);
    expect(row.embedding).not.toBeNull();
  });
});
