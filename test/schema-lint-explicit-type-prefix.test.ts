import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runAllLintRules } from '../src/core/schema-pack/lint-rules.ts';
import type { SchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(
    'INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING',
    ['fixture-source'],
  );
  await engine.putPage('papers/example-paper', {
    type: 'source', title: 'Example paper', compiled_truth: 'Fixture page.', timeline: '', frontmatter: {},
  }, { sourceId: 'fixture-source' });
  await engine.putPage('sources/example-source', {
    type: 'source', title: 'Example source', compiled_truth: 'Fixture page.', timeline: '', frontmatter: {},
  }, { sourceId: 'fixture-source' });
  await engine.putPage('archives/example-archive', {
    type: 'source', title: 'Example archive', compiled_truth: 'Fixture page.', timeline: '', frontmatter: {},
  }, { sourceId: 'fixture-source' });
  await engine.putPage('misc/unrestricted', {
    type: 'unrestricted', title: 'Unrestricted', compiled_truth: 'Fixture page.', timeline: '', frontmatter: {},
  }, { sourceId: 'fixture-source' });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

describe('schema lint explicit type path prefixes', () => {
  test('warns when a canonical stored type is outside its declared prefixes', async () => {
    const manifest = {
      name: 'research-fixture',
      page_types: [
        { name: 'source', primitive: 'media', path_prefixes: ['sources/', 'archives/'], aliases: [], extractable: false, expert_routing: false },
        { name: 'unrestricted', primitive: 'concept', path_prefixes: [], aliases: [], extractable: false, expert_routing: false },
      ],
      link_types: [],
      frontmatter_links: [],
      enrichable_types: [],
    } as unknown as SchemaPackManifest;

    const report = await runAllLintRules(manifest, { engine });
    const warnings = report.warnings.filter((warning) => warning.rule === 'stored_type_path_prefix_mismatch');

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.type).toBe('source');
    expect(warnings[0]?.message).toContain('1 page');
  }, 30_000);
});
