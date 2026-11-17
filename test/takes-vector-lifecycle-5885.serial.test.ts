/**
 * #5885 + #5188: take vectors have a full lifecycle, and doctor reports
 * facts and takes that lack a current-model vector.
 *
 * Protects (O-ENG-8): a `--stale` embed drain (the cycle's embed phase and the
 * migration drain) embeds stale takes and records the model and claim text;
 * `takes.auto_embed=false` / GBRAIN_EMBED_TAKES=0 turn that off; a claim edit
 * clears the vector; a vector computed for a claim that changed in flight is
 * discarded; a same-width model swap and a width change make take vectors
 * stale and the migration plan, verify and schema transition include takes;
 * takes on deleted pages or archived sources are not work; a managed brain
 * accepts the embedding write without a coordinated grant; doctor's
 * fact_take_vectors check warns with counts and fixes, and is "not
 * applicable" on a keyless brain.
 * Fails when: takes are embedded only by `foresights takes embed`, vectors carry
 * no provenance, or the migration ignores takes.
 * Installs the process-global gateway transport seam, so this stays serial.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { runEmbedCore } from '../src/commands/embed.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { embedStaleTakes } from '../src/core/embed-takes.ts';
import { EMBED_PROBE_TEXT } from '../src/core/embed-stale.ts';
import { planEmbeddingMigration, readDimPinnedWidths, runSchemaTransition, verifyMigrationComplete } from '../src/core/embedding-migration.ts';
import { factTakeVectorsEntry } from '../src/commands/doctor/checks/vector-coverage.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
const OTHER_MODEL = 'openai:text-embedding-3-small';
let embedded: string[] = [];

const gateway = (model: string) => configureGateway({ embedding_model: model, embedding_dimensions: DIMS, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });

beforeAll(() => {
  gateway(MODEL);
  __setEmbedTransportForTests((async (input: { values: string[] }) => {
    embedded.push(...input.values.filter(v => v !== EMBED_PROBE_TEXT));
    return { embeddings: input.values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: input.values.length * 4 } };
  }) as never);
});
afterAll(() => { __setEmbedTransportForTests(null); resetGateway(); });

type Row = { row_num: number; claim: string; has_vector: boolean; embedding_model: string | null; hash_ok: boolean | null };
async function takeRows(engine: BrainEngine, slug: string): Promise<Row[]> {
  return engine.executeRaw<Row>(
    `SELECT t.row_num, t.claim, t.embedding IS NOT NULL AS has_vector, t.embedding_model, t.embedded_text_hash = md5(t.claim) AS hash_ok
       FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 ORDER BY t.row_num`, [slug]);
}
async function seedTakes(engine: BrainEngine, slug: string, claims: string[], sourceId = 'default'): Promise<number> {
  const page = await engine.putPage(slug, { type: 'person', title: slug, compiled_truth: `# ${slug}` }, { sourceId });
  await engine.addTakesBatch(claims.map((claim, i) => ({ page_id: page.id, row_num: i + 1, claim, kind: 'bet', holder: 'world',
    weight: 0.5, active: true, superseded_by: null })));
  return page.id;
}
const doctor = async (engine: BrainEngine) =>
  (await factTakeVectorsEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext) as Check[])[0];

for (const backend of testBackends()) describe(`#5885 take vector lifecycle (${backend})`, () => {
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(requirePostgresTestDatabase()));
    else { engine = new PGLiteEngine(); await engine.connect({ embedding_model: MODEL, embedding_dimensions: DIMS } as never); await engine.initSchema(); }
    await engine.setConfig('embedding_model', MODEL);
    await engine.setConfig('embedding_dimensions', String(DIMS));
  }, 120_000);
  afterAll(async () => { if (close) await close(); else await engine.disconnect(); });
  beforeEach(async () => {
    embedded = [];
    gateway(MODEL);
    await engine.executeRaw('DELETE FROM takes');
    await engine.unsetConfig('takes.auto_embed');
  });

  test('an embed --stale drain embeds stale takes with provenance; the opt-out skips them', async () => {
    await seedTakes(engine, 'people/alice-example', ['Widget co ships in Q3', 'Acme example hires a CFO']);
    await engine.setConfig('takes.auto_embed', 'false');
    const off = await runEmbedCore(engine, { stale: true, quiet: true });
    expect(off.takes).toBeUndefined();
    await withEnv({ GBRAIN_EMBED_TAKES: '0' }, async () => {
      await engine.unsetConfig('takes.auto_embed');
      expect((await runEmbedCore(engine, { stale: true, quiet: true })).takes).toBeUndefined();
    });
    expect((await takeRows(engine, 'people/alice-example')).every(r => !r.has_vector)).toBe(true);

    const preview = await runEmbedCore(engine, { stale: true, dryRun: true, quiet: true });
    expect(preview.takes).toMatchObject({ would_embed: 2, embedded: 0 });
    embedded = [];
    const live = await runEmbedCore(engine, { stale: true, quiet: true });
    expect(live.takes).toMatchObject({ total_stale: 2, embedded: 2, failures: 0 });
    expect(embedded.sort()).toEqual(['Acme example hires a CFO', 'Widget co ships in Q3']);
    expect(await takeRows(engine, 'people/alice-example')).toEqual([
      { row_num: 1, claim: 'Widget co ships in Q3', has_vector: true, embedding_model: MODEL, hash_ok: true },
      { row_num: 2, claim: 'Acme example hires a CFO', has_vector: true, embedding_model: MODEL, hash_ok: true },
    ]);
    embedded = [];
    expect((await runEmbedCore(engine, { stale: true, quiet: true })).takes).toMatchObject({ total_stale: 0 });
    expect(embedded).toEqual([]);
  });

  test('a claim edit clears the vector; a vector for a claim edited in flight is discarded', async () => {
    const pageId = await seedTakes(engine, 'people/bob-example', ['Widget co ships in Q3']);
    await embedStaleTakes(engine, {});
    expect((await takeRows(engine, 'people/bob-example'))[0].has_vector).toBe(true);
    const edit = (claim: string) => engine.addTakesBatch([{ page_id: pageId, row_num: 1, claim, kind: 'bet', holder: 'world', weight: 0.5, active: true, superseded_by: null }]);
    await edit('Widget co ships in Q3');
    expect((await takeRows(engine, 'people/bob-example'))[0].has_vector).toBe(true);
    await edit('Widget co ships in Q4');
    expect((await takeRows(engine, 'people/bob-example'))[0]).toMatchObject({ has_vector: false, embedding_model: null });

    const raced = await embedStaleTakes(engine, { embedFn: async texts => {
      await edit('Widget co ships next year');
      return texts.map(() => new Float32Array(DIMS).fill(0.002));
    } });
    expect(raced).toMatchObject({ total_stale: 1, embedded: 0, discarded: 1, failures: 0 });
    expect((await takeRows(engine, 'people/bob-example'))[0]).toMatchObject({ claim: 'Widget co ships next year', has_vector: false });
  });

  test('takes on deleted pages and archived sources are not stale work', async () => {
    await seedTakes(engine, 'people/live-example', ['Live claim']);
    const gone = await seedTakes(engine, 'people/gone-example', ['Deleted page claim']);
    await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE id = $1', [gone]);
    await engine.executeRaw(`INSERT INTO sources (id, name, archived) VALUES ('archived-example', 'archived-example', true) ON CONFLICT (id) DO NOTHING`);
    await seedTakes(engine, 'people/archived-example', ['Archived source claim'], 'archived-example');
    expect((await engine.listStaleTakes({ model: MODEL, dims: DIMS })).map(t => t.claim)).toEqual(['Live claim']);
    await engine.executeRaw('UPDATE pages SET deleted_at = NULL WHERE id = $1', [gone]);
  });

  test('a same-width model swap makes take vectors stale, and plan/verify count them', async () => {
    await seedTakes(engine, 'people/carol-example', ['Acme example raised a seed round']);
    await embedStaleTakes(engine, {});
    expect(await engine.countStaleTakes({ model: MODEL, dims: DIMS })).toBe(0);
    expect(await engine.countStaleTakes({ model: OTHER_MODEL, dims: DIMS })).toBe(1);
    expect((await planEmbeddingMigration(engine, { to: OTHER_MODEL, dim: DIMS })).takes_to_embed).toBe(1);
    const verify = await verifyMigrationComplete(engine, { toModel: OTHER_MODEL, toDims: DIMS }, { ignoreMarker: true });
    expect(verify.blockers).toContain('1 active take(s) not in the target embedding space');
    expect(verify.details.stale_takes).toBe(1);

    gateway(OTHER_MODEL);
    const result = await runEmbedCore(engine, { stale: true, takes: true, quiet: true });
    expect(result.takes).toMatchObject({ embedded: 1 });
    expect((await takeRows(engine, 'people/carol-example'))[0].embedding_model).toBe(OTHER_MODEL);
  });

  test('doctor fact_take_vectors warns with counts and fixes, then clears', async () => {
    await seedTakes(engine, 'people/dana-example', ['Acme example opens an office']);
    const warn = await doctor(engine);
    expect(warn).toMatchObject({ name: 'fact_take_vectors', status: 'warn', details: { code: 'stale_vectors', takes: { stale: 1, missing_or_changed: 1, other_model: 0 } } });
    expect((warn.details!.fix as string[])).toContain('foresights embed --stale');
    await embedStaleTakes(engine, {});
    expect(await doctor(engine)).toMatchObject({ details: { takes: { stale: 0 } } });
    await engine.setConfig('embedding_model', OTHER_MODEL);
    expect(await doctor(engine)).toMatchObject({ status: 'warn', details: { takes: { stale: 1, other_model: 1 } } });
    await engine.setConfig('embedding_model', MODEL);
    await engine.setConfig('embedding_disabled', 'true');
    expect(await doctor(engine)).toMatchObject({ status: 'ok', details: { applicable: false } });
    await engine.unsetConfig('embedding_disabled');
  });

  test('a width change resizes takes.embedding with the other text-embedding columns', async () => {
    await seedTakes(engine, 'people/erin-example', ['Widget co hires a CTO']);
    await embedStaleTakes(engine, {});
    await runSchemaTransition(engine, 768);
    expect((await readDimPinnedWidths(engine)).find(p => p.table === 'takes')).toEqual({ table: 'takes', dims: 768 });
    expect(await engine.countStaleTakes({ model: MODEL, dims: 768 })).toBe(1);
    await runSchemaTransition(engine, DIMS);
  });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`${backend}: a managed brain accepts take embedding writes without a coordinated grant`, async () => {
    await managedBrain(async ({ engine }) => {
      const takeId = await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.write_sources', $1, true)", [JSON.stringify(['default'])]);
        const page = await tx.putPage('people/frank-example', { type: 'person', title: 'Frank', compiled_truth: '# Frank' });
        await tx.addTakesBatch([{ page_id: page.id, row_num: 1, claim: 'Widget co expands', kind: 'bet', holder: 'world', weight: 0.5, active: true, superseded_by: null }]);
        const [take] = await tx.executeRaw<{ id: number }>('SELECT id FROM takes WHERE page_id = $1', [page.id]);
        return Number(take.id);
      });
      const [col] = await engine.executeRaw<{ f: string }>(`SELECT format_type(atttypid, atttypmod) AS f FROM pg_attribute WHERE attrelid = 'takes'::regclass AND attname = 'embedding'`);
      const width = Number(col.f.match(/\((\d+)\)/)![1]);
      expect(await engine.updateTakeEmbeddings([{ take_id: takeId, embedding: new Float32Array(width).fill(0.003), claim: 'Widget co expands', model: MODEL }])).toBe(1);
      const [row] = await engine.executeRaw<{ embedding_model: string }>('SELECT embedding_model FROM takes WHERE id = $1', [takeId]);
      expect(row.embedding_model).toBe(MODEL);
    }, { databaseUrl });
  }, 120_000);
}
