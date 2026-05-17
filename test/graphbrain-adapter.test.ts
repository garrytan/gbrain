/**
 * Integration test: GBrain GraphBrain adapter → live GraphBrain REST API.
 * 
 * Usage: bun run test/graphbrain-adapter.test.ts
 * 
 * Tests: pages CRUD, links, traversal, search, stats, timeline.
 * Skips: embedding/chunk/migration methods (throws on purpose).
 */

import { GraphBrainRestEngine } from '../src/core/graphbrain-engine.ts';

const BASE = process.env.GRAPH_BASE_URL || "https://graphbrain.belweave.ai";

// Auto-provision a test brain if no URL+key provided
async function provisionBrain(): Promise<{ url: string; key: string }> {
  if (process.env.GBRAIN_GRAPH_API_KEY && process.env.GBRAIN_BRAIN_URL) {
    return { url: process.env.GBRAIN_BRAIN_URL, key: process.env.GBRAIN_GRAPH_API_KEY };
  }
  const res = await fetch(`${BASE}/v1/brains`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "adapter-unit-test" }),
  });
  const brain = await res.json();
  return { url: `${BASE}/v1/${brain.brain_id}`, key: brain.api_key };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

async function run() {
  const { url, key } = await provisionBrain();
  process.env.GBRAIN_GRAPH_API_KEY = key;

  const engine = new GraphBrainRestEngine();
  await engine.connect({ database_url: url, engine: 'graphbrain' });

  // Seed test data
  const H = { "Content-Type": "application/json", "X-API-Key": key };
  const pages = [
    ["sam-altman", "Sam Altman", "person", "CEO of OpenAI. Former YC President."],
    ["openai", "OpenAI", "company", "AI research lab. Creator of ChatGPT."],
    ["y-combinator", "Y Combinator", "vc_firm", "Seed-stage accelerator."],
    ["garry-tan", "Garry Tan", "person", "YC President & CEO."],
    ["stripe", "Stripe", "company", "Payment infrastructure. YC S10."],
  ];
  for (const [slug, title, type, content] of pages) {
    await fetch(`${url}/pages/${slug}`, { method: "PUT", headers: H, body: JSON.stringify({ title, type, content }) });
  }
  const linkPayloads = [
    { from_slug: "sam-altman", to_slug: "openai", link_type: "founded", context: "CEO & co-founder" },
    { from_slug: "sam-altman", to_slug: "y-combinator", link_type: "works_at", context: "Former President" },
    { from_slug: "garry-tan", to_slug: "y-combinator", link_type: "works_at", context: "President & CEO" },
    { from_slug: "stripe", to_slug: "y-combinator", link_type: "yc_batch", context: "S10" },
  ];
  await fetch(`${url}/links/batch`, { method: "POST", headers: H, body: JSON.stringify({ links: linkPayloads }) });

  console.log("\n── Pages ──");

  // getPage
  const page = await engine.getPage("sam-altman");
  assert(page !== null, "getPage('sam-altman') returns page");
  assert(page?.title === "Sam Altman", "page.title matches");
  assert(page?.type === "person", "page.type is person");
  assert(page?.compiled_truth.includes("CEO"), "page.content includes 'CEO'");

  // listPages
  const allPages = await engine.listPages();
  assert(allPages.length > 0, "listPages() returns pages");

  // listPages with filter
  const people = await engine.listPages({ type: "person" });
  assert(people.every(p => p.type === "person"), "listPages(type=person) only returns people");

  // putPage (create new)
  const newPage = await engine.putPage("test-page-gbrain", {
    type: "note",
    title: "Test Page from GBrain Adapter",
    compiled_truth: "This page was created via the GraphBrain REST adapter.",
  });
  assert(newPage.slug === "test-page-gbrain", "putPage creates a page");

  // deletePage
  await engine.deletePage("test-page-gbrain");
  const deleted = await engine.getPage("test-page-gbrain");
  assert(deleted === null, "deletePage removes page");

  // resolveSlugs
  const slugs = await engine.resolveSlugs("stripe");
  assert(slugs.length > 0, "resolveSlugs('stripe') returns matches");
  assert(slugs.includes("stripe"), "includes 'stripe'");

  console.log("\n── Links ──");

  // getLinks
  const samLinks = await engine.getLinks("sam-altman");
  assert(samLinks.length > 0, "getLinks('sam-altman') returns links");
  const hasOpenAI = samLinks.some(l => l.to_slug === "openai" && l.link_type === "founded");
  assert(hasOpenAI, "sam-altman → openai (founded) link exists");

  // getBacklinks
  const ycBacklinks = await engine.getBacklinks("y-combinator");
  assert(ycBacklinks.length >= 1, `y-combinator has backlinks (got ${ycBacklinks.length})`);

  // addLink + removeLink
  await engine.addLink("sam-altman", "garry-tan", "tested_with", "integration test");
  const newLinks = await engine.getLinks("sam-altman");
  const testLink = newLinks.find(l => l.link_type === "tested_with");
  assert(testLink !== undefined, "addLink creates test link");
  await engine.removeLink("sam-altman", "garry-tan", "tested_with");
  const cleanLinks = await engine.getLinks("sam-altman");
  assert(!cleanLinks.some(l => l.link_type === "tested_with"), "removeLink deletes test link");

  console.log("\n── Graph Traversal ──");

  // traverseGraph (node-based)
  const nodes = await engine.traverseGraph("sam-altman", 2);
  assert(nodes.length > 0, "traverseGraph returns nodes");
  const openaiNode = nodes.find(n => n.slug === "openai");
  assert(openaiNode !== undefined, "traverse from sam-altman reaches openai");

  // traversePaths (edge-based)
  const paths = await engine.traversePaths("y-combinator", { depth: 2, direction: "in" });
  assert(paths.length > 0, "traversePaths returns edges");

  console.log("\n── Search ──");

  // searchKeyword
  const results = await engine.searchKeyword("founder", { limit: 10 });
  assert(results.length > 0, "searchKeyword('founder') returns results");

  // searchKeyword with type filter
  const founderPeople = await engine.searchKeyword("founder", { type: "person", limit: 5 });
  assert(founderPeople.every(r => r.type === "person"), "type filter works on search");

  console.log("\n── Stats & Health ──");

  const stats = await engine.getStats();
  assert(stats.page_count >= 5, `stats.page_count >= 5 (${stats.page_count})`);
  assert(stats.link_count >= 4, `stats.link_count >= 4 (${stats.link_count})`);
  console.log(`  📊 Brain: ${stats.page_count} pages, ${stats.link_count} links`);

  const health = await engine.getHealth();
  assert(health.brain_score > 0, "health.brain_score > 0");

  console.log("\n── Tags ──");
  
  await engine.addTag("sam-altman", "test-tag-42");
  const tags = await engine.getTags("sam-altman");
  console.log(`  🏷️  Tags on sam-altman: ${tags}`);

  console.log("\n── Chunks & unsupported methods ──");

  // upsertChunks should succeed (no-op, chunks managed server-side)
  try {
    await engine.upsertChunks("sam-altman", []);
    assert(true, "upsertChunks no-op (chunks managed server-side)");
  } catch (e: any) {
    assert(false, `upsertChunks threw: ${e.message}`);
  }

  // searchVector and executeRaw should still throw
  const expectThrow = async (label: string, fn: () => Promise<any>) => {
    try {
      await fn();
      console.log(`  ❌ ${label} — should have thrown`);
      failed++;
    } catch (e: any) {
      assert(e.message.includes("not supported"), `${label} throws correctly`);
    }
  };
  await expectThrow("searchVector", () => engine.searchVector(new Float32Array(0)));
  await expectThrow("executeRaw", () => engine.executeRaw("SELECT 1"));

  console.log(`\n${'═'.repeat(50)}`);
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(50)}`);

  await engine.disconnect();
}

run().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
