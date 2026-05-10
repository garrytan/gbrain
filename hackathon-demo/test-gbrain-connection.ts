/**
 * Run this BEFORE the hackathon to verify GBrain is working.
 * Usage: bun run test-gbrain-connection.ts
 */

const GBRAIN_URL = process.env.GBRAIN_URL ?? 'http://localhost:3131';
const GBRAIN_TOKEN = process.env.GBRAIN_TOKEN ?? '';

async function callMcp(method: string, params: Record<string, unknown>) {
  const res = await fetch(`${GBRAIN_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(GBRAIN_TOKEN ? { Authorization: `Bearer ${GBRAIN_TOKEN}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: method, arguments: params },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json() as { result?: { content?: Array<{ text: string }> }, error?: unknown };
  if (json.error) throw new Error(JSON.stringify(json.error));
  const text = json.result?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return text; }
}

async function run() {
  console.log(`Testing GBrain at: ${GBRAIN_URL}\n`);

  // 1. Health check
  const health = await fetch(`${GBRAIN_URL}/health`);
  console.log(`✓ Health: ${health.status} ${(await health.json() as { status: string }).status}`);

  // 2. Write a test learning event
  const slug = `children/test-zoe/sessions/connection-test`;
  await callMcp('put_page', {
    slug,
    title: 'Connection Test - Zoe Dinosaur Session',
    content: `Zoe asked about dinosaurs today. She was very excited about T-Rex.\nTopics: dinosaurs, T-Rex, carnivores\nEngagement: high`,
    frontmatter: {
      child_id: 'test-zoe',
      topics: ['dinosaurs', 'T-Rex', 'carnivores'],
      engagement: 'high',
      session_type: 'learning',
    },
  });
  console.log(`✓ put_page: wrote ${slug}`);

  // 3. Read it back
  const page = await callMcp('get_page', { slug });
  console.log(`✓ get_page: retrieved "${page.title ?? slug}"`);

  // 4. Query (the key demo feature — memory retrieval)
  const result = await callMcp('query', {
    query: "What has Zoe been learning about? What topics does she love?",
    limit: 3,
  });
  console.log(`✓ query: got ${Array.isArray(result) ? result.length : '?'} results`);
  if (Array.isArray(result) && result.length > 0) {
    console.log(`  Top result: "${result[0].title ?? result[0].slug}"`);
  }

  // 5. Clean up test page
  await callMcp('delete_page', { slug });
  console.log(`✓ delete_page: cleaned up test data`);

  console.log('\n✅ All checks passed. GBrain is ready for the hackathon demo.');
}

run().catch((err) => {
  console.error('\n❌ Connection test failed:', err.message);
  console.error('\nCheck:');
  console.error('  1. Is GBRAIN_URL correct?');
  console.error('  2. Is GBRAIN_TOKEN set (if auth is enabled)?');
  console.error('  3. Is the Azure Container App running?');
  console.error('  4. Did gbrain apply-migrations --yes complete?');
  process.exit(1);
});
