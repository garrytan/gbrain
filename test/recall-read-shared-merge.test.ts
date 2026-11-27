/**
 * GST-2898 D3-B (company brains, C1): recall merges the one namesake split the read-shared switch creates.
 * 1. Protects: a switched key whose write source is private gets both sets of facts about acme-example, from its
 *    write source and one shared source, each fact labelled with its source_id, and merged_sources names the pair, in
 *    the entity, since and question arms.
 * 2. Owner pin: every other split keeps today's answer (0 facts, ambiguous_entity): an unscoped key, a key with the
 *    switch off, a switched key writing into a shared source, a guest-source namesake, and two shared namesakes.
 * 3. Fails when: the merge reaches a key without the switch, a guest source, or a split between two shared sources.
 * 4. Real seams: recall's handler on a repo-less brain, the shared set read from the sources table, PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations } from '../src/core/operations.ts';
import { asOwner } from './helpers/owner-tier.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const recall = operations.find(o => o.name === 'recall')!;
const PRIVATE_ALICE = 'private-alice-example';

for (const kind of testBackends()) {
  describe('recall merges the read-shared split (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const ctx = (sourceId: string, allowedSources: string[] | undefined, readShared: boolean) => ({
      engine, config: {}, logger: console, dryRun: false, remote: true, sourceId,
      auth: { sourceId, ...(allowedSources ? { allowedSources } : {}), hasSourceGrant: allowedSources !== undefined, ...(readShared ? { readShared: true } : {}), member: { id: 'alice-example', groups: [] } },
    }) as never;
    const ask = async (c: never, params: Record<string, unknown>) => {
      const res = await recall.handler(c, params) as { facts: Array<{ fact: string; source_id: string }>; ambiguous_entity?: { candidates: Array<{ source_id: string }> }; merged_sources?: string[] };
      return { facts: res.facts.map(f => [f.source_id, f.fact]).sort(), ambiguous: res.ambiguous_entity?.candidates.map(c => c.source_id).sort() ?? null, merged: res.merged_sources ?? null };
    };
    const SWITCHED = [PRIVATE_ALICE, 'default', 'company', 'team'];

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('company', 'company', '{"federated": true}'::jsonb), ('team', 'team', '{"federated": true}'::jsonb),
        ($1, $1, '{"federated": false}'::jsonb), ('guests', 'guests', '{"federated": true}'::jsonb) ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`, [PRIVATE_ALICE]);
      await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', ['alice-example']);
      const entity = async (slug: string, title: string, source: string) => {
        await importFromContent(engine, slug, `---\ntitle: ${title}\ntype: company\n---\n\n# ${title}\n`, { noEmbed: true, sourceId: source });
        await asOwner(engine, tx => tx.insertFact({ valid_from: new Date(), fact: `${title} harbor ledger fact from ${source}`, entity_slug: slug, source: 'note', visibility: 'world', embedding: null }, { source_id: source }));
      };
      for (const source of [PRIVATE_ALICE, 'company']) await entity('companies/acme-example', 'Acme Example', source);
      for (const source of ['company', 'team']) await entity('companies/dana-example', 'Dana Example', source);
      for (const source of [PRIVATE_ALICE, 'guests']) await entity('companies/erin-example', 'Erin Example', source);
      for (const source of ['default', 'company']) await entity('companies/fern-example', 'Fern Example', source);
      await engine.executeRaw(`UPDATE sources SET config = '{"federated": true, "guest": true}'::jsonb WHERE id = 'guests'`);
      await engine.executeRaw("INSERT INTO guest_sources (source_id) VALUES ('guests') ON CONFLICT DO NOTHING");
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);

    const both = [['company', 'Acme Example harbor ledger fact from company'], [PRIVATE_ALICE, 'Acme Example harbor ledger fact from ' + PRIVATE_ALICE]];

    test('a switched key with a private write source gets both sets of facts, labelled, in the entity and since arms', async () => {
      for (const params of [{ entity: 'Acme Example' }, { entity: 'companies/acme-example', since: '3650d' }]) {
        expect(await ask(ctx(PRIVATE_ALICE, SWITCHED, true), params)).toEqual({ facts: both, ambiguous: null, merged: [PRIVATE_ALICE, 'company'] });
      }
    });

    test('the question arm merges the same split', async () => {
      const out = await ask(ctx(PRIVATE_ALICE, SWITCHED, true), { entity: 'Acme Example', question: 'harbor ledger' });
      expect(out.ambiguous).toBeNull();
      expect(out.merged).toEqual([PRIVATE_ALICE, 'company']);
      expect(out.facts).toEqual(both);
    });

    test('every other split keeps today\'s answer: 0 facts and ambiguous_entity', async () => {
      // The same key with the switch off.
      expect(await ask(ctx(PRIVATE_ALICE, SWITCHED, false), { entity: 'Acme Example' })).toEqual({ facts: [], ambiguous: ['company', PRIVATE_ALICE], merged: null });
      // An unscoped key whose write source is default.
      expect(await ask(ctx('default', ['default', 'company', 'team'], false), { entity: 'Fern Example' })).toEqual({ facts: [], ambiguous: ['company', 'default'], merged: null });
      // A switched key writing into a shared source.
      expect(await ask(ctx('company', ['company', 'default', 'team'], true), { entity: 'Dana Example' })).toEqual({ facts: [], ambiguous: ['company', 'team'], merged: null });
      // Two shared namesakes, for the private switched key.
      expect(await ask(ctx(PRIVATE_ALICE, SWITCHED, true), { entity: 'Dana Example' })).toEqual({ facts: [], ambiguous: ['company', 'team'], merged: null });
      // A guest-source namesake, even when the key's own list reads the guest source.
      expect(await ask(ctx(PRIVATE_ALICE, [...SWITCHED, 'guests'], true), { entity: 'Erin Example' })).toEqual({ facts: [], ambiguous: ['guests', PRIVATE_ALICE], merged: null });
    });
  });
}
