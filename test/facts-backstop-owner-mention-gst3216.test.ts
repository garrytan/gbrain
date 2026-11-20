/**
 * GST-3216 PR 3: a name in the text is not identity. The facts backstop infers a missing subject from one exact mention,
 * but never makes the brain's owner the subject that way: an agent's brainstorm restating "a friend told Alice
 * Example..." is not the owner's own claim. The fact stays unattributed; any other mention still links.
 * PGLite, unmanaged, chat stubbed. Synthetic names only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop, type FactsBackstopCtx } from '../src/core/facts/backstop.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { ownerIdentity } from '../src/core/identity/owner.ts';

let engine: PGLiteEngine;
let dir: string;
const BODY = 'notes from a brainstorm an agent wrote after reading the week of messages '.repeat(3);
const slugs = ['people/alice-example', 'companies/acme-example', 'notes/brainstorm-example'];

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await addMember(engine, 'alice-example', { email: 'alice@example.com' });
  await setOwner(engine, 'alice-example');
  await engine.putPage('people/alice-example', { type: 'person' as never, title: 'Alice Example', compiled_truth: `# Alice Example\n\n${BODY}`, frontmatter: { email: 'alice@example.com' } }, { sourceId: 'default' });
  await engine.putPage('companies/acme-example', { type: 'note' as never, title: 'Acme Example', compiled_truth: `# Acme Example\n\n${BODY}`, frontmatter: {} }, { sourceId: 'default' });
  await engine.putPage('notes/brainstorm-example', { type: 'note' as never, title: 'Brainstorm', compiled_truth: `# Brainstorm\n\n${BODY}`, frontmatter: {} }, { sourceId: 'default' });
}, 60_000);
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'backstop-owner-'));
  for (const slug of slugs) {
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    mkdirSync(join(dir, slug, '..'), { recursive: true });
    writeFileSync(join(dir, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
  }
  await engine.executeRaw(`UPDATE sources SET local_path=$1 WHERE id='default'`, [dir]);
  _resetWriteThroughCacheForTest();
});
afterEach(async () => {
  __setChatTransportForTests(null); resetGateway(); __resetFactsQueueForTests();
  await engine.executeRaw(`UPDATE sources SET local_path=NULL WHERE id='default'`);
  _resetWriteThroughCacheForTest();
  rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => { await engine.disconnect(); });

test('a mention of the owner never makes the owner the subject; a mention of anyone else still does', async () => {
  expect((await ownerIdentity(engine)).entity).toMatchObject({ slug: 'people/alice-example', basis: 'identifier_page' });
  const facts = ['A friend told Alice Example that she signed the lease', 'Acme Example raised a seed round led by a new fund'];
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({ facts: facts.map(fact => ({ fact, kind: 'fact', entity: null, confidence: 1, notability: 'high' })) }),
    blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
  }));
  const ctx: FactsBackstopCtx = { engine, sourceId: 'default', sessionId: null, source: 'mcp:put_page', mode: 'inline', visibility: 'world' };
  const r = await runFactsBackstop({ slug: 'notes/brainstorm-example', type: 'note', compiled_truth: BODY, frontmatter: {} }, ctx);
  if (r.mode !== 'inline') throw new Error('expected inline');
  const rows = await engine.executeRaw<{ fact: string; entity_slug: string | null }>('SELECT fact, entity_slug FROM facts WHERE id = ANY($1::int[]) ORDER BY fact', [r.fact_ids]);
  expect(rows).toEqual([{ fact: facts[0]!, entity_slug: null }, { fact: facts[1]!, entity_slug: 'companies/acme-example' }]);
});
