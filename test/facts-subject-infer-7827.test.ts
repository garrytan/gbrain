import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { inferFactSubject } from '../src/core/facts/subject-infer.ts';
import { inferConversationSubjects } from '../src/core/facts/conversation-subject-infer.ts';
import { extractCandidates, MAX_CANDIDATES } from '../src/core/context/entity-salience.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines = new Map<string, BrainEngine>();
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema();
    engines.set('pglite', engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.set('postgres', pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines.values()) {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'other')`);
    for (const [slug, title, visibility, sourceId] of [
      ['companies/acme-42', 'Acme 42', 'world', 'default'],
      ['companies/42-northstar', '42 Northstar', 'world', 'default'],
      ['companies/3m', '3M', 'world', 'default'],
      ['people/alice-example', 'Alice Example', 'world', 'default'],
      ['companies/secret-42', 'Secret 42', 'private', 'default'],
      ['companies/foreign-42', 'Foreign 42', 'world', 'other'],
      ['companies/user', 'User', 'world', 'other'],
      ['companies/chf-80', 'CHF 80', 'world', 'other'],
      ['people/alice-example', 'Alice Example', 'world', 'other'],
    ]) {
      await importFromContent(engine, slug!, `---\ntitle: ${title}\ntype: company\nvisibility: ${visibility}\nfacts_backstop: false\n---\n\n# ${title}\n`, { noEmbed: true, sourceId });
    }
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines.values()) await engine.disconnect();
  await closePostgres?.();
});

describe('#7827 exact numeric names and attribution labels', () => {
  for (const backend of backends) for (const mode of ['write', 'relink'] as const) {
    for (const [fact, slug] of [
      ['Acme 42 raised a seed round.', 'companies/acme-42'],
      ['42 Northstar raised a seed round.', 'companies/42-northstar'],
      // Preserve the strict resolver's refusal to guess a bare short name.
      ['3M raised a seed round.', null],
      ['User met Acme 42 on Monday.', 'companies/acme-42'],
      ['Assistant recommended Acme 42.', 'companies/acme-42'],
      ['User Alice Example prefers async updates.', 'people/alice-example'],
      ['User met Alice Example.', 'people/alice-example'],
      ['Acme 42 hired Alice Example.', null],
      ['Unknown 42 hired Alice Example.', null],
      ['Blake met Alice Example.', null],
      ['Foreign 42 raised a seed round.', null],
      ['Has notes including Acme 42.', null],
      ['The invoice total is 42.', null],
    ] as const) {
      test(`[${backend}] ${mode}: ${fact}`, async () => {
        expect((await inferFactSubject(engines.get(backend)!, 'default', { fact, mode })).slug).toBe(slug);
      });
    }
    test(`[${backend}] ${mode}: private numeric name is not inferred remotely`, async () => {
      expect((await inferFactSubject(engines.get(backend)!, 'default', { fact: 'Secret 42 raised a seed round.', mode, excludePrivate: true })).slug).toBeNull();
      expect((await inferFactSubject(engines.get(backend)!, 'default', { fact: 'Secret 42 raised a seed round.', mode })).slug).toBe('companies/secret-42');
    });
    test(`[${backend}] ${mode}: a real User entity still competes`, async () => {
      expect((await inferFactSubject(engines.get(backend)!, 'other', { fact: 'User met Alice Example.', mode })).slug).toBeNull();
      expect((await inferFactSubject(engines.get(backend)!, 'other', { fact: 'User Alice Example prefers async updates.', mode })).slug).toBeNull();
      expect((await inferFactSubject(engines.get(backend)!, 'other', { fact: 'Alice Example paid CHF 80.', mode })).slug).toBeNull();
    });
  }
  for (const backend of backends) {
    test(`[${backend}] conversation inference retains its note and visibility boundary`, async () => {
      const rows = await inferConversationSubjects(engines.get(backend)!, 'default', 'world', [
        { fact: 'User met Acme 42.', context: 'conversations/example' },
        { fact: 'Assistant recommended 42 Northstar.', context: 'conversations/example' },
        { fact: 'User met Secret 42.', context: 'conversations/example' },
      ]);
      expect(rows[0]).toMatchObject({ entity_slug: 'companies/acme-42', context: 'conversations/example — entity inferred from mention' });
      expect(rows[1]).toMatchObject({ entity_slug: 'companies/42-northstar' });
      expect(rows[2]).not.toHaveProperty('entity_slug');
    });
  }
  test('numeric extraction is opt-in, bounded and never returns bare amounts as strong names', () => {
    expect(extractCandidates('Acme 42 raised a seed round.').filter(c => !c.weak).map(c => c.query)).toEqual(['Acme']);
    expect(extractCandidates('Acme 42 raised a seed round.', { numericNames: true }).filter(c => !c.weak).map(c => c.query)).toEqual(['Acme 42']);
    expect(extractCandidates('42 80 2025', { numericNames: true }).filter(c => !c.weak)).toEqual([]);
    expect(extractCandidates(Array.from({ length: 30 }, (_, i) => `Acme ${i} raised funds.`).join(' '), { numericNames: true }).filter(c => !c.weak)).toHaveLength(MAX_CANDIDATES);
  });
});
