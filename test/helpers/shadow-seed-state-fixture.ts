/**
 * Shared scenarios for the shadow seed's identity, link, purge and token relations
 * (test/shadow-seed-state.test.ts on PGLite, test/e2e/shadow-seed-state.test.ts on Postgres): the primary rows, and the
 * read-back that opens the seeded Rust store and asks each family's own read the question the primary answers.
 *
 * The bearer-token hashes here are made-up strings. Nothing prints one: a failed comparison names the row, never the hash.
 */
import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { openRustStore } from '../../src/core/rust-engine/store.ts';
import { linkEntityIdentity, listEntityIdentities } from '../../src/core/entity-identity.ts';
import { refreshRelationships } from '../../src/core/link-relationships.ts';
import { fillSeedFixture } from './shadow-seed-fixture.ts';

/** The relations this scenario seeds, in the order the plan imports them. */
export const STATE_RELATIONS = ['entity_identities', 'link_relationships', 'link_transitions', 'fact_purges', 'access_tokens'] as const;

export const PURGED_CLAIM = 'Alice owes Acme money';
export const PURGED_ABOUT_ALICE = 'Alice moved to Berlin';

/** Two made-up token hashes (a live and a revoked token). Never logged. */
export const LIVE_TOKEN_HASH = createHash('sha256').update('s3b-live-token').digest('hex');
export const REVOKED_TOKEN_HASH = createHash('sha256').update('s3b-revoked-token').digest('hex');

export interface StateFixtureIds { alice: number; acme: number; bob: number }

/** The seed fixture plus a third page, entity groups, dated transitions with their derived state, fact tombstones and tokens. */
export async function fillStateFixture(engine: BrainEngine): Promise<StateFixtureIds> {
  await fillSeedFixture(engine);
  await engine.putPage('people/bob-example', { type: 'person', title: 'Bob Example', compiled_truth: 'Bob works with Alice.', timeline: '' });
  const id = async (slug: string) => Number((await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug]))[0]!.id);
  const ids = { alice: await id('people/alice-example'), acme: await id('companies/acme-example'), bob: await id('people/bob-example') };

  await linkEntityIdentity(engine, { entityId: 'person/alice', slug: 'people/alice-example', sourceId: 'default', canonical: true, confidence: 0.9, establishedBy: 'dedupe' });
  await linkEntityIdentity(engine, { entityId: 'person/alice', slug: 'people/bob-example', sourceId: 'default', canonical: false, confidence: 0.55 });
  await linkEntityIdentity(engine, { entityId: 'company/acme', slug: 'companies/acme-example', sourceId: 'default' });

  const transition = (kind: string, on: string, producer: string, origin: number | null, precision = 'day') => engine.executeRaw(
    `INSERT INTO link_transitions (source_id, from_page_id, to_page_id, link_type, kind, occurred_on, date_precision, producer, origin_page_id, line_hash)
     VALUES ('default', $1, $2, 'works_at', $3, $4::date, $5, $6, $7, 'lh')`, [ids.alice, ids.acme, kind, on, precision, producer, origin]);
  await transition('start', '2021-04-01', 'manual', null);
  await transition('end', '2025-03-01', 'timeline', ids.alice, 'month');
  await refreshRelationships(engine, [{ from_page_id: ids.alice, to_page_id: ids.acme, link_type: 'works_at' }]);

  const purge = (subject: string, claim: string, request: string) => engine.executeRaw(
    `INSERT INTO fact_purges (source_id, visibility, subject, fact_hash, request_id, actor, reason)
     VALUES ('default', 'world', $1, gbrain_fact_fingerprint($2), $3::uuid, 'owner', 'asked to forget')`, [subject, claim, request]);
  await purge('*', PURGED_CLAIM, '0a1b2c3d-0000-4000-8000-00000000000a');
  await purge('people/alice-example', PURGED_ABOUT_ALICE, '0a1b2c3d-0000-4000-8000-00000000000b');

  await engine.executeRaw(
    `INSERT INTO access_tokens (name, token_hash, scopes, permissions, source_grant, source_id, federated_read, allowed_operations, takes_holders,
        grant_revision, min_trust, private_pages, private_facts, last_used_at, read_shared_revision)
     VALUES ('agent-key', $1, ARRAY['read','write'], '{"takes_holders":["world"],"setup_reads":["wiki"]}'::jsonb, 'federated', 'default',
        ARRAY['default','wiki'], ARRAY['query','get_page'], ARRAY['world'], 3, 'tool_observed', 'granted_sources', 'none', '2026-03-05T00:00:00Z', 2)`, [LIVE_TOKEN_HASH]);
  await engine.executeRaw(`INSERT INTO access_tokens (name, token_hash, revoked_at) VALUES ('old-key', $1, '2026-03-07T00:00:00Z')`, [REVOKED_TOKEN_HASH]);
  return ids;
}

