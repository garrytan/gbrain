/**
 * #7827: write-time fact subject inference.
 *
 * 1. Protects: the speaker labels the fact extractor itself writes ("User accepted ...", "Assistant recommended ...",
 *    src/core/facts/extract.ts ATTRIBUTION_BLOCK) are no competing name, so a fact that names one entity page links to
 *    it; a page actually named like a label still competes, and an unknown second name still vetoes.
 * 2. Fails when: an attribution label with no page vetoes the link again.
 * 3. Why existing coverage misses it: facts-subject-infer*.test.ts never open a fact with a speaker label.
 * Synthetic data only; PGLite always, Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { inferFactSubject } from '../src/core/facts/subject-infer.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: Array<{ backend: string; engine: BrainEngine }> = [];
let closePostgres: (() => Promise<void>) | undefined;

const page = (engine: BrainEngine, slug: string, title: string, type: string, sourceId = 'default') =>
  importFromContent(engine, slug, '---\ntitle: ' + title + '\ntype: ' + type + '\nfacts_backstop: false\n---\n\n# ' + title + '\n', { noEmbed: true, sourceId });

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema();
    engines.push({ backend: 'pglite', engine });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push({ backend: 'postgres', engine: pg.engine }); closePostgres = pg.close;
  }
  for (const { engine } of engines) {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT DO NOTHING");
    for (const sourceId of ['default', 'source-a']) {
      await page(engine, 'people/alice-example', 'Alice Example', 'person', sourceId);
      await page(engine, 'companies/acme-example', 'Acme Example', 'company', sourceId);
    }
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT DO NOTHING");
    // source-b holds names with a digit-led token, beside one without.
    await page(engine, 'companies/acme-42', 'Acme 42', 'company', 'source-b');
    await page(engine, 'companies/42-northstar', '42 Northstar', 'company', 'source-b');
    await page(engine, 'people/alice-example', 'Alice Example', 'person', 'source-b');
    // source-a also holds real entities named like the two speaker labels.
    for (const title of ['User', 'Assistant']) await page(engine, 'companies/' + title.toLowerCase(), title, 'company', 'source-a');
  }
}, 120_000);

afterAll(async () => {
  for (const { engine } of engines) await engine.disconnect();
  await closePostgres?.();
});

const ALICE = 'people/alice-example';
const ACME = 'companies/acme-example';
const CASES: Array<{ id: string; fact: string; expect: string | null; sourceId?: string }> = [
  { id: 'user-label', fact: 'User met Alice Example on Monday', expect: ALICE },
  { id: 'user-accepted', fact: "User accepted the assistant's suggestion to email Alice Example", expect: ALICE },
  { id: 'assistant-label', fact: 'Assistant recommended Acme Example for the rollout', expect: ACME },
  { id: 'label-mid-sentence', fact: 'Alice Example asked User to send the deck', expect: ALICE },
  { id: 'label-and-unknown-name', fact: 'User met Northstar Example and Alice Example', expect: null },
  { id: 'label-and-two-entities', fact: 'Assistant said Acme Example hired Alice Example', expect: null },
  { id: 'label-page-competes', fact: 'User met Alice Example on Monday', expect: null, sourceId: 'source-a' },
  { id: 'assistant-page-competes', fact: 'Assistant recommended Acme Example for the rollout', expect: null, sourceId: 'source-a' },
];

const DIGIT_CASES: Array<{ id: string; fact: string; expect: string | null }> = [
  { id: 'trailing-digit-token', fact: 'Met Acme 42 on Monday', expect: 'companies/acme-42' },
  { id: 'leading-digit-token', fact: 'Signed the lease with 42 Northstar', expect: 'companies/42-northstar' },
  { id: 'digit-name-and-person', fact: 'Alice Example joined Acme 42', expect: null },
  { id: 'bare-prefix-still-vetoes', fact: 'Met Acme on Monday', expect: null },
  { id: 'other-number-still-vetoes', fact: 'Met Acme 43 on Monday', expect: null },
  { id: 'year-after-person', fact: 'Alice Example moved in 2026', expect: 'people/alice-example' },
];

describe('#7827 fact subject inference: names with a digit-led token', () => {
  for (const backend of backends) {
    const engineFor = () => engines.find(e => e.backend === backend)!.engine;
    for (const mode of ['relink', 'write'] as const) {
      for (const c of DIGIT_CASES) {
        test('[' + backend + '] ' + mode + ': ' + c.id, async () => {
          const result = await inferFactSubject(engineFor(), 'source-b', { fact: c.fact, mode });
          expect(result.slug).toBe(c.expect);
        });
      }
    }
  }
});

describe('#7827 fact subject inference: speaker labels are not names', () => {
  for (const backend of backends) {
    const engineFor = () => engines.find(e => e.backend === backend)!.engine;
    for (const mode of ['relink', 'write'] as const) {
      for (const c of CASES) {
        test('[' + backend + '] ' + mode + ': ' + c.id, async () => {
          const result = await inferFactSubject(engineFor(), c.sourceId ?? 'default', { fact: c.fact, mode });
          expect(result.slug).toBe(c.expect);
        });
      }
    }
  }
});
