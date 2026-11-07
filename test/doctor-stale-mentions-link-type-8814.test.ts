/**
 * #8814: the stale_mentions hint must name the stored link_type of a stale
 * typed_ner link (e.g. 'founded'), or `gbrain unlink` removes nothing.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { staleMentionsCheck } from '../src/commands/doctor/checks/stale-mentions.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('stale_mentions typed link hint (#8814)', () => {
  test('example names the stored link_type of a typed_ner link', async () => {
    await engine.putPage('companies/acme-example', {
      type: 'company', title: 'Acme Example', compiled_truth: 'Acme Example is a company.',
      timeline: '', frontmatter: {},
    });
    await engine.putPage('notes/meeting', {
      type: 'note', title: 'notes/meeting', compiled_truth: 'Quiet day.',
      timeline: '', frontmatter: {},
    });
    await engine.addLinksBatch([{
      from_slug: 'notes/meeting', to_slug: 'companies/acme-example',
      link_type: 'founded', link_source: 'mentions', link_kind: 'typed_ner',
    }]);
    const check = await staleMentionsCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('notes/meeting -> companies/acme-example (founded)');
  });
});
