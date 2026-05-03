#!/usr/bin/env bun
// Inline integration test: creates brain, seeds, tests adapter
const BASE = "https://genres-oxide-publish-resume.trycloudflare.com";

async function main() {
  // 1. Create brain + get key
  const brainResp = await fetch(`${BASE}/v1/brains`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "adapter-final-test" }),
  });
  const brain = await brainResp.json();
  const BID = brain.brain_id;
  const KEY = brain.api_key;
  const H = { "Content-Type": "application/json", "X-API-Key": KEY };
  const URL = `${BASE}/v1/${BID}`;

  console.log(`Brain: ${BID}`);

  // 2. Seed pages
  const pages = [
    ["sam-altman", "Sam Altman", "person", "CEO of OpenAI. Former YC President."],
    ["openai", "OpenAI", "company", "AI research lab. Creator of ChatGPT."],
    ["y-combinator", "Y Combinator", "vc_firm", "Seed-stage accelerator."],
    ["garry-tan", "Garry Tan", "person", "YC President & CEO."],
    ["stripe", "Stripe", "company", "Payment infrastructure. YC S10."],
    ["coinbase", "Coinbase", "company", "Crypto exchange. YC S12. Public (COIN)."],
    ["a16z", "Andreessen Horowitz", "vc_firm", "Venture capital. $42B AUM."],
    ["san-francisco", "San Francisco", "city", "SF, California."],
  ];
  for (const [slug, title, type, content] of pages) {
    await fetch(`${URL}/pages/${slug}`, { method: "PUT", headers: H, body: JSON.stringify({ title, type, content }) });
  }
  console.log(`Seeded ${pages.length} pages`);

  // 3. Seed links
  const links = [
    ["sam-altman", "openai", "founded", "CEO & co-founder"],
    ["sam-altman", "y-combinator", "works_at", "Former President"],
    ["garry-tan", "y-combinator", "works_at", "President & CEO"],
    ["stripe", "y-combinator", "yc_batch", "S10"],
    ["coinbase", "y-combinator", "yc_batch", "S12"],
    ["openai", "san-francisco", "located_in", "HQ"],
    ["a16z", "openai", "invested_in", "Series B"],
    ["sam-altman", "garry-tan", "knows", "YC connection"],
  ];
  const linkPayloads = links.map(([from, to, type, ctx]) => ({ from_slug: from, to_slug: to, link_type: type, context: ctx }));
  await fetch(`${URL}/links/batch`, { method: "POST", headers: H, body: JSON.stringify({ links: linkPayloads }) });
  console.log(`Created ${links.length} links`);

  // 4. Now test the adapter
  process.env.GBRAIN_GRAPH_API_KEY = KEY;

  // Dynamic import of the adapter
  const { GraphBrainRestEngine } = await import("../src/core/graphbrain-engine.ts");

  const engine = new GraphBrainRestEngine();
  await engine.connect({ database_url: URL, engine: "graphbrain" });

  let ok = 0, fail = 0;
  const check = (cond, label) => { if (cond) { ok++; console.log(`  ✅ ${label}`); } else { fail++; console.log(`  ❌ ${label}`); } };

  // Pages
  const page = await engine.getPage("sam-altman");
  check(page !== null, "getPage returns page");
  check(page?.title === "Sam Altman", "title matches");
  check(page?.type === "person", "type is person");
  check(page?.compiled_truth.includes("CEO"), "content includes 'CEO'");

  const allPages = await engine.listPages();
  check(allPages.length >= 8, `listPages returns ${allPages.length} pages`);

  const people = await engine.listPages({ type: "person" });
  check(people.every(p => p.type === "person"), "type filter works");

  // CRUD cycle
  await engine.putPage("temp-page", { type: "note", title: "Temp", compiled_truth: "hello" });
  check((await engine.getPage("temp-page")) !== null, "putPage + getPage");
  await engine.deletePage("temp-page");
  check((await engine.getPage("temp-page")) === null, "deletePage");

  // Links
  const samLinks = await engine.getLinks("sam-altman");
  check(samLinks.length >= 2, `sam-altman has ${samLinks.length} links`);
  check(samLinks.some(l => l.to_slug === "openai"), "→ openai (founded)");
  check(samLinks.some(l => l.to_slug === "y-combinator"), "→ y-combinator (works_at)");

  // Backlinks
  const ycBacklinks = await engine.getBacklinks("y-combinator");
  check(ycBacklinks.length >= 4, `y-combinator has ${ycBacklinks.length} backlinks`);
  check(ycBacklinks.some(l => l.from_slug === "stripe"), "stripe → yc backlink");

  // Graph traversal
  const nodes = await engine.traverseGraph("sam-altman", 2);
  check(nodes.length > 0, `traverse sam-altman depth 2 → ${nodes.length} nodes`);
  check(nodes.some(n => n.slug === "openai"), "traverse reaches openai");

  const paths = await engine.traversePaths("y-combinator", { depth: 2, direction: "in" });
  check(paths.length >= 4, `traversePaths in→YC returns ${paths.length} paths`);

  // Search
  const results = await engine.searchKeyword("Altman", { limit: 5 });
  check(results.some(r => r.slug === "sam-altman"), "search finds sam-altman");

  const resultsTyped = await engine.searchKeyword("Altman", { type: "person", limit: 5 });
  check(resultsTyped.every(r => r.type === "person"), "search type filter");

  // Stats
  const stats = await engine.getStats();
  check(stats.page_count >= 8, `stats.page_count = ${stats.page_count}`);
  check(stats.link_count >= 8, `stats.link_count = ${stats.link_count}`);
  console.log(`  📊 ${stats.page_count} pages, ${stats.link_count} links`);

  // Health
  const health = await engine.getHealth();
  check(health.brain_score > 0, `brain_score = ${health.brain_score}`);

  // Backlink counts
  const counts = await engine.getBacklinkCounts(["y-combinator", "sam-altman"]);
  check(counts.get("y-combinator")! > 0, `y-combinator backlink count: ${counts.get("y-combinator")}`);

  // Unsupported methods (should throw)
  for (const [name, fn] of [
    ["upsertChunks", () => engine.upsertChunks("x", [])],
    ["searchVector", () => engine.searchVector(new Float32Array(0))],
    ["executeRaw", () => engine.executeRaw("SELECT 1")],
  ]) {
    try { await fn(); check(false, name); } catch (e) { check(e.message.includes("not supported"), `${name} throws`); }
  }

  console.log(`\n${"═".repeat(40)}`);
  console.log(` ${ok} passed, ${fail} failed`);
  console.log(`${"═".repeat(40)}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
