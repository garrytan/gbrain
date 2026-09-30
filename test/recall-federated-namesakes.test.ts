/**
 * Federated recall({ entity }) keeps same-slug namesakes in different sources
 * apart. The identity key is (source_id, slug): two pages that share a slug in
 * two granted sources are different entities unless an entity-identity group
 * links them. Unlinked namesakes are refused (no facts, the candidates named
 * so the caller can pick a source); linked members merge; every fact row
 * carries its source_id. (gbrain-evals N4 entity-resolution, bug 2.)
 *
 * Synthetic data only.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operations } from '../src/core/operations.ts';
import { linkEntityIdentity } from '../src/core/entity-identity.ts';

let engine: PGLiteEngine;
const recall = operations.find(o => o.name === 'recall')!;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('team', 'team', '{}')`);
  for (const source of ['default', 'team']) {
    // Two different people who share a name and slug, one per source.
    await importFromContent(engine, 'people/sam-example',
      `---\ntitle: Sam Example\ntype: person\n---\n\n# Sam Example\n\nThe ${source} Sam.\n`, { noEmbed: true, sourceId: source });
    await engine.insertFact({ fact: `fact about the ${source} Sam`, entity_slug: 'people/sam-example', source: 'note', visibility: 'world', embedding: null }, { source_id: source });
    // One person with a page in each source, linked by an identity group.
    await importFromContent(engine, 'people/theo-example',
      `---\ntitle: Theo Example\ntype: person\n---\n\n# Theo Example\n`, { noEmbed: true, sourceId: source });
    await engine.insertFact({ fact: `theo fact from ${source}`, entity_slug: 'people/theo-example', source: 'note', visibility: 'world', embedding: null }, { source_id: source });
  }
  await engine.insertFact({ fact: 'only-default fact', entity_slug: 'people/uma-example', source: 'note', visibility: 'world', embedding: null }, { source_id: 'default' });
  await linkEntityIdentity(engine, { entityId: 'theo', slug: 'people/theo-example', sourceId: 'default' });
  await linkEntityIdentity(engine, { entityId: 'theo', slug: 'people/theo-example', sourceId: 'team' });
});

afterAll(async () => {
  await engine.disconnect();
});

const federated = () => ({ engine, config: {}, logger: console, dryRun: false, remote: true, sourceId: 'default', auth: { allowedSources: ['default', 'team'] } }) as any;
const single = () => ({ engine, config: {}, logger: console, dryRun: false, remote: true, sourceId: 'default', auth: { allowedSources: ['default'] } }) as any;

describe('federated recall({ entity }) and same-slug namesakes', () => {
  for (const entity of ['Sam Example', 'people/sam-example']) {
    test(`unlinked namesakes are refused, not merged (${entity})`, async () => {
      const res = await recall.handler(federated(), { entity }) as any;
      expect(res.facts).toEqual([]);
      expect(res.total).toBe(0);
      expect(res.ambiguous_entity.candidates).toEqual([
        { source_id: 'default', entity_slug: 'people/sam-example' },
        { source_id: 'team', entity_slug: 'people/sam-example' },
      ]);
    });

    test(`the since arm refuses the same way (${entity})`, async () => {
      const res = await recall.handler(federated(), { entity, since: '3650d' }) as any;
      expect(res.facts).toEqual([]);
      expect(res.ambiguous_entity.candidates.map((c: any) => c.source_id)).toEqual(['default', 'team']);
    });
  }

  test('source_id narrows the read to one namesake, labelled', async () => {
    const res = await recall.handler(federated(), { entity: 'Sam Example', source_id: 'team' }) as any;
    expect(res.facts.map((f: any) => [f.fact, f.source_id])).toEqual([['fact about the team Sam', 'team']]);
    expect(res.ambiguous_entity).toBeUndefined();
  });

  test('identity-linked members merge, each row labelled with its source', async () => {
    const res = await recall.handler(federated(), { entity: 'Theo Example' }) as any;
    expect(res.ambiguous_entity).toBeUndefined();
    expect(res.facts.map((f: any) => [f.fact, f.source_id]).sort()).toEqual([
      ['theo fact from default', 'default'],
      ['theo fact from team', 'team'],
    ]);
  });

  test('an entity with facts in one granted source is unaffected, and labelled', async () => {
    const res = await recall.handler(federated(), { entity: 'people/uma-example' }) as any;
    expect(res.facts.map((f: any) => [f.fact, f.source_id])).toEqual([['only-default fact', 'default']]);
  });

  test('a single-source caller reads its own Sam, labelled', async () => {
    const res = await recall.handler(single(), { entity: 'Sam Example' }) as any;
    expect(res.facts.map((f: any) => [f.fact, f.source_id])).toEqual([['fact about the default Sam', 'default']]);
  });
});
