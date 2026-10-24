/**
 * Protect contextual subject attribution without models or production state.
 * Reverting the contextual evidence rules loses currency/label recall and links
 * folder inventory examples. The existing precision fixture has neither case.
 * Uses the public inference entry point and real in-memory storage; no new seam.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { inferFactSubject } from '../src/core/facts/subject-infer.ts';

const engine = new PGLiteEngine();
async function page(slug: string, title: string, type: string) {
  await importFromContent(engine, slug,
    `---\ntitle: ${title}\ntype: ${type}\nfacts_backstop: false\n---\n\n# ${title}\n`, { noEmbed: true });
}
beforeAll(async () => {
  await engine.connect({});
  await engine.initSchema();
  await page('people/alice-example', 'Alice Example', 'person');
  await page('companies/acme-example', 'Acme Example', 'company');
  await page('ideas/automation-example', 'Automation Example', 'concept');
});
afterAll(async () => { await engine.disconnect(); });

const recall = [
  'Alice Example prefers async updates',
  'Alice Example paid CHF 80 for gardening',
  'Invoice total for gardening work billed to Alice Example: CHF 80',
  'Work session on 2025-01-01: 2 hours of garden labour for Alice Example (CHF 80)',
];
for (const mode of ['write', 'relink'] as const) {
  for (const [index, fact] of recall.entries()) {
    test(`${mode}: person recall case ${index}`, async () => {
      expect((await inferFactSubject(engine, 'default', { fact, mode })).slug).toBe('people/alice-example');
    });
  }
  test(`${mode}: competing names and incidental examples cannot establish a subject`, async () => {
    for (const fact of [
      'Acme Example issued an invoice to Alice Example',
      'Northstar Example issued an invoice to Alice Example',
      'CHF issued an invoice to Alice Example',
      'CHF billed Alice Example CHF 80',
      'Invoice hired Alice Example',
      'Work hired Alice Example',
      'Has a venture research folder with 17 enrolled documents including Automation Example notes',
      'Has research notes such as Automation Example',
      'Has research notes including ideas/automation-example',
    ]) {
      expect((await inferFactSubject(engine, 'default', { fact, mode })).slug).toBeNull();
    }
    expect((await inferFactSubject(engine, 'default', {
      fact: 'ideas/automation-example has 17 documents including ideas/automation-example notes', mode,
    })).slug).toBe('ideas/automation-example');
    expect((await inferFactSubject(engine, 'default', {
      fact: 'Has 17 documents including Automation Example notes', pageSlug: 'companies/acme-example', mode,
    })).slug).toBeNull();
  });
}

test('real entities named like currency or labels still compete', async () => {
  for (const title of ['CHF', 'Invoice', 'Work']) {
    await page(`companies/${title.toLowerCase()}`, title, 'company');
  }
  for (const mode of ['write', 'relink'] as const) {
    for (const fact of [
      ...recall.slice(1),
      'Invoice total for gardening work billed to Alice Example: 80',
      'Work session on 2025-01-01: 2 hours of garden labour for Alice Example',
    ]) {
      expect(await inferFactSubject(engine, 'default', { fact, mode }))
        .toMatchObject({ slug: null, reason: 'ambiguous' });
    }
  }
});
