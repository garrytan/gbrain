/**
 * The shadow seed's identity, link, purge and token relations from a real PGLite primary: entity_identities,
 * link_relationships, link_transitions, fact_purges and access_tokens, plus page_write_guards (a lock anchor the seed
 * leaves behind on purpose).
 *
 * Protects: each of the five relations is copied, so the seeded Rust store answers the family's own read (entity groups,
 * link state and dated transitions, the purge guard, the bearer check by token hash) as the primary does; each relation
 * has a digest entry per row, so follow and reconcile cover it; no relation is any longer an unseeded gap; page_write_guards
 * is named as a not-copied lock anchor and never a gap; neither `seed.json` nor a batch the seed sends names a token hash
 * anywhere but the `token_hash` column of the access_tokens rows themselves.
 * Regression it catches: a relation missing from the plan (its rows would read as empty after a swap), a decoded column
 * that comes back different from the primary, a gap that stays counted after the copy, a token hash in the seed record.
 * Not covered elsewhere: the Rust tests import hand-written rows; this file reads them from a real primary.
 *
 * The read-back tests need the addon `bun run rust:build` writes and skip without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a
 * missing addon an error). The test that reads the rows and sends them to a recording target needs no addon. Postgres:
 * test/e2e/shadow-seed-state.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustStore, type SeedPlan, type SeedRow } from '../src/core/rust-engine/store.ts';
import { runSeed, type SeedTarget } from '../src/shadow/seed.ts';
import { seedInto } from './helpers/shadow-seed-fixture.ts';
import {
  expectIdentityParity, expectPurgeParity, expectRelationshipParity, expectTokenParity, expectTransitionParity, fillStateFixture, LIVE_TOKEN_HASH,
  onSeededBrain, REVOKED_TOKEN_HASH, STATE_RELATIONS,
} from './helpers/shadow-seed-state-fixture.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

let primary: PGLiteEngine;
let addon: RustAddon | undefined;
const dirs: string[] = [];

beforeAll(async () => {
  primary = new PGLiteEngine();
  await primary.connect({});
  await primary.initSchema();
});
afterAll(async () => { await primary.disconnect(); });
beforeEach(async () => { await resetPgliteState(primary); });
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-seed-state-'));
  dirs.push(dir);
  return dir;
}

async function seedHere() {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  return seedInto(primary, addon, tempDir(), 'pglite');
}

/** A store that records what it was sent, for the test that needs no addon. */
function recordingTarget(plan: SeedPlan): SeedTarget & { sent: Record<string, SeedRow[]> } {
  const sent: Record<string, SeedRow[]> = {};
  return {
    sent,
    async seedPlan() { return plan; },
    async importRelation(_seedId, relation, rows) {
      (sent[relation] ??= []).push(...rows);
      return { imported: rows.length, skipped: 0, dropped: 0, unmapped_columns: [], losses: {} };
    },
  };
}

const keyOf: Record<(typeof STATE_RELATIONS)[number], string[]> = {
  entity_identities: ['id'],
  link_relationships: ['from_page_id', 'to_page_id', 'link_type', 'scope'],
  link_transitions: ['id'],
  fact_purges: ['source_id', 'visibility', 'subject', 'fact_hash'],
  access_tokens: ['id'],
};

