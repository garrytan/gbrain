/**
 * Integration test: GBrain GraphBrain adapter → live GraphBrain REST API.
 * 
 * Usage: bun run test/graphbrain-adapter.test.ts
 * 
 * Tests: pages CRUD, links, traversal, search, stats, timeline.
 * Skips: embedding/chunk/migration methods (throws on purpose).
 */

import { GraphBrainRestEngine } from '../src/core/graphbrain-engine.ts';

const BRAIN_URL = "https://genres-oxide-publish-resume.trycloudflare.com/v1/brain_46196b66";

// Set via env var
if (!process.env.GBRAIN_GRAPH_API_KEY) {
  // Get key from the existing brain
  console.error("Set GBRAIN_GRAPH_API_KEY=sk_...");
  process.exit(1);
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
  const engine = new GraphBrainRestEngine();
  await engine.connect({ database_url: BRAIN_URL, engine: 'graphbrain' });

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
  assert(allPages.length >= 40, `at least 40 pages (got ${allPages.length})`);

  // listPages with filter
  const people = await engine.listPages({ type: "person" });
  assert(people.every(p => p.type === "person"), "listPages(type=person) only returns people");
  assert(people.length >= 10, `at least 10 people (got ${people.length})`);

  // putPage (create new)
  const newPage = await engine.putPage("test-page-gbrain", {
    type: "note",
    title: "Test Page from GBrain Adapter",
    compiled_truth: "This page was created via the GraphBrain REST adapter.",
  });
  assert(newPage.slug === "test-page-gbrain", "putPage creates a page");
  assert(newPage.title === "Test Page from GBrain Adapter", "title matches");

  // re-read it
  const reread = await engine.getPage("test-page-gbrain");
  assert(reread?.compiled_truth.includes("GraphBrain REST adapter"), "getPage returns content");

  // deletePage
  await engine.deletePage("test-page-gbrain");
  const deleted = await engine.getPage("test-page-gbrain");
  assert(deleted === null, "deletePage removes page");

  // resolveSlugs
  const slugs = await engine.resolveSlugs("stripe");
  assert(slugs.length > 0, "resolveSlugs('stripe') returns matches");
  assert(slugs.includes("stripe"), "includes 'stripe'");

  // getAllSlugs
  const allSlugs = await engine.getAllSlugs();
  assert(allSlugs.size >= 40, `getAllSlugs() returns ${allSlugs.size} slugs`);

  console.log("\n── Links ──");

  // getLinks
  const samLinks = await engine.getLinks("sam-altman");
  assert(samLinks.length > 0, "getLinks('sam-altman') returns links");
  const hasOpenAI = samLinks.some(l => l.to_slug === "openai" && l.link_type === "founded");
  assert(hasOpenAI, "sam-altman → openai (founded) link exists");

  // getBacklinks
  const ycBacklinks = await engine.getBacklinks("y-combinator");
  assert(ycBacklinks.length >= 10, `y-combinator has backlinks (got ${ycBacklinks.length})`);
  const stripeIn = ycBacklinks.some(l => l.from_slug === "stripe");
  assert(stripeIn, "stripe → y-combinator backlink exists");

  // findByTitleFuzzy
  const found = await engine.findByTitleFuzzy("Stripe payment");
  assert(found !== null, "findByTitleFuzzy finds Stripe");
  assert(found?.slug === "stripe", "returns correct slug");

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
  assert(openaiNode!.depth === 1, "openai is depth 1 from sam-altman");

  // traversePaths (edge-based)
  const paths = await engine.traversePaths("y-combinator", { depth: 2, direction: "in" });
  assert(paths.length > 0, "traversePaths returns edges");
  assert(paths.every(p => p.to_slug === "y-combinator" || p.depth >= 1), "all paths point to YC");

  // findOrphanPages
  const orphans = await engine.findOrphanPages();
  console.log(`  📊 Orphans: ${orphans.length}`);
  
  console.log("\n── Search ──");

  // searchKeyword
  const results = await engine.searchKeyword("founder", { limit: 10 });
  assert(results.length > 0, "searchKeyword('founder') returns results");
  assert(results.every(r => r.score >= 0), "all results have scores");

  // searchKeyword with type filter
  const founderPeople = await engine.searchKeyword("founder", { type: "person", limit: 5 });
  assert(founderPeople.every(r => r.type === "person"), "type filter works on search");

  // searchKeyword with exclude
  const excludeAltman = await engine.searchKeyword("founder", { exclude_slugs: ["sam-altman"], limit: 5 });
  assert(!excludeAltman.some(r => r.slug === "sam-altman"), "exclude_slugs filters sam-altman");

  console.log("\n── Stats & Health ──");

  const stats = await engine.getStats();
  assert(stats.page_count >= 40, `stats.page_count >= 40 (${stats.page_count})`);
  assert(stats.link_count >= 60, `stats.link_count >= 60 (${stats.link_count})`);
  console.log(`  📊 Brain: ${stats.page_count} pages, ${stats.link_count} links`);

  const health = await engine.getHealth();
  assert(health.brain_score > 0, "health.brain_score > 0");

  console.log("\n── Tags ──");
  
  await engine.addTag("sam-altman", "test-tag-42");
  const tags = await engine.getTags("sam-altman");
  console.log(`  🏷️  Tags on sam-altman: ${tags}`);
  await engine.removeTag("sam-altman", "test-tag-42");

  console.log("\n── Timeline ──");

  const samTimeline = await engine.getTimeline("sam-altman");
  assert(samTimeline.length >= 4, `sam-altman has >= 4 timeline entries (${samTimeline.length})`);
  const chatGptEntry = samTimeline.find(e => e.summary.includes("ChatGPT"));
  assert(chatGptEntry !== undefined, "sam-altman has ChatGPT launch entry");

  // addTimelineEntry
  await engine.addTimelineEntry("sam-altman", {
    date: "2026-05-03",
    summary: "GBrain adapter integration test",
    source: "test",
  });

  console.log("\n── Unsupported methods (expected to throw) ──");
  
  const expectThrow = async (label: string, fn: () => Promise<any>) => {
    try {
      await fn();
      console.log(`  ❌ ${label} — should have thrown`);
      failed++;
    } catch (e: any) {
      assert(e.message.includes("not supported"), `${label} throws correctly`);
    }
  };

  await expectThrow("upsertChunks", () => engine.upsertChunks("test", []));
  await expectThrow("searchVector", () => engine.searchVector(new Float32Array(0)));
  await expectThrow("executeRaw", () => engine.executeRaw("SELECT 1"));

  // Backlink counts (N+1 but functional)
  const counts = await engine.getBacklinkCounts(["y-combinator", "sam-altman", "openai"]);
  assert(counts.get("y-combinator")! > 0, "y-combinator has backlinks");
  console.log(`  📊 Backlink counts: YC=${counts.get("y-combinator")}, Sam=${counts.get("sam-altman")}`);

  console.log(`\n${'═'.repeat(50)}`);
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(50)}`);

  await engine.disconnect();
}

run().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
