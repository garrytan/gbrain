/**
 * `gbrain schema detect --fields`: per page type, the frontmatter keys, fact
 * categories and relation types in use, with 100% -> required and >=25% ->
 * optional. Hermetic PGLite.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFieldUsage } from '../src/core/schema-pack/field-usage.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);

test('required, optional and rare fields per type', async () => {
  for (let i = 1; i <= 8; i++) {
    await engine.putPage(`people/p${i}`, { type: 'person', title: `P${i}`, timeline: '',
      frontmatter: { company: 'Acme', ...(i <= 2 ? { role: 'cto' } : {}), ...(i === 1 ? { pronouns: 'they' } : {}), ingested_via: 'test' },
      compiled_truth: `Person ${i}.\n\n- works_at [[companies/acme-example]]\n${i <= 4 ? '- [preference] Tea\n' : ''}` });
  }
  await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme', compiled_truth: 'Acme.', timeline: '', frontmatter: {} });
  const [person] = (await runFieldUsage(engine)).filter(t => t.type === 'person');
  expect(person).toMatchObject({ type: 'person', pages: 8, sampled: 8, required: ['company', 'works_at ->'], optional: ['role', '[preference]'] });
  expect(person.frontmatter.find(f => f.name === 'pronouns')).toEqual({ name: 'pronouns', pages: 1, share: 0.125 });
  expect(person.frontmatter.some(f => f.name === 'ingested_via')).toBe(false);
});
