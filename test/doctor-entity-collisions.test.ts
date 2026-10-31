import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { personTitleDuplicatesEntry } from '../src/commands/doctor/checks/entity-duplicates.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

const domain = ['example', 'invalid'].join('.');
const email = ['contact', domain].join('@');
async function page(slug: string, type: string, frontmatter: Record<string, unknown> = {}, sourceId = 'default') {
  await engine.putPage(slug, { title: slug.split('/').pop()!, type, compiled_truth: 'Synthetic fixture', frontmatter }, { sourceId });
}
async function check(sourceId = 'default') {
  const ctx = { engine, orphanRatioSourceId: sourceId, progress: { heartbeat() {} } } as unknown as DoctorContext;
  return (await personTitleDuplicatesEntry.run(ctx))[0]!;
}

test('doctor reports identity collisions within a source without changing pages', async () => {
  await page('people/first-example', 'person', { email });
  await page('people/second-example', 'person', { email: email.toUpperCase() });
  await page('companies/first-example', 'company', { domain });
  await page('orgs/second-example', 'organization', { domain: `https://${domain}/about` });
  await page('companies/alias-owner', 'company', { aliases: ['Shared Example'] });
  await page('projects/shared-example', 'project');
  await page('companies/alias-peer', 'company', { aliases: ['Shared Example'] });
  await page('people/retired-example', 'person', { email, merged_into: 'people/first-example' });
  await page('people/deleted-example', 'person', { email });
  await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE slug = 'people/deleted-example'");
  const publicDomain = ['gmail', 'com'].join('.');
  await page('companies/public-one', 'company', { domain: publicDomain });
  await page('companies/public-two', 'company', { domain: publicDomain });
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'Other')");
  await page('people/foreign-example', 'person', { email }, 'other');
  const before = await engine.executeRaw('SELECT source_id, slug, frontmatter, compiled_truth FROM pages ORDER BY source_id, slug');
  const result = await check();
  expect(result.status).toBe('warn');
  const pairs = (result.details as any).pairs.map((p: any) => [p.source_id, ...[p.stub, p.canonical].sort()]);
  expect(pairs).toEqual(expect.arrayContaining([
    ['default', 'people/first-example', 'people/second-example'],
    ['default', 'companies/first-example', 'orgs/second-example'],
    ['default', 'companies/alias-owner', 'projects/shared-example'],
    ['default', 'companies/alias-owner', 'companies/alias-peer'],
  ]));
  expect(pairs).toHaveLength(5);
  expect((await check()).details).toEqual(result.details);
  expect((await check('other')).status).toBe('ok');
  expect(await engine.executeRaw('SELECT source_id, slug, frontmatter, compiled_truth FROM pages ORDER BY source_id, slug')).toEqual(before);
});