const OPEN_POLICY = { honorAliases: false, entityPrivacy: false };
const rustMs = (t: unknown) => (t instanceof Date ? t.getTime() : Date.parse(String(t)));

/** `to_char` of a timestamp as the store prints it: ISO with milliseconds, UTC. */
const isoMs = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

type Brain = Awaited<ReturnType<typeof openRustStore>>['brain'];

/** Opens the seeded store at `storePath` and runs one family check against its brain. */
export async function onSeededBrain(addon: RustAddon, storePath: string, check: (brain: Brain) => Promise<void>): Promise<void> {
  const store = await openRustStore(addon, storePath);
  try { await check(store.brain); } finally { await store.close(); }
}

// Each check asks one family's own read the question the primary answers. Every one also needs the primary to hold rows, so a
// fixture that stopped producing them cannot pass.

/** entity_identities: listEntityIdentityRows and readEntityIdentityIdsForPages. */
export async function expectIdentityParity(primary: BrainEngine, brain: Brain): Promise<void> {
  const members = await listEntityIdentities(primary, {});
  expect(members.length).toBe(3);
  const mine = (rows: Array<{ entity_id: string; source_id: string; slug: string; confidence: unknown; established_by: string; established_at: unknown; canonical: boolean }>) =>
    rows.map(m => ({ entity_id: m.entity_id, source_id: m.source_id, slug: m.slug, confidence: Number(m.confidence), established_by: m.established_by, at: rustMs(m.established_at), canonical: m.canonical }));
  expect(mine(await brain.listEntityIdentities({}))).toEqual(mine(members));
  expect(await brain.readEntityIdentityIdsForPages(['default'], ['people/bob-example'])).toEqual([{ entity_id: 'person/alice', source_id: 'default', slug: 'people/bob-example' }]);
}

/** link_relationships: readLinkRelationshipEvidence's `existing` rows of the relationship. */
export async function expectRelationshipParity(primary: BrainEngine, brain: Brain, ids: StateFixtureIds): Promise<void> {
  const existing = await primary.executeRaw(
    `SELECT from_page_id::int AS from_page_id, to_page_id::int AS to_page_id, link_type, scope, ${isoMs('recorded_at')} AS recorded_at,
            ${isoMs('retired_at')} AS retired_at, evidence_hash FROM link_relationships ORDER BY scope`);
  expect(existing.length).toBe(2);
  const evidence = await brain.readLinkRelationshipEvidence({ keys: [{ from_page_id: ids.alice, to_page_id: ids.acme, link_type: 'works_at' }], originPolicy: OPEN_POLICY });
  expect([...evidence.existing].sort((a: { scope: string }, b: { scope: string }) => a.scope.localeCompare(b.scope))).toEqual(existing);
}

