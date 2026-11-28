/**
 * Postgres twin of test/shadow-seed-state.test.ts: the shadow seed's identity, link, purge and token relations
 * (entity_identities, link_relationships, link_transitions, fact_purges, access_tokens) and the not-copied lock anchor
 * page_write_guards, from a real Postgres primary.
 *
 * Protects: the seeded Rust store answers each family's read as the Postgres primary does; the five relations are no longer
 * gaps; page_write_guards is a named lock anchor; no token hash reaches seed.json.
 * Regression it catches: a Postgres text form (a `datemultirange`, a `uuid`, a `text[]`, a `timestamptz` with a zone offset,
 * `jsonb` key order) that decodes differently from the PGLite text the other file produces.
 * Needs DATABASE_URL; the read-back tests also need the addon `bun run rust:build` writes and skip without it
 * (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error). The test that the seed reads and sends every column
 * without a token hash in its record needs no addon, so this file always runs against the database.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { hasDatabase } from './helpers.ts';
import { persistencePostgresTemplate } from '../helpers/persistence-postgres.ts';
import { loadRustAddon, type RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../../src/core/rust-engine/addon-target.ts';
import { openRustStore, type SeedPlan, type SeedRow } from '../../src/core/rust-engine/store.ts';
import { runSeed, type SeedTarget } from '../../src/shadow/seed.ts';
import { seedInto } from '../helpers/shadow-seed-fixture.ts';
import {
  expectIdentityParity, expectPurgeParity, expectRelationshipParity, expectTokenParity, expectTransitionParity, fillStateFixture, LIVE_TOKEN_HASH,
  onSeededBrain, REVOKED_TOKEN_HASH, STATE_RELATIONS,
} from '../helpers/shadow-seed-state-fixture.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const d = hasDatabase() ? describe : describe.skip;
const withAddon = test.skipIf(!HAVE_ADDON);

let template: Awaited<ReturnType<typeof persistencePostgresTemplate>>;
let engine: PostgresEngine;
let close: () => Promise<void>;
let addon: RustAddon;
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-seed-state-pg-'));
  dirs.push(dir);
  return dir;
}

const keyOf: Record<(typeof STATE_RELATIONS)[number], string[]> = {
  entity_identities: ['id'],
  link_relationships: ['from_page_id', 'to_page_id', 'link_type', 'scope'],
  link_transitions: ['id'],
  fact_purges: ['source_id', 'visibility', 'subject', 'fact_hash'],
  access_tokens: ['id'],
};

d('shadow seed of the identity, link, purge and token relations from Postgres', () => {
  beforeAll(async () => {
    template = await persistencePostgresTemplate(process.env.DATABASE_URL!);
    if (HAVE_ADDON) addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  }, 120_000);
  afterAll(async () => { await template.dispose(); });
  beforeEach(async () => { ({ engine, close } = await template.clone()); }, 60_000);
  afterEach(async () => {
    await close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // One test per relation, so each fails by itself when its importer is missing.
  withAddon('entity_identities: the seeded store lists the same groups as the primary', async () => {
    await fillStateFixture(engine);
    const { record, storePath } = await seedInto(engine, addon, tempDir(), 'postgres');
    await onSeededBrain(addon, storePath, brain => expectIdentityParity(engine, brain));
    expect(record.relations.entity_identities?.imported).toBe(3);
  }, 60_000);

  withAddon('link_relationships: the seeded store holds the same relationship state as the primary', async () => {
    const ids = await fillStateFixture(engine);
    const { record, storePath } = await seedInto(engine, addon, tempDir(), 'postgres');
    await onSeededBrain(addon, storePath, brain => expectRelationshipParity(engine, brain, ids));
    expect(record.relations.link_relationships?.imported).toBe(2);
  }, 60_000);

  withAddon('link_transitions: the seeded store holds the same dated transitions as the primary', async () => {
    const ids = await fillStateFixture(engine);
    const { record, storePath } = await seedInto(engine, addon, tempDir(), 'postgres');
    await onSeededBrain(addon, storePath, brain => expectTransitionParity(engine, brain, ids));
    expect(record.relations.link_transitions?.imported).toBe(2);
  }, 60_000);

  withAddon('fact_purges: the seeded store refuses the same purged claims as the primary', async () => {
    await fillStateFixture(engine);
    const { record, storePath } = await seedInto(engine, addon, tempDir(), 'postgres');
    await onSeededBrain(addon, storePath, brain => expectPurgeParity(engine, brain));
    expect(record.relations.fact_purges?.imported).toBe(2);
  }, 60_000);

  withAddon('access_tokens: the seeded store authorizes the same bearer tokens as the primary', async () => {
    await fillStateFixture(engine);
    const { record, storePath } = await seedInto(engine, addon, tempDir(), 'postgres');
    await onSeededBrain(addon, storePath, brain => expectTokenParity(engine, brain));
    expect(record.relations.access_tokens?.imported).toBe(2);
  }, 60_000);

  withAddon('none of the five is a gap any more, every row has a digest entry and the keys are the primary keys', async () => {
    await fillStateFixture(engine);
    const { record, storePath } = await seedInto(engine, addon, tempDir(), 'postgres');
    const store = await openRustStore(addon, storePath);
    try {
      const plan = await store.seedPlan();
      for (const relation of STATE_RELATIONS) {
        expect(record.unseeded_gap_rows[relation], relation).toBeUndefined();
        expect(record.relations[relation]?.skipped, relation).toBe(0);
        expect(record.relations[relation]?.dropped, relation).toBe(0);
        expect(plan.relations.find(r => r.relation === relation), relation).toMatchObject({ key: keyOf[relation], removable: true });
        expect((await store.relationDigest(record.seed_id, relation, null, null)).rows, relation).toBe(record.relations[relation]!.rows_read);
      }
    } finally {
      await store.close();
    }
    expect(record.relations.entity_identities?.unmapped_columns).toEqual(['id']);
    for (const relation of STATE_RELATIONS.filter(r => r !== 'entity_identities')) expect(record.relations[relation]?.unmapped_columns, relation).toEqual([]);
  }, 60_000);

  withAddon('a Rust brain shows page_write_guards as a not-copied lock anchor, never a gap', async () => {
    await fillStateFixture(engine);
    await engine.executeRaw(`INSERT INTO page_write_guards (source_incarnation, slug) SELECT incarnation, 'people/alice-example' FROM sources WHERE id = 'default' ON CONFLICT DO NOTHING`);
    const [{ n }] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_write_guards`);
    expect(n).toBeGreaterThan(0);
    const { record } = await seedInto(engine, addon, tempDir(), 'postgres');
    expect(record.losses.not_copied.find(t => t.table === 'page_write_guards')).toMatchObject({ kind: 'lock_anchor', rows: n });
    expect(record.unseeded_gap_rows.page_write_guards).toBeUndefined();
  }, 60_000);

  test('the seed reads every column of the five tables and puts no token hash in seed.json', async () => {
    // Runs with or without the addon: the target only records what it is sent.
    await fillStateFixture(engine);
    const plan: SeedPlan = {
      relations: STATE_RELATIONS.map(relation => ({ relation, key: keyOf[relation], removable: true })),
      carried: [], not_copied: [], gap_columns: [],
    };
    const sent: Record<string, SeedRow[]> = {};
    const target: SeedTarget = {
      async seedPlan() { return plan; },
      async importRelation(_seedId, relation, rows) {
        (sent[relation] ??= []).push(...rows);
        return { imported: rows.length, skipped: 0, dropped: 0, unmapped_columns: [], losses: {} };
      },
    };
    const record = await runSeed(engine, target, { primaryEngine: 'postgres', batchRows: 1 });
    expect(Object.fromEntries(STATE_RELATIONS.map(r => [r, sent[r]?.length]))).toEqual({
      entity_identities: 3, link_relationships: 2, link_transitions: 2, fact_purges: 2, access_tokens: 2,
    });
    // The Postgres text forms the importers decode.
    expect(sent.link_relationships![0]!.valid_ranges).toMatch(/^\{\[\d{4}-\d{2}-\d{2},/);
    expect(sent.access_tokens!.map(t => t.token_hash).sort()).toEqual([LIVE_TOKEN_HASH, REVOKED_TOKEN_HASH].sort());
    const live = sent.access_tokens!.find(t => t.token_hash === LIVE_TOKEN_HASH)!;
    expect(live.scopes).toBe('{read,write}');
    expect(JSON.parse(live.permissions!)).toEqual({ takes_holders: ['world'], setup_reads: ['wiki'] });
    const text = JSON.stringify(record);
    expect(text).not.toContain(LIVE_TOKEN_HASH);
    expect(text).not.toContain(REVOKED_TOKEN_HASH);
  }, 60_000);
});
