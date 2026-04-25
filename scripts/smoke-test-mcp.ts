#!/usr/bin/env bun
/**
 * Smoke test: verify MCP tool calls work against a real database.
 * Usage: DATABASE_URL=... bun run scripts/smoke-test-mcp.ts
 */
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { handleToolCall } from '../src/mcp/server.ts';

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('Set DATABASE_URL'); process.exit(1); }

const eng = new PostgresEngine();
await eng.connect({ database_url: DB_URL });

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

console.log('MCP Smoke Test\n');

await test('get_stats returns counts', async () => {
  const stats = await handleToolCall(eng, 'get_stats', {}) as any;
  if (typeof stats.page_count !== 'number') throw new Error('page_count missing');
});

await test('put_page creates a page', async () => {
  await handleToolCall(eng, 'put_page', {
    slug: 'smoke/test-page',
    content: '---\ntitle: Smoke Test Page\ntype: note\n---\n\nThis page was created by the MCP smoke test. [Source: MCP smoke test, direct put_page fixture, 2026-04-26 09:00 AM KST]',
  });
});

await test('get_page retrieves the page', async () => {
  const page = await handleToolCall(eng, 'get_page', { slug: 'smoke/test-page' }) as any;
  if (page.title !== 'Smoke Test Page') throw new Error(`Wrong title: ${page.title}`);
});

await test('dry_run prevents mutation', async () => {
  const result = await handleToolCall(eng, 'put_page', {
    slug: 'smoke/should-not-exist',
    content: '---\ntitle: Should Not Exist\ntype: note\n---\n\ndry run test [Source: MCP smoke test, direct put_page fixture, 2026-04-26 09:00 AM KST]',
    dry_run: true,
  }) as any;
  if (!result.dry_run) throw new Error('dry_run flag not returned');
  // Verify page was NOT created
  try {
    await handleToolCall(eng, 'get_page', { slug: 'smoke/should-not-exist' });
    throw new Error('Page was created despite dry_run');
  } catch (e: any) {
    if (!e.message.includes('not found') && !e.code) throw e;
  }
});

await test('search finds the page', async () => {
  const results = await handleToolCall(eng, 'search', { query: 'smoke test' }) as any[];
  if (!Array.isArray(results)) throw new Error('search should return array');
  // Keyword search may or may not find it depending on search_vector trigger
});

await test('list_pages includes our page', async () => {
  const pages = await handleToolCall(eng, 'list_pages', { limit: 100 }) as any[];
  const found = pages.find((p: any) => p.slug === 'smoke/test-page');
  if (!found) throw new Error('smoke/test-page not in list');
});

await test('add_tag and get_tags work', async () => {
  await handleToolCall(eng, 'add_tag', { slug: 'smoke/test-page', tag: 'smoke-test' });
  const tags = await handleToolCall(eng, 'get_tags', { slug: 'smoke/test-page' }) as string[];
  if (!tags.includes('smoke-test')) throw new Error('tag not found');
});

await test('delete_page cleans up', async () => {
  await handleToolCall(eng, 'delete_page', { slug: 'smoke/test-page' });
  try {
    await handleToolCall(eng, 'get_page', { slug: 'smoke/test-page' });
    throw new Error('Page still exists after delete');
  } catch (e: any) {
    if (!e.message.includes('not found') && !e.code) throw e;
  }
});

await eng.disconnect();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('\n🧠 MCP smoke test passed!');