describe('shadow seed of the identity, link, purge and token relations from PGLite', () => {
  // One test per relation, so each fails by itself when its importer is missing.
  withAddon('entity_identities: the seeded store lists the same groups as the primary', async () => {
    await fillStateFixture(primary);
    const { record, storePath } = await seedHere();
    await onSeededBrain(addon!, storePath, brain => expectIdentityParity(primary, brain));
    expect(record.relations.entity_identities?.imported).toBe(3);
  }, 60_000);

  withAddon('link_relationships: the seeded store holds the same relationship state as the primary', async () => {
    const ids = await fillStateFixture(primary);
    const { record, storePath } = await seedHere();
    await onSeededBrain(addon!, storePath, brain => expectRelationshipParity(primary, brain, ids));
    expect(record.relations.link_relationships?.imported).toBe(2);
  }, 60_000);

  withAddon('link_transitions: the seeded store holds the same dated transitions as the primary', async () => {
    const ids = await fillStateFixture(primary);
    const { record, storePath } = await seedHere();
    await onSeededBrain(addon!, storePath, brain => expectTransitionParity(primary, brain, ids));
    expect(record.relations.link_transitions?.imported).toBe(2);
  }, 60_000);

  withAddon('fact_purges: the seeded store refuses the same purged claims as the primary', async () => {
    await fillStateFixture(primary);
    const { record, storePath } = await seedHere();
    await onSeededBrain(addon!, storePath, brain => expectPurgeParity(primary, brain));
    expect(record.relations.fact_purges?.imported).toBe(2);
  }, 60_000);

  withAddon('access_tokens: the seeded store authorizes the same bearer tokens as the primary', async () => {
    await fillStateFixture(primary);
    const { record, storePath } = await seedHere();
    await onSeededBrain(addon!, storePath, brain => expectTokenParity(primary, brain));
    expect(record.relations.access_tokens?.imported).toBe(2);
  }, 60_000);

  withAddon('none of the five is a gap any more, and the serial id of a membership is the one named unmapped column', async () => {
    await fillStateFixture(primary);
    const { record } = await seedHere();
    for (const relation of STATE_RELATIONS) {
      expect(record.unseeded_gap_rows[relation], relation).toBeUndefined();
      expect(record.relations[relation]?.skipped, relation).toBe(0);
      expect(record.relations[relation]?.dropped, relation).toBe(0);
    }
    expect(record.relations.entity_identities?.unmapped_columns).toEqual(['id']);
    for (const relation of STATE_RELATIONS.filter(r => r !== 'entity_identities')) expect(record.relations[relation]?.unmapped_columns, relation).toEqual([]);
    expect(record.losses.values.token_without_created_at).toBeUndefined();
  }, 60_000);

  withAddon('every copied row has a digest entry, so follow and reconcile cover the five relations', async () => {
    await fillStateFixture(primary);
    const { record, storePath } = await seedHere();
    const store = await openRustStore(addon!, storePath);
    try {
      const plan = await store.seedPlan();
      for (const relation of STATE_RELATIONS) {
        const planned = plan.relations.find(r => r.relation === relation);
        expect(planned?.key, relation).toEqual(keyOf[relation]);
        expect(planned?.removable, relation).toBe(true);
        const digest = await store.relationDigest(record.seed_id, relation, null, null);
        expect(digest.rows, relation).toBe(record.relations[relation]!.rows_read);
        expect(digest.rows, relation).toBeGreaterThan(0);
      }
    } finally {
      await store.close();
    }
  }, 60_000);

  withAddon('a Rust brain shows page_write_guards as a not-copied lock anchor, never a gap', async () => {
    await fillStateFixture(primary);
    // A write takes its guard row (INSERT ... ON CONFLICT DO NOTHING, then SELECT ... FOR UPDATE); make sure the primary holds some.
    await primary.executeRaw(`INSERT INTO page_write_guards (source_incarnation, slug) SELECT incarnation, 'people/alice-example' FROM sources WHERE id = 'default' ON CONFLICT DO NOTHING`);
    const [{ n }] = await primary.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_write_guards`);
    expect(n).toBeGreaterThan(0);
    const { record, storePath } = await seedHere();
    const named = record.losses.not_copied.find(t => t.table === 'page_write_guards');
    expect(named).toMatchObject({ table: 'page_write_guards', kind: 'lock_anchor', rows: n });
    expect(named!.read).toStartWith('none:');
    expect(record.unseeded_gap_rows.page_write_guards).toBeUndefined();
    expect(record.losses.gaps.page_write_guards).toBeUndefined();
    const store = await openRustStore(addon!, storePath);
    try {
      const plan = await store.seedPlan();
      expect(plan.relations.map(r => r.relation)).not.toContain('page_write_guards');
      expect(plan.not_copied.find(t => t.table === 'page_write_guards')).toMatchObject({ kind: 'lock_anchor', gap_rows: null });
    } finally {
      await store.close();
    }
  }, 60_000);

  test('the seed reads every column of the five tables in key order and puts no token hash in seed.json', async () => {
    await fillStateFixture(primary);
    const plan: SeedPlan = {
      relations: STATE_RELATIONS.map(relation => ({ relation, key: keyOf[relation], removable: true })),
      carried: [], not_copied: [], gap_columns: [],
    };
    const target = recordingTarget(plan);
    const record = await runSeed(primary, target, { primaryEngine: 'pglite', batchRows: 1 });
    expect(Object.fromEntries(STATE_RELATIONS.map(r => [r, target.sent[r]?.length]))).toEqual({
      entity_identities: 3, link_relationships: 2, link_transitions: 2, fact_purges: 2, access_tokens: 2,
    });
    // Every stored column rides along as text, so the importer sees the whole row.
    const tokens = target.sent.access_tokens!;
    expect(Object.keys(tokens[0]!).sort()).toEqual([
      'allowed_operations', 'attest_actor', 'attest_ops', 'attest_read', 'attest_sources', 'created_at', 'federated_read', 'grant_revision', 'id',
      'last_used_at', 'may_act_for', 'member_id', 'min_trust', 'name', 'permissions', 'private_facts', 'private_pages', 'read_shared_revision',
      'reads_unscoped', 'revoked_at', 'scopes', 'source_grant', 'source_id', 'takes_holders', 'token_hash',
    ]);
    expect(tokens.map(t => t.token_hash).sort()).toEqual([LIVE_TOKEN_HASH, REVOKED_TOKEN_HASH].sort());
    expect(target.sent.link_relationships!.map(r => r.scope)).toEqual(['all', 'world']);
    expect(target.sent.fact_purges!.map(r => r.subject)).toEqual(['*', 'people/alice-example']);
    // The record keeps counts and names only: no row value, no hash.
    const text = JSON.stringify(record);
    expect(text).not.toContain(LIVE_TOKEN_HASH);
    expect(text).not.toContain(REVOKED_TOKEN_HASH);
    expect(record.relations.access_tokens).toEqual({ rows_read: 2, imported: 2, skipped: 0, dropped: 0, unmapped_columns: [] });
  }, 60_000);
});