/** link_transitions: readLinkRelationshipEvidence's `transitions`, and the manual statements a page's copy carries. */
export async function expectTransitionParity(primary: BrainEngine, brain: Brain, ids: StateFixtureIds): Promise<void> {
  const transitions = await primary.executeRaw<{ kind: string; occurred_on: string }>(
    `SELECT lt.from_page_id::int AS from_page_id, lt.to_page_id::int AS to_page_id, lt.link_type, lt.origin_page_id::int AS origin_id, lt.kind,
            lt.occurred_on::text AS occurred_on, lt.producer, ${isoMs('lt.created_at')} AS created_at, f.source_id, true AS origin_public
       FROM link_transitions lt JOIN pages f ON f.id = lt.from_page_id ORDER BY lt.id`);
  expect(transitions.length).toBe(2);
  const evidence = await brain.readLinkRelationshipEvidence({ keys: [{ from_page_id: ids.alice, to_page_id: ids.acme, link_type: 'works_at' }], originPolicy: OPEN_POLICY });
  const orderOf = (rows: Array<{ kind: string; occurred_on: string }>) => [...rows].sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.kind.localeCompare(b.kind));
  expect(orderOf(evidence.transitions)).toEqual(orderOf(transitions));
  expect(await brain.listManualLinkTransitions('default', 'people/alice-example')).toEqual([
    { to_slug: 'companies/acme-example', to_source_id: 'default', link_type: 'works_at', kind: 'start', occurred_on: '2021-04-01' },
  ]);
}

/** fact_purges: isFactPurged and hasFactPurges. */
export async function expectPurgeParity(primary: BrainEngine, brain: Brain): Promise<void> {
  const purged = async (visibility: string, claim: string, entity: string | null) => (await primary.executeRaw(
    `SELECT 1 FROM fact_purges WHERE source_id = 'default' AND visibility = $1 AND fact_hash = gbrain_fact_fingerprint($2) AND (subject = '*' OR subject = $3::text) LIMIT 1`,
    [visibility, claim, entity])).length > 0;
  for (const [visibility, claim, entity] of [
    ['world', PURGED_CLAIM, null], ['world', PURGED_CLAIM, 'people/bob-example'], ['private', PURGED_CLAIM, null],
    ['world', PURGED_ABOUT_ALICE, 'people/alice-example'], ['world', PURGED_ABOUT_ALICE, 'people/bob-example'], ['world', PURGED_ABOUT_ALICE, null],
    ['world', 'A claim nobody purged', null],
  ] as const) {
    expect(await brain.isFactPurged('default', visibility, claim, entity), `${visibility} ${claim} ${entity}`).toBe(await purged(visibility, claim, entity));
  }
  expect(await purged('world', PURGED_CLAIM, null)).toBe(true);
  expect(await brain.hasFactPurges('default')).toBe(true);
}

/** access_tokens: the bearer check by hash, the id read, the list and the name lookup. */
export async function expectTokenParity(primary: BrainEngine, brain: Brain): Promise<void> {
  const row = (await primary.executeRaw(`SELECT * FROM access_tokens WHERE token_hash = $1 AND revoked_at IS NULL`, [LIVE_TOKEN_HASH]))[0]!;
  const rustRow = await brain.readActiveAccessTokenByHash(LIVE_TOKEN_HASH);
  expect(rustRow).not.toBeNull();
  const { token_hash: _hash, ...primaryColumns } = row;
  const normal = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.getTime() : k.endsWith('_at') && typeof v === 'string' ? rustMs(v) : v]));
  expect(normal(rustRow)).toEqual(normal(primaryColumns));
  expect(await brain.readActiveAccessTokenByHash(REVOKED_TOKEN_HASH)).toBeNull();
  expect(await brain.readActiveAccessTokenByHash('a hash no token has')).toBeNull();
  expect(await brain.accessTokenLive(String(row.id))).toBe(true);
  const listed = (await brain.listAccessTokens()) as Array<{ id: string; name: string; revoked_at: unknown }>;
  expect(listed.map(t => t.name).sort()).toEqual(['agent-key', 'old-key']);
  expect(listed.find(t => t.name === 'old-key')!.revoked_at).not.toBeNull();
  expect(await brain.findActiveAccessTokens('agent-key')).toEqual([{ id: String(row.id), name: 'agent-key', min_trust: 'tool_observed' }]);
}
