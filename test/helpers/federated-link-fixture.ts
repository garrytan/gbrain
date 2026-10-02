/**
 * #5827 — shared multi-source federated link fixture (PGLite unit test and the
 * Postgres E2E twin). `default` is federated but EMPTY, so a no-grant caller
 * whose scalar scope collapses to `default` reads nothing unless the link ops
 * widen to the federated set.
 *
 *   default   federated (seeded)          no pages
 *   business  federated                   companies/acme-example, people/alice-example,
 *                                         people/secret-example (visibility: private)
 *   wiki      federated                   people/alice-example (same slug as business),
 *                                         topics/widget-co, people/al-example, topics/gadget-co
 *   priv      never federated             notes/priv-note, companies/priv-only-co, people/alice-priv
 *   arch      federated, ARCHIVED         notes/arch-note
 *
 * Edges: alice(business)→acme, secret→acme, alice(wiki)→widget-co,
 * al-example→gadget-co, priv-note→acme (cross-source priv→business),
 * priv-note→priv-only-co, alice-priv→priv-note, arch-note→acme.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { linkEntityIdentity, ENTITY_IDENTITY_UNION_CONFIG_KEY } from '../../src/core/entity-identity.ts';

export const FEDERATED_SET = ['default', 'business', 'wiki'] as const;

const SOURCES: Array<{ id: string; config: string; archived: boolean }> = [
  { id: 'business', config: '{"federated": true}', archived: false },
  { id: 'wiki', config: '{"federated": true}', archived: false },
  { id: 'priv', config: '{}', archived: false },
  { id: 'arch', config: '{"federated": true}', archived: true },
];

const PAGES: Array<{ sourceId: string; slug: string; type: string; private?: boolean }> = [
  { sourceId: 'business', slug: 'companies/acme-example', type: 'company' },
  { sourceId: 'business', slug: 'people/alice-example', type: 'person' },
  { sourceId: 'business', slug: 'people/secret-example', type: 'person', private: true },
  { sourceId: 'wiki', slug: 'people/alice-example', type: 'person' },
  { sourceId: 'wiki', slug: 'topics/widget-co', type: 'note' },
  { sourceId: 'wiki', slug: 'people/al-example', type: 'person' },
  { sourceId: 'wiki', slug: 'topics/gadget-co', type: 'note' },
  { sourceId: 'priv', slug: 'notes/priv-note', type: 'note' },
  { sourceId: 'priv', slug: 'companies/priv-only-co', type: 'company' },
  { sourceId: 'priv', slug: 'people/alice-priv', type: 'person' },
  { sourceId: 'arch', slug: 'notes/arch-note', type: 'note' },
];

const LINKS: Array<[fromSource: string, from: string, toSource: string, to: string, type: string]> = [
  ['business', 'people/alice-example', 'business', 'companies/acme-example', 'works_at'],
  ['business', 'people/secret-example', 'business', 'companies/acme-example', 'advises'],
  ['wiki', 'people/alice-example', 'wiki', 'topics/widget-co', 'mentions'],
  ['wiki', 'people/al-example', 'wiki', 'topics/gadget-co', 'mentions'],
  ['priv', 'notes/priv-note', 'business', 'companies/acme-example', 'cites'],
  ['priv', 'notes/priv-note', 'priv', 'companies/priv-only-co', 'cites'],
  ['priv', 'people/alice-priv', 'priv', 'notes/priv-note', 'authored'],
  ['arch', 'notes/arch-note', 'business', 'companies/acme-example', 'cites'],
];

export async function seedFederatedLinkFixture(engine: BrainEngine): Promise<void> {
  for (const s of SOURCES) {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config, archived)
       VALUES ($1, $1, $2, $3::text::jsonb, $4)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, archived = EXCLUDED.archived`,
      [s.id, `/tmp/gbrain-5827-${s.id}`, s.config, s.archived],
    );
  }
  await engine.executeRaw(`UPDATE sources SET config = '{"federated": true}'::jsonb WHERE id = 'default'`);
  for (const page of PAGES) {
    await engine.putPage(page.slug, {
      type: page.type as never,
      title: `${page.slug} (${page.sourceId})`,
      compiled_truth: `${page.slug} in ${page.sourceId}`,
      frontmatter: page.private ? { visibility: 'private' } : {},
    }, { sourceId: page.sourceId });
  }
  for (const [fromSourceId, from, toSourceId, to, type] of LINKS) {
    await engine.addLink(from, to, `${type} ctx`, type, 'manual', undefined, undefined, { fromSourceId, toSourceId });
  }
}

/** One identity across business, wiki and the never-federated priv source. */
export async function seedAliceIdentity(engine: BrainEngine): Promise<void> {
  await engine.setConfig(ENTITY_IDENTITY_UNION_CONFIG_KEY, 'true');
  await linkEntityIdentity(engine, { entityId: 'person/alice', slug: 'people/alice-example', sourceId: 'business' });
  await linkEntityIdentity(engine, { entityId: 'person/alice', slug: 'people/al-example', sourceId: 'wiki' });
  await linkEntityIdentity(engine, { entityId: 'person/alice', slug: 'people/alice-priv', sourceId: 'priv' });
}

/** `from(source)->to(source)` keys, sorted, for set-style assertions. */
export function edgeKeys(rows: readonly unknown[]): string[] {
  return (rows as Array<Record<string, unknown>>).map((r) => `${r.from_slug}(${r.from_source_id})->${r.to_slug}(${r.to_source_id})`).sort();
}
