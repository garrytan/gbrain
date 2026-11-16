/**
 * #8545: link and graph endpoint slugs are identities, like `slug`: a slug
 * that happens to look like a credential (`pa-` plus 20 characters reads as a
 * Voyage key) must come back exact from get_links, get_backlinks and
 * traverse_graph, or the caller cannot follow the edge. Context text is still
 * scanned. PGLite, remote MCP dispatch, synthetic slugs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { redactRetrievalOutput } from '../../src/core/search/output-redaction.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { withEnv } from '../helpers/with-env.ts';

const FROM = 'notes/alice-example';
const TO = 'districts/pa-synthetic-example-district-1234';
const REMOTE = { remote: true, transport: 'http' as const, sourceId: 'default' };

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage(FROM, { type: 'note', title: 'Alice example', compiled_truth: 'Notes on a district.' } as never);
  await engine.putPage(TO, { type: 'note', title: 'Synthetic district', compiled_truth: 'A district page.' } as never);
  await engine.addLink(FROM, TO, 'see also', 'mentions', 'manual');
}, 60_000);

afterAll(async () => { await engine?.disconnect(); });

const call = (tool: string, args: Record<string, unknown>) =>
  withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, tool, args, REMOTE));
const body = (res: { content: Array<{ text: string }> }) => res.content.map(c => c.text).join('\n');

describe('#8545 link and graph slugs survive output redaction', () => {
  test('redactRetrievalOutput keeps from_slug, to_slug and origin_slug exact and still scans context', () => {
    const { results } = redactRetrievalOutput([{ from_slug: FROM, to_slug: TO, origin_slug: TO, from_source_id: 'default', to_source_id: 'default',
      origin_source_id: 'default', context: 'x', links: [{ to_slug: TO, link_type: 'mentions' }] }], {});
    expect(results[0]).toMatchObject({ from_slug: FROM, to_slug: TO, origin_slug: TO, links: [{ to_slug: TO }] });
    const key = ['pa', 'Zq81LmX0vR4tYw7NcB2KfJ6'].join('-');
    expect(redactRetrievalOutput([{ to_slug: TO, context: key }], {}).results[0]).toMatchObject({ to_slug: TO, context: '<REDACTED:voyage>' });
  });

  test('get_links, get_backlinks and traverse_graph over MCP return the endpoint slug', async () => {
    for (const [tool, args] of [['get_links', { slug: FROM }], ['get_backlinks', { slug: TO }], ['traverse_graph', { slug: FROM, depth: 1 }]] as const) {
      const text = body(await call(tool, args));
      expect(text).toContain(TO);
      expect(text).not.toContain('<REDACTED:');
    }
  });
});
