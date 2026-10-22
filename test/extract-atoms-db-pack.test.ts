/**
 * Atom extraction resolves its type allowlist through the engine, so the
 * brain's DB-plane pack selection (`schema_pack`, and the per-source
 * `schema_pack.source.<id>`) applies the way it does for every other
 * engine-scoped pack reader. Before, the resolver read only the file/env
 * tiers: a brain whose pack was chosen with `gbrain config set schema_pack …`
 * kept extracting the types the default pack allows.
 *
 * gbrain-recommended declares `source` not extractable (#5756) while
 * gbrain-base declares it extractable, so a `source` page is the probe. The
 * env tier is cleared so only the DB plane can select the pack.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { countExtractAtomsBacklog, discoverExtractablePages } from '../src/core/cycle/extract-atoms.ts';

describe('atom extraction honors the DB-plane schema pack', () => {
  let engine: PGLiteEngine;
  const prose = (n: string) => `A durable statement about ${n}, recorded in prose with enough context to extract. `.repeat(10);
  const slugs = async () => (await discoverExtractablePages(engine, 'default')).map(p => p.slug).sort();

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw(`DELETE FROM config WHERE key = 'schema_pack' OR key LIKE 'schema_pack.source.%'`);
    await engine.putPage('sources/example-statute', { type: 'source', title: 'Example statute', compiled_truth: prose('the statute') } as never);
    await engine.putPage('meetings/example-sync', { type: 'meeting', title: 'Example sync', compiled_truth: prose('the sync') } as never);
  });

  test('a brain-wide schema_pack that excludes a type removes it from discovery and the backlog', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await engine.setConfig('schema_pack', 'gbrain-recommended');
      expect(await slugs()).toEqual(['meetings/example-sync']);
      expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    });
  });

  test('a per-source schema_pack.source.<id> applies to that source', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      await engine.setConfig('schema_pack.source.default', 'gbrain-recommended');
      expect(await slugs()).toEqual(['meetings/example-sync']);
    });
  });

  test('with no DB-plane selection the default pack still discovers both pages', async () => {
    await withEnv({ GBRAIN_SCHEMA_PACK: undefined }, async () => {
      expect(await slugs()).toEqual(['meetings/example-sync', 'sources/example-statute']);
    });
  });
});
