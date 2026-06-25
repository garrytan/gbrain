// Entity-link onboarding should only recommend extract-ner when the active
// schema pack can actually infer NER links.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkEntityLinkCoverage } from '../src/core/onboard/checks.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';

let engine: PGLiteEngine;

beforeEach(async () => {
  if (!engine) {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }
  await resetPgliteState(engine);
  _resetPackCacheForTests();
});

afterAll(async () => {
  await engine?.disconnect();
});

async function seedUnlinkedEntities() {
  for (const slug of ['people/alice', 'people/bob', 'companies/acme']) {
    await engine.putPage(slug, {
      title: slug,
      type: slug.startsWith('companies/') ? 'company' as never : 'person' as never,
      compiled_truth: 'Entity page with no inbound links yet.',
      timeline: '',
      frontmatter: {},
      source_path: `${slug}.md`,
    });
  }
}

describe('checkEntityLinkCoverage', () => {
  test('recommends extract-ner when the active pack has NER regex rules', async () => {
    await engine.setConfig('schema_pack', 'gbrain-base');
    await seedUnlinkedEntities();

    const result = await checkEntityLinkCoverage(engine);

    expect(result.check.status).toBe('warn');
    expect(result.remediations.map((r) => r.job)).toContain('extract-ner');
  });

  test('does not recommend extract-ner when the active pack has no NER regex rules', async () => {
    await engine.setConfig('schema_pack', 'gbrain-base-v2');
    await seedUnlinkedEntities();

    const result = await checkEntityLinkCoverage(engine);

    expect(result.check.status).toBe('warn');
    expect(result.check.message).toContain('active pack has no NER regex rules');
    expect(result.remediations.map((r) => r.job)).not.toContain('extract-ner');
  });
});
