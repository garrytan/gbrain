/**
 * #5836 — zero-LLM fact subject inference. A labeled synthetic fixture pins
 * precision (write time >= 0.99, relink free tiers >= 0.95) and the
 * competing-name veto, plus the page tier, private-page scope and source
 * isolation. Synthetic data only.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import {
  appendContextNote, contextHead, inferFactSubject, isEntityInferenceEnabled, recordedPageSlug,
} from '../src/core/facts/subject-infer.ts';

let engine: PGLiteEngine;

const page = (slug: string, title: string, type: string, extra = '') =>
  importFromContent(engine, slug, `---\ntitle: ${title}\ntype: ${type}\n${extra}---\n\n# ${title}\n`, { noEmbed: true });

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await page('companies/acme-example', 'Acme Example', 'company');
  await page('companies/widget-co', 'Widget Co', 'company', 'aliases:\n  - "WidgetWorks"\n');
  await page('people/alice-example', 'Alice Example', 'person', 'aliases:\n  - "Ali Example"\n');
  await page('people/charlie-example', 'Charlie Example', 'person');
  await page('people/bob-example', 'Bob Example', 'person');
  await page('projects/apollo-example', 'Apollo Example', 'project');
  await page('people/sam-lee-example', 'Sam Lee-Example', 'person');
  await page('companies/sam-lee-example', 'Sam Lee-Example', 'company');
  await page('people/dana-private-example', 'Dana Private-Example', 'person', 'visibility: private\n');
  await page('meetings/2026-04-03', 'Acme Example Sync', 'meeting');
  await page('concepts/hiring-plan-example', 'Hiring Plan Example', 'concept');
});

afterAll(async () => {
  await engine.disconnect();
});

type Case = { fact: string; expect: string | null; page?: string };

// Labeled write-time fixture: `expect` is the correct subject, or null when
// the subject is unknown, has no page, or more than one entity competes.
const WRITE_CASES: Case[] = [
  { fact: 'Acme Example raised a seed round', expect: 'companies/acme-example' },
  { fact: 'Acme Example hired a CFO', expect: 'companies/acme-example' },
  { fact: "Met with Acme Example's founders about pricing", expect: 'companies/acme-example' },
  { fact: 'The board at Acme Example approved the budget', expect: 'companies/acme-example' },
  { fact: 'She joined Acme Example as head of sales', expect: 'companies/acme-example' },
  { fact: 'Alice Example prefers async updates', expect: 'people/alice-example' },
  // A place name competes like any other name: a recall miss, never a wrong link.
  { fact: 'Alice Example moved to Lisbon', expect: 'people/alice-example' },
  { fact: 'Ali Example is vegetarian', expect: 'people/alice-example' },
  { fact: 'Talked to WidgetWorks about the renewal', expect: 'companies/widget-co' },
  { fact: 'Widget Co signed the pilot', expect: 'companies/widget-co' },
  { fact: 'Charlie Example wants weekly check-ins', expect: 'people/charlie-example' },
  { fact: 'Apollo Example ships next quarter', expect: 'projects/apollo-example' },
  { fact: 'Hiring Plan Example needs two more engineers', expect: 'concepts/hiring-plan-example' },
  { fact: 'people/charlie-example owns the launch checklist', expect: 'people/charlie-example' },
  // Two entities with pages: unknown subject.
  { fact: 'Alice Example introduced me to Charlie Example', expect: null },
  { fact: 'Acme Example is buying Widget Co', expect: null },
  { fact: 'Charlie Example left Acme Example for Widget Co', expect: null },
  // A competing real name with no page vetoes the one with a page.
  { fact: "Northstar Example copied Acme Example's pricing", expect: null },
  { fact: 'Acme Example lost the deal to Bluebird Labs', expect: null },
  { fact: 'Charlie Example and Morgan Example cofounded a fund', expect: null },
  // An unknown name opening the sentence competes like any other name.
  { fact: 'Blake joined Acme Example last month', expect: null },
  { fact: 'Joined Acme Example as head of sales', expect: 'companies/acme-example' },
  // Bare first names are never guessed, and veto a real match.
  { fact: 'Bob said the demo went well', expect: null },
  { fact: 'Bob joined Acme Example last month', expect: null },
  { fact: 'Alice wants the deck by Friday', expect: null },
  // Ambiguous basename: two pages share the name.
  { fact: 'Sam Lee-Example closed the round', expect: null },
  // Names that resolve to a non-entity page do not count.
  { fact: 'Acme Example Sync moved to Thursday', expect: null },
  // No names at all.
  { fact: 'I prefer dark mode in every editor', expect: null },
  { fact: 'ate oatmeal and two eggs for breakfast', expect: null },
  { fact: 'slept 7 hours, resting heart rate 52', expect: null },
  { fact: 'remember to renew the passport before june', expect: null },
  { fact: 'Need to book flights for the offsite', expect: null },
  { fact: 'Raised the thermostat to 70', expect: null },
  // Lowercase mentions are not identity evidence at write time.
  { fact: 'acme example raised a seed round', expect: null },
  // Private page: local callers resolve it (remote scope is tested below).
  { fact: 'Dana Private-Example is relocating', expect: 'people/dana-private-example' },
  // Page tier: the fact came from an entity page.
  { fact: 'raised a seed round in March', page: 'companies/acme-example', expect: 'companies/acme-example' },
  { fact: 'Acme Example raised a seed round', page: 'companies/acme-example', expect: 'companies/acme-example' },
  { fact: 'prefers async updates', page: 'people/alice-example', expect: 'people/alice-example' },
  { fact: "Northstar Example copied Acme Example's pricing", page: 'companies/acme-example', expect: null },
  { fact: 'Widget Co signed the pilot', page: 'companies/acme-example', expect: null },
  { fact: 'Bob said the demo went well', page: 'people/alice-example', expect: null },
  // Page tier never applies to non-entity pages.
  { fact: 'decided to ship on Friday', page: 'meetings/2026-04-03', expect: null },
  { fact: 'Acme Example raised a seed round', page: 'meetings/2026-04-03', expect: 'companies/acme-example' },
  { fact: 'ate oatmeal for breakfast', page: 'daily/2026-04-03', expect: null },
];

async function score(cases: Case[], mode: 'write' | 'relink') {
  let links = 0;
  let correct = 0;
  let found = 0;
  const wrong: string[] = [];
  for (const c of cases) {
    const r = await inferFactSubject(engine, 'default', { fact: c.fact, pageSlug: c.page ?? null, mode });
    if (c.expect) found += 1;
    if (r.slug === null) {
      if (c.expect) wrong.push(`missed: ${c.fact} -> ${c.expect} (${r.reason})`);
      continue;
    }
    links += 1;
    if (r.slug === c.expect) correct += 1;
    else wrong.push(`wrong: ${c.fact} -> ${r.slug} (want ${c.expect})`);
  }
  return { precision: links ? correct / links : 1, recall: found ? correct / found : 1, wrong };
}

describe('inferFactSubject precision fixture', () => {
  test('fixture has at least 40 labeled facts', () => {
    expect(WRITE_CASES.length).toBeGreaterThanOrEqual(40);
  });

  test('write-time precision >= 0.99', async () => {
    const r = await score(WRITE_CASES, 'write');
    console.log(`[subject-infer] write precision=${r.precision.toFixed(3)} recall=${r.recall.toFixed(3)}`, r.wrong);
    expect(r.wrong.filter(w => w.startsWith('wrong'))).toEqual([]);
    expect(r.precision).toBeGreaterThanOrEqual(0.99);
  });

  test('relink free-tier precision >= 0.95', async () => {
    const r = await score(WRITE_CASES, 'relink');
    console.log(`[subject-infer] relink precision=${r.precision.toFixed(3)} recall=${r.recall.toFixed(3)}`);
    expect(r.precision).toBeGreaterThanOrEqual(0.95);
  });
});

describe('inferFactSubject reasons', () => {
  test('veto by a name with no page reports ambiguous', async () => {
    expect(await inferFactSubject(engine, 'default', { fact: "Northstar Example copied Acme Example's pricing", mode: 'write' }))
      .toMatchObject({ slug: null, reason: 'ambiguous' });
  });
  test('a bare first name with a prefix candidate reports unverified_match', async () => {
    expect(await inferFactSubject(engine, 'default', { fact: 'Bob said the demo went well', mode: 'write' }))
      .toMatchObject({ slug: null, reason: 'unverified_match' });
  });
  test('a real name with no page reports no_page', async () => {
    expect(await inferFactSubject(engine, 'default', { fact: 'Bluebird Labs raised a seed round', mode: 'write' }))
      .toMatchObject({ slug: null, reason: 'no_page' });
  });
  test('no names reports no_mention', async () => {
    expect(await inferFactSubject(engine, 'default', { fact: 'slept 7 hours', mode: 'write' }))
      .toMatchObject({ slug: null, reason: 'no_mention' });
  });
  test('mention and page tiers are labeled', async () => {
    expect(await inferFactSubject(engine, 'default', { fact: 'Acme Example raised a seed round', mode: 'write' }))
      .toEqual({ slug: 'companies/acme-example', via: 'mention' });
    expect(await inferFactSubject(engine, 'default', { fact: 'raised a seed round', pageSlug: 'companies/acme-example', mode: 'write' }))
      .toEqual({ slug: 'companies/acme-example', via: 'page' });
  });
});

describe('inferFactSubject scope', () => {
  test('a remote caller never infers a private page', async () => {
    const r = await inferFactSubject(engine, 'default', { fact: 'Dana Private-Example is relocating', mode: 'write', excludePrivate: true });
    expect(r.slug).toBeNull();
    const p = await inferFactSubject(engine, 'default', { fact: 'is relocating', pageSlug: 'people/dana-private-example', mode: 'write', excludePrivate: true });
    expect(p.slug).toBeNull();
  });

  test('an unreadable namesake does not change the remote outcome', async () => {
    await page('companies/charlie-example', 'Charlie Example', 'company', 'visibility: private\n');
    try {
      const remote = await inferFactSubject(engine, 'default', { fact: 'Charlie Example wants weekly check-ins', mode: 'write', excludePrivate: true });
      expect(remote).toEqual({ slug: 'people/charlie-example', via: 'mention' });
      const local = await inferFactSubject(engine, 'default', { fact: 'Charlie Example wants weekly check-ins', mode: 'write' });
      expect(local).toMatchObject({ slug: null, reason: 'ambiguous' });
    } finally {
      await engine.executeRaw(`DELETE FROM pages WHERE slug = 'companies/charlie-example'`);
    }
  });

  test('a private bare-name namesake does not change the remote outcome', async () => {
    await page('people/secret-example', 'Secret Example', 'person', 'visibility: private\n');
    try {
      const remote = await inferFactSubject(engine, 'default', { fact: 'Secret said Acme Example is hiring', mode: 'write', excludePrivate: true });
      const local = await inferFactSubject(engine, 'default', { fact: 'Secret said Acme Example is hiring', mode: 'write' });
      expect(local).toMatchObject({ slug: null, reason: 'ambiguous' });
      await engine.executeRaw(`DELETE FROM pages WHERE slug = 'people/secret-example'`);
      const without = await inferFactSubject(engine, 'default', { fact: 'Secret said Acme Example is hiring', mode: 'write', excludePrivate: true });
      expect(remote).toEqual(without);
    } finally {
      await engine.executeRaw(`DELETE FROM pages WHERE slug = 'people/secret-example'`);
    }
  });

  test('lookups are source-scoped', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING`);
    const r = await inferFactSubject(engine, 'other', { fact: 'Acme Example raised a seed round', mode: 'write' });
    expect(r.slug).toBeNull();
  });
});

describe('context helpers and kill switch', () => {
  test('appendContextNote and contextHead round-trip', () => {
    expect(appendContextNote(null, 'entity inferred from mention')).toBe('entity inferred from mention');
    const c = appendContextNote('companies/acme-example', 'entity inferred from page');
    expect(c).toBe('companies/acme-example — entity inferred from page');
    expect(contextHead(c)).toBe('companies/acme-example');
  });

  test('recordedPageSlug accepts page-extraction rows only', () => {
    expect(recordedPageSlug('companies/acme-example — entity matched by bare name only', 'mcp:put_page')).toBe('companies/acme-example');
    expect(recordedPageSlug('companies/acme-example', 'chat 2026-06-12')).toBeNull();
    expect(recordedPageSlug('chat', 'mcp:put_page')).toBeNull();
  });

  test('facts.entity_inference off disables write-time inference', async () => {
    expect(await isEntityInferenceEnabled(engine)).toBe(true);
    await engine.setConfig('facts.entity_inference', 'off');
    expect(await isEntityInferenceEnabled(engine)).toBe(false);
    await engine.setConfig('facts.entity_inference', 'on');
  });
});
