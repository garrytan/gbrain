/**
 * #4224 — cross-source entity identity (federation v1).
 *
 * Covers: the v137 entity_identities migration, the manual-only helpers
 * (link/unlink/list, identity key = (source_id, slug)), the three ops
 * (localOnly writes, source-scoped list), and the flag-gated retrieval
 * union on get_links/get_backlinks (default OFF; never widens a federated
 * caller's grant).
 *
 * PGLite in-memory. Engine parity comes free: every helper goes through
 * engine.executeRaw with ONE SQL text (no per-engine SQL) — see also the
 * DATABASE_URL-gated check in test/e2e/engine-parity.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  linkEntityIdentity,
  unlinkEntityIdentity,
  listEntityIdentities,
  unionLinksAcrossIdentity,
  isIdentityUnionEnabled,
  validateEntityId,
  ENTITY_IDENTITY_UNION_CONFIG_KEY,
} from '../src/core/entity-identity.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

const localCtx = (over: Partial<OperationContext> = {}): OperationContext =>
  ({ engine, remote: false, ...over } as unknown as OperationContext);
const remoteCtx = (over: Partial<OperationContext> = {}): OperationContext =>
  ({ engine, remote: true, ...over } as unknown as OperationContext);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  for (const t of ['entity_identities', 'content_chunks', 'links', 'tags', 'timeline_entries', 'page_versions', 'pages']) {
    await (engine as unknown as { db: { exec(q: string): Promise<unknown> } }).db.exec(`DELETE FROM ${t}`);
  }
  await engine.unsetConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('team-brain', 'team-brain', '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
  );
});

async function seedTwoSourceAlice() {
  await engine.putPage('people/alice', {
    type: 'person', title: 'Alice', compiled_truth: 'wiki alice', timeline: '',
  }, { sourceId: 'default' });
  await engine.putPage('people/alice-chen', {
    type: 'person', title: 'Alice Chen', compiled_truth: 'team alice', timeline: '',
  }, { sourceId: 'team-brain' });
}

describe('entity_identities migration (v137)', () => {
  test('table exists with the documented shape', async () => {
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'entity_identities'`,
    );
    const cols = new Set(rows.map(r => r.column_name));
    for (const c of ['entity_id', 'source_id', 'page_id', 'confidence', 'established_by', 'established_at', 'canonical']) {
      expect(cols.has(c)).toBe(true);
    }
  });
});

describe('identity helpers — (source_id, slug) is the key', () => {
  beforeEach(seedTwoSourceAlice);

  test('link + list round-trip across two sources', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain', canonical: true });

    const members = await listEntityIdentities(engine, { entityId: 'alice-chen' });
    expect(members).toHaveLength(2);
    // Canonical sorts first.
    expect(members[0]!.slug).toBe('people/alice-chen');
    expect(members[0]!.canonical).toBe(true);
    expect(members[0]!.source_id).toBe('team-brain');
    expect(members[1]!.slug).toBe('people/alice');
    expect(members[1]!.established_by).toBe('manual');
    expect(members[1]!.confidence).toBe(1);
  });

  test('linking a missing page throws (identity key is (source_id, slug))', async () => {
    await expect(
      linkEntityIdentity(engine, { entityId: 'ghost', slug: 'people/alice', sourceId: 'team-brain' }),
    ).rejects.toThrow(/page not found/);
  });

  test('re-linking MOVES the page to the new identity', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'someone-else', slug: 'people/alice', sourceId: 'default' });

    expect(await listEntityIdentities(engine, { entityId: 'alice-chen' })).toHaveLength(0);
    const moved = await listEntityIdentities(engine, { entityId: 'someone-else' });
    expect(moved).toHaveLength(1);
    expect(moved[0]!.slug).toBe('people/alice');
  });

  test('a new canonical demotes the previous one (at most one per group)', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default', canonical: true });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain', canonical: true });

    const members = await listEntityIdentities(engine, { entityId: 'alice-chen' });
    expect(members.filter(m => m.canonical)).toHaveLength(1);
    expect(members.find(m => m.canonical)!.slug).toBe('people/alice-chen');
  });

  test('unlink removes exactly the (source_id, slug) member', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain' });

    expect(await unlinkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' })).toBe(true);
    expect(await unlinkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' })).toBe(false);
    const members = await listEntityIdentities(engine, { entityId: 'alice-chen' });
    expect(members).toHaveLength(1);
    expect(members[0]!.source_id).toBe('team-brain');
  });

  test('list by member slug finds the whole group', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain' });

    const members = await listEntityIdentities(engine, { slug: 'people/alice' });
    expect(members).toHaveLength(2);
  });

  test('allowedSources restricts member visibility', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain' });

    const members = await listEntityIdentities(engine, { entityId: 'alice-chen', allowedSources: ['default'] });
    expect(members).toHaveLength(1);
    expect(members[0]!.source_id).toBe('default');
  });

  test('validateEntityId rejects junk handles', () => {
    expect(() => validateEntityId('has space')).toThrow(/invalid entity_id/);
    expect(() => validateEntityId('')).toThrow(/invalid entity_id/);
    expect(() => validateEntityId('UPPER')).toThrow(/invalid entity_id/);
    expect(validateEntityId('alice-chen')).toBe('alice-chen');
  });
});

describe('entity identity ops (v1 manual-only)', () => {
  beforeEach(seedTwoSourceAlice);

  test('write ops are localOnly; list is not', () => {
    expect(operationsByName.entity_identity_link!.localOnly).toBe(true);
    expect(operationsByName.entity_identity_unlink!.localOnly).toBe(true);
    expect(operationsByName.entity_identity_list!.localOnly).toBeUndefined();
    expect(operationsByName.entity_identity_link!.scope).toBe('write');
    expect(operationsByName.entity_identity_list!.scope).toBe('read');
  });

  test('link + list + unlink through the op handlers', async () => {
    await operationsByName.entity_identity_link!.handler(localCtx(), {
      entity_id: 'alice-chen', slug: 'people/alice', source_id: 'default',
    });
    await operationsByName.entity_identity_link!.handler(localCtx(), {
      entity_id: 'alice-chen', slug: 'people/alice-chen', source_id: 'team-brain', canonical: true,
    });

    const listed = await operationsByName.entity_identity_list!.handler(localCtx(), {
      entity_id: 'alice-chen',
    }) as { identities: Array<{ entity_id: string; canonical: { slug: string } | null; members: unknown[] }> };
    expect(listed.identities).toHaveLength(1);
    expect(listed.identities[0]!.members).toHaveLength(2);
    expect(listed.identities[0]!.canonical?.slug).toBe('people/alice-chen');

    const un = await operationsByName.entity_identity_unlink!.handler(localCtx(), {
      entity_id: 'alice-chen', slug: 'people/alice', source_id: 'default',
    }) as { unlinked: boolean };
    expect(un.unlinked).toBe(true);
  });

  test('remote federated caller only sees granted sources in list', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain' });

    const listed = await operationsByName.entity_identity_list!.handler(
      remoteCtx({ auth: { allowedSources: ['default'] } as never }),
      { entity_id: 'alice-chen' },
    ) as { identities: Array<{ members: Array<{ source_id: string }> }> };
    expect(listed.identities).toHaveLength(1);
    expect(listed.identities[0]!.members).toHaveLength(1);
    expect(listed.identities[0]!.members[0]!.source_id).toBe('default');
  });
});

describe('flag-gated retrieval union (#4224 v1: link read ops)', () => {
  beforeEach(async () => {
    await seedTwoSourceAlice();
    // Give each alice an outgoing edge in her own source.
    await engine.putPage('companies/acme', {
      type: 'company', title: 'Acme', compiled_truth: 'acme', timeline: '',
    }, { sourceId: 'default' });
    await engine.putPage('companies/widget-co', {
      type: 'company', title: 'Widget Co', compiled_truth: 'widget', timeline: '',
    }, { sourceId: 'team-brain' });
    await engine.addLinksBatch([
      { from_slug: 'people/alice', to_slug: 'companies/acme', link_source: 'manual', from_source_id: 'default', to_source_id: 'default' },
      { from_slug: 'people/alice-chen', to_slug: 'companies/widget-co', link_source: 'manual', from_source_id: 'team-brain', to_source_id: 'team-brain' },
    ]);
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice-chen', slug: 'people/alice-chen', sourceId: 'team-brain' });
  });

  test('flag defaults OFF — get_links returns only the page\'s own edges', async () => {
    expect(await isIdentityUnionEnabled(engine)).toBe(false);
    const links = await operationsByName.get_links!.handler(localCtx(), { slug: 'people/alice' }) as Array<{ to_slug: string }>;
    expect(links.some(l => l.to_slug === 'companies/acme')).toBe(true);
    expect(links.some(l => l.to_slug === 'companies/widget-co')).toBe(false);
  });

  test('flag ON — get_links unions co-member edges (dedup\'d)', async () => {
    await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'true');
    expect(await isIdentityUnionEnabled(engine)).toBe(true);
    const links = await operationsByName.get_links!.handler(localCtx(), { slug: 'people/alice' }) as Array<{ to_slug: string }>;
    expect(links.some(l => l.to_slug === 'companies/acme')).toBe(true);
    expect(links.some(l => l.to_slug === 'companies/widget-co')).toBe(true);
  });

  test('union never widens a federated caller\'s grant', async () => {
    await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'true');
    const links = await operationsByName.get_links!.handler(
      remoteCtx({ auth: { allowedSources: ['default'] } as never }),
      { slug: 'people/alice' },
    ) as Array<{ to_slug: string }>;
    expect(links.some(l => l.to_slug === 'companies/acme')).toBe(true);
    expect(links.some(l => l.to_slug === 'companies/widget-co')).toBe(false);
  });

  test('unionLinksAcrossIdentity is a pure pass-through for non-members', async () => {
    await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'true');
    const base = await engine.getLinks('companies/acme', { sourceId: 'default' });
    const out = await unionLinksAcrossIdentity(engine, 'companies/acme', base, 'out');
    expect(out).toEqual(base);
  });

  test('get_backlinks unions incoming edges when flag ON', async () => {
    await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'true');
    // Backlinks of acme: from people/alice. Link widget-co's identity? Instead:
    // union on the entity pages themselves — backlinks TO alice from a note.
    await engine.putPage('notes/n1', { type: 'note', title: 'N1', compiled_truth: 'n', timeline: '' }, { sourceId: 'default' });
    await engine.putPage('notes/n2', { type: 'note', title: 'N2', compiled_truth: 'n', timeline: '' }, { sourceId: 'team-brain' });
    await engine.addLinksBatch([
      { from_slug: 'notes/n1', to_slug: 'people/alice', link_source: 'manual', from_source_id: 'default', to_source_id: 'default' },
      { from_slug: 'notes/n2', to_slug: 'people/alice-chen', link_source: 'manual', from_source_id: 'team-brain', to_source_id: 'team-brain' },
    ]);
    const backs = await operationsByName.get_backlinks!.handler(localCtx(), { slug: 'people/alice' }) as Array<{ from_slug: string }>;
    expect(backs.some(l => l.from_slug === 'notes/n1')).toBe(true);
    expect(backs.some(l => l.from_slug === 'notes/n2')).toBe(true);
  });
});

describe('#4224 review — the identity key is (source_id, slug) in the union too', () => {
  // SAME slug in two sources: `people/alice` exists in BOTH default and
  // team-brain, each with its own outgoing edge.
  beforeEach(async () => {
    await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'true');
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice (wiki)', compiled_truth: 'wiki alice', timeline: '',
    }, { sourceId: 'default' });
    await engine.putPage('people/alice', {
      type: 'person', title: 'Alice (team)', compiled_truth: 'team alice', timeline: '',
    }, { sourceId: 'team-brain' });
    await engine.putPage('companies/acme', {
      type: 'company', title: 'Acme', compiled_truth: 'acme', timeline: '',
    }, { sourceId: 'default' });
    await engine.putPage('companies/widget-co', {
      type: 'company', title: 'Widget Co', compiled_truth: 'widget', timeline: '',
    }, { sourceId: 'team-brain' });
    await engine.addLinksBatch([
      { from_slug: 'people/alice', to_slug: 'companies/acme', link_source: 'manual', from_source_id: 'default', to_source_id: 'default' },
      { from_slug: 'people/alice', to_slug: 'companies/widget-co', link_source: 'manual', from_source_id: 'team-brain', to_source_id: 'team-brain' },
    ]);
  });

  test('same-slug co-member in ANOTHER source IS unioned (only the base pair is excluded)', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice', slug: 'people/alice', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'alice', slug: 'people/alice', sourceId: 'team-brain' });

    // Helper-level: base = (default, people/alice); the team-brain member
    // shares the slug but is a REAL co-member — pre-fix `m.slug !== slug`
    // dropped it and its edges never merged.
    const base = await engine.getLinks('people/alice', { sourceId: 'default' });
    const out = await unionLinksAcrossIdentity(engine, 'people/alice', base, 'out', { sourceId: 'default' });
    expect(out.some(l => l.to_slug === 'companies/acme')).toBe(true);
    expect(out.some(l => l.to_slug === 'companies/widget-co')).toBe(true);

    // Op-level: the scalar ctx scope threads through as the base source.
    const links = await operationsByName.get_links!.handler(
      localCtx({ sourceId: 'default' }), { slug: 'people/alice' },
    ) as Array<{ to_slug: string }>;
    expect(links.some(l => l.to_slug === 'companies/widget-co')).toBe(true);
  });

  test('NON-member base page with a same-slug member elsewhere is NOT unioned', async () => {
    // Only the TEAM alice is a member, grouped with a third page that has
    // its own edge. The default alice is NOT a member.
    await engine.putPage('people/alicia', {
      type: 'person', title: 'Alicia', compiled_truth: 'alicia', timeline: '',
    }, { sourceId: 'team-brain' });
    await engine.addLinksBatch([
      { from_slug: 'people/alicia', to_slug: 'companies/widget-co', link_source: 'manual', from_source_id: 'team-brain', to_source_id: 'team-brain' },
    ]);
    await linkEntityIdentity(engine, { entityId: 'alice', slug: 'people/alice', sourceId: 'team-brain' });
    await linkEntityIdentity(engine, { entityId: 'alice', slug: 'people/alicia', sourceId: 'team-brain' });

    // Pre-fix the unscoped slug sub-select matched the TEAM alice's group and
    // unioned foreign edges into a read of the (default) NON-member page.
    const base = await engine.getLinks('people/alice', { sourceId: 'default' });
    const out = await unionLinksAcrossIdentity(engine, 'people/alice', base, 'out', { sourceId: 'default' });
    expect(out).toEqual(base);

    const links = await operationsByName.get_links!.handler(
      localCtx({ sourceId: 'default' }), { slug: 'people/alice' },
    ) as Array<{ to_slug: string }>;
    expect(links.some(l => l.to_slug === 'companies/acme')).toBe(true);
    expect(links.some(l => l.to_slug === 'companies/widget-co')).toBe(false);
  });

  test('listEntityIdentities slugSourceId pins group resolution to the (slug, source) pair', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice', slug: 'people/alice', sourceId: 'team-brain' });
    // Unscoped slug lookup still finds the group (trusted cross-source view)…
    expect(await listEntityIdentities(engine, { slug: 'people/alice' })).toHaveLength(1);
    // …but the source-scoped lookup only matches the member pair.
    expect(await listEntityIdentities(engine, { slug: 'people/alice', slugSourceId: 'default' })).toHaveLength(0);
    expect(await listEntityIdentities(engine, { slug: 'people/alice', slugSourceId: 'team-brain' })).toHaveLength(1);
  });

  test('without slugSourceId, the seed sub-select is confined to allowedSources', async () => {
    await linkEntityIdentity(engine, { entityId: 'alice', slug: 'people/alice', sourceId: 'team-brain' });
    // A grant that cannot see team-brain must not discover the group through
    // the team-brain seed page.
    expect(await listEntityIdentities(engine, {
      slug: 'people/alice', allowedSources: ['default'],
    })).toHaveLength(0);
    expect(await listEntityIdentities(engine, {
      slug: 'people/alice', allowedSources: ['team-brain'],
    })).toHaveLength(1);
  });
});
