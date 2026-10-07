/**
 * Foundations 2 (Lane C) schema-pack conversion attribution on an unmanaged
 * brain: page-to-alias and page-to-link soft deletes and the retype and type
 * sync batches run in maintenanceTransaction, so every page they advance names
 * the local maintenance principal instead of `unrecorded`.
 *
 * Protects the schema-pack writer family in docs/architecture/system-of-record.md.
 * Fails if page-to-alias.ts, page-to-link.ts, retype.ts or schema-pack/sync.ts
 * writes outside maintenanceTransaction. Runs on PGLite, and on Postgres
 * (direct and transaction-mode PgBouncer) through
 * test/e2e/write-attribution-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runPageToAliasCore } from '../src/core/schema-pack/page-to-alias.ts';
import { runPageToLinkCore } from '../src/core/schema-pack/page-to-link.ts';
import { runRetypeCore } from '../src/core/schema-pack/retype.ts';
import { runSyncCore } from '../src/core/schema-pack/sync.ts';
import { __setPackLocatorForTests, _resetPackLocatorForTests } from '../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { asCreator, revisionActor, unmanagedBrain, type UnmanagedBrain } from './helpers/unmanaged-attribution.ts';

const engines: BrainEngine[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'gbrain-write-attribution-schema-pack-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  resetGateway(); // R5: restore the preload baseline for later files in this shard
  _resetPackLocatorForTests();
  _resetPackCacheForTests();
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  rmSync(scratch, { recursive: true, force: true });
});

const ctx = (brain: UnmanagedBrain): OperationContext => ({ engine: brain.engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never,
  dryRun: false, remote: false, sourceId: brain.sourceId });
async function seed(brain: UnmanagedBrain, slug: string, type: string, body = 'A page body.', frontmatter: Record<string, unknown> = {}) {
  await asCreator(brain.engine, tx => tx.putPage(slug, { title: slug, type: type as never, compiled_truth: body, timeline: '', frontmatter, source_path: `${slug}.md` } as never,
    { sourceId: brain.sourceId }));
}
const deletedRevisionActor = async (brain: UnmanagedBrain, slug: string) => (await brain.engine.executeRaw<{ request: string | null; kind: string | null; id: string | null }>(
  `SELECT revision_write_request_id::text AS request, revision_principal_kind AS kind, revision_principal_id AS id
     FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NOT NULL`, [brain.sourceId, slug]))[0];

describe('schema-pack conversions on an unmanaged brain', () => {
  test('page-to-alias soft-deletes the redirect page under the maintenance principal', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      await seed(brain, 'wiki/concepts/canonical-example', 'concept', 'The canonical body, long enough for every guard in the converter.');
      await seed(brain, 'wiki/concepts/redirect-example', 'concept-redirect', '[[wiki/concepts/canonical-example]] redirects to the canonical page');
      const result = await runPageToAliasCore(ctx(brain), { rules: [{ from_type: 'concept-redirect', canonical_from: 'body_first_link', alias_slug_from: 'slug' }], apply: true, sourceId: brain.sourceId } as never);
      expect(result.per_rule[0].soft_deleted).toBe(1);
      expect(await deletedRevisionActor(brain, 'wiki/concepts/redirect-example')).toEqual(brain.maintenance);
    }
  }, 120_000);

  test('page-to-link soft-deletes the edge-shaped page under the maintenance principal', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      await seed(brain, 'people/alice-example', 'person');
      await seed(brain, 'companies/acme-example', 'company');
      await seed(brain, 'atoms/partner-example', 'atom-partner-link', 'An edge.', { source: 'people/alice-example', target: 'companies/acme-example' });
      const result = await runPageToLinkCore(ctx(brain), { rules: [{ from_type: 'atom-partner-link', link_type: 'partner_of',
        source_slug_from: { frontmatter_field: 'source' }, target_slug_from: { frontmatter_field: 'target' } }], apply: true, sourceId: brain.sourceId } as never);
      expect(result.per_rule[0].converted).toBe(1);
      expect(await deletedRevisionActor(brain, 'atoms/partner-example')).toEqual(brain.maintenance);
    }
  }, 120_000);

  test('retype advances each retyped page under the maintenance principal', async () => {
    for (const engine of engines) {
      const brain = await unmanagedBrain(engine);
      await seed(brain, 'tweets/one-example', 'tweet-single');
      await seed(brain, 'tweets/two-example', 'tweet-single');
      const result = await runRetypeCore(ctx(brain), { rules: [{ from_type: 'tweet-single', to_type: 'tweet', subtype: 'single' }], apply: true, sourceId: brain.sourceId } as never);
      expect(result.total_applied).toBe(2);
      for (const slug of ['tweets/one-example', 'tweets/two-example']) expect(await revisionActor(engine, brain.sourceId, slug)).toEqual(brain.maintenance);
    }
  }, 120_000);

  test('the pack type sync advances each typed page under the maintenance principal', async () => {
    const pack = join(scratch, 'tiny', 'pack.yaml');
    mkdirSync(join(scratch, 'tiny'), { recursive: true });
    writeFileSync(pack, 'api_version: gbrain-schema-pack-v1\nname: tiny\nversion: 1.0.0\ndescription: ""\ngbrain_min_version: 0.38.0\nextends: null\nborrow_from: []\n'
      + 'page_types:\n  - name: person\n    primitive: entity\n    path_prefixes:\n      - people/\n    aliases: []\n    extractable: false\n    expert_routing: false\n'
      + 'link_types: []\nfrontmatter_links: []\ntakes_kinds:\n  - fact\n  - take\n  - bet\n  - hunch\nenrichable_types: []\nfiling_rules: []\n');
    // The brains register their local writer before GBRAIN_HOME moves: the maintenance principal is that registration.
    const brains: UnmanagedBrain[] = [];
    for (const engine of engines) brains.push(await unmanagedBrain(engine));
    await withEnv({ GBRAIN_SCHEMA_PACK: 'tiny' }, async () => {
      for (const brain of brains) {
        const engine = brain.engine;
        _resetPackCacheForTests();
        __setPackLocatorForTests(name => (name === 'tiny' ? pack : null));
        await seed(brain, 'bea-example', 'note');
        await engine.executeRaw(`UPDATE pages SET type='', source_path='people/bea-example.md' WHERE source_id=$1 AND slug='bea-example'`, [brain.sourceId]);
        await engine.executeRaw('UPDATE pages SET revision_principal_kind=NULL, revision_principal_id=NULL WHERE source_id=$1', [brain.sourceId]);
        const result = await runSyncCore(ctx(brain), { apply: true });
        expect(result.total_applied).toBe(1);
        expect(await revisionActor(engine, brain.sourceId, 'bea-example')).toEqual(brain.maintenance);
      }
    });
  }, 120_000);
});
