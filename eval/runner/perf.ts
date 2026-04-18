/**
 * BrainBench Category 7: Performance / Latency at scale.
 *
 * Measures gbrain operation latency (P50/P95/P99) and throughput at 1K and 10K
 * page scales. Currently gbrain has zero published performance numbers — this
 * eval changes that.
 *
 * Runs against PGLite (in-memory). A future variant should also run against
 * real Postgres for write-throughput comparison; not in scope today.
 *
 * Usage: bun run eval/runner/perf.ts [--scale 1000|10000] [--json]
 */

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { PageInput } from '../../src/core/types.ts';

interface LatencySample {
  op: string;
  scale: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  count: number;
}

interface ThroughputSample {
  op: string;
  scale: number;
  total_seconds: number;
  ops_per_sec: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

async function timeMany(label: string, scale: number, fn: () => Promise<unknown>, runs: number): Promise<LatencySample> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const { ms } = await timed(fn);
    samples.push(ms);
  }
  samples.sort((a, b) => a - b);
  return {
    op: label,
    scale,
    p50_ms: percentile(samples, 50),
    p95_ms: percentile(samples, 95),
    p99_ms: percentile(samples, 99),
    count: runs,
  };
}

/**
 * Procedural seeder. Power-law connection distribution: 5% of entities are
 * "hub nodes" with many inbound links; the rest are sparsely connected. This
 * matches real-brain shape and stresses the right code paths.
 */
function generateSeedData(scale: number): { pages: Array<{ slug: string; page: PageInput }>; links: Array<{ from: string; to: string; type: string }> } {
  const pages: Array<{ slug: string; page: PageInput }> = [];
  const links: Array<{ from: string; to: string; type: string }> = [];

  // 60% people, 20% companies, 10% meetings, 10% concepts
  const peopleN = Math.floor(scale * 0.6);
  const companyN = Math.floor(scale * 0.2);
  const meetingN = Math.floor(scale * 0.1);
  const conceptN = Math.floor(scale * 0.1);

  for (let i = 0; i < peopleN; i++) {
    const slug = `people/person-${i}`;
    pages.push({
      slug,
      page: {
        type: 'person', title: `Person ${i}`,
        compiled_truth: `Person ${i} works in tech. Met them via [Company](companies/company-${i % companyN}). Mentioned in [Meeting](meetings/meeting-${i % meetingN}).`,
        timeline: `- **2025-01-${(i % 28) + 1 < 10 ? '0' : ''}${(i % 28) + 1}** | First met\n- **2025-06-15** | Follow-up call\n- **2026-01-10** | Latest update`,
      },
    });
  }
  for (let i = 0; i < companyN; i++) {
    const slug = `companies/company-${i}`;
    pages.push({
      slug,
      page: {
        type: 'company', title: `Company ${i}`,
        compiled_truth: `Company ${i} is a startup in fintech.`,
        timeline: `- **2024-09-01** | Founded\n- **2025-03-15** | Seed round\n- **2026-02-01** | Series A`,
      },
    });
  }
  for (let i = 0; i < meetingN; i++) {
    const slug = `meetings/meeting-${i}`;
    pages.push({
      slug,
      page: {
        type: 'meeting', title: `Meeting ${i}`,
        compiled_truth: `Meeting ${i} attendees: [Person A](people/person-${i * 5 % peopleN}), [Person B](people/person-${(i * 5 + 1) % peopleN}), [Person C](people/person-${(i * 5 + 2) % peopleN}).`,
        timeline: `- **2026-03-01** | Meeting held`,
      },
    });
  }
  for (let i = 0; i < conceptN; i++) {
    pages.push({
      slug: `concepts/concept-${i}`,
      page: {
        type: 'concept', title: `Concept ${i}`,
        compiled_truth: `Concept ${i} relates to [Company](companies/company-${i % companyN}).`,
        timeline: `- **2025-12-01** | Wrote thesis`,
      },
    });
  }

  // Hub-node connections: 5% of people get 100+ inbound links from the rest.
  const hubCount = Math.max(1, Math.floor(peopleN * 0.05));
  for (let i = 0; i < hubCount; i++) {
    const hub = `people/person-${i}`;
    // Connect every Nth person to this hub.
    const interval = Math.max(1, Math.floor(peopleN / 100));
    for (let j = hubCount; j < peopleN; j += interval) {
      links.push({ from: `people/person-${j}`, to: hub, type: 'mentions' });
    }
  }

  return { pages, links };
}

async function runScale(scale: number, log: (msg: string) => void): Promise<{ latency: LatencySample[]; throughput: ThroughputSample[] }> {
  log(`\n## Scale: ${scale} pages\n`);

  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  const { pages, links } = generateSeedData(scale);

  // ── Throughput: bulk import via putPage ──
  const importStart = performance.now();
  for (const { slug, page } of pages) {
    await engine.putPage(slug, page);
  }
  const importSecs = (performance.now() - importStart) / 1000;
  const importTput: ThroughputSample = {
    op: 'putPage_bulk',
    scale,
    total_seconds: importSecs,
    ops_per_sec: pages.length / importSecs,
  };
  log(`Bulk putPage: ${pages.length} pages in ${importSecs.toFixed(1)}s = ${importTput.ops_per_sec.toFixed(1)} pages/sec`);

  // ── Throughput: bulk addLink ──
  const linkStart = performance.now();
  for (const l of links) {
    try { await engine.addLink(l.from, l.to, '', l.type); } catch { /* skip if either page missing */ }
  }
  const linkSecs = (performance.now() - linkStart) / 1000;
  const linkTput: ThroughputSample = {
    op: 'addLink_bulk',
    scale,
    total_seconds: linkSecs,
    ops_per_sec: links.length / linkSecs,
  };
  log(`Bulk addLink: ${links.length} links in ${linkSecs.toFixed(1)}s = ${linkTput.ops_per_sec.toFixed(1)} links/sec`);

  // ── Latency samples ──
  // Pick 50 random slugs to query.
  const sampleSlugs: string[] = [];
  for (let i = 0; i < 50; i++) {
    sampleSlugs.push(pages[Math.floor(Math.random() * pages.length)].slug);
  }
  const hubSlug = `people/person-0`; // known to have many inbound links

  const latency: LatencySample[] = [];

  latency.push(await timeMany('get_page', scale, () => engine.getPage(sampleSlugs[Math.floor(Math.random() * sampleSlugs.length)]), 50));
  latency.push(await timeMany('get_links', scale, () => engine.getLinks(sampleSlugs[Math.floor(Math.random() * sampleSlugs.length)]), 50));
  latency.push(await timeMany('get_backlinks', scale, () => engine.getBacklinks(sampleSlugs[Math.floor(Math.random() * sampleSlugs.length)]), 50));
  latency.push(await timeMany('get_backlinks_hub', scale, () => engine.getBacklinks(hubSlug), 20));
  latency.push(await timeMany('get_timeline', scale, () => engine.getTimeline(sampleSlugs[Math.floor(Math.random() * sampleSlugs.length)]), 50));
  latency.push(await timeMany('get_stats', scale, () => engine.getStats(), 10));
  latency.push(await timeMany('list_pages_50', scale, () => engine.listPages({ limit: 50 }), 20));
  latency.push(await timeMany('search_keyword', scale, () => engine.searchKeyword('person', { limit: 20 }), 30));
  latency.push(await timeMany('traverse_paths_d1', scale, () => engine.traversePaths(hubSlug, { depth: 1, direction: 'in' }), 10));
  latency.push(await timeMany('traverse_paths_d2', scale, () => engine.traversePaths(hubSlug, { depth: 2, direction: 'both' }), 10));

  // Single-page write latency (separate from bulk).
  let counter = 0;
  latency.push(await timeMany('putPage_single', scale, () => engine.putPage(`probes/p-${counter++}`, {
    type: 'concept', title: `P${counter}`, compiled_truth: 'A probe page.', timeline: '',
  }), 30));

  for (const s of latency) {
    log(`  ${s.op.padEnd(22)} P50=${s.p50_ms.toFixed(2)}ms  P95=${s.p95_ms.toFixed(2)}ms  P99=${s.p99_ms.toFixed(2)}ms  (n=${s.count})`);
  }

  await engine.disconnect();
  return { latency, throughput: [importTput, linkTput] };
}

async function main() {
  const json = process.argv.includes('--json');
  const log = json ? () => {} : console.log;

  const scaleArg = process.argv.findIndex(a => a === '--scale');
  const scales = scaleArg !== -1 ? [Number(process.argv[scaleArg + 1])] : [1000, 10000];

  log('# BrainBench Category 7: Performance / Latency\n');
  log(`Generated: ${new Date().toISOString().slice(0, 19)}`);
  log(`Engine: PGLite (in-memory)`);

  const allLatency: LatencySample[] = [];
  const allThroughput: ThroughputSample[] = [];

  for (const scale of scales) {
    const { latency, throughput } = await runScale(scale, log);
    allLatency.push(...latency);
    allThroughput.push(...throughput);
  }

  if (json) {
    process.stdout.write(JSON.stringify({ latency: allLatency, throughput: allThroughput }, null, 2) + '\n');
  }

  // Threshold check: P95 search latency at 10K pages should be < 200ms.
  const search10k = allLatency.find(l => l.op === 'search_keyword' && l.scale === 10000);
  if (search10k && search10k.p95_ms > 200) {
    console.error(`\n⚠ search_keyword P95 at 10K = ${search10k.p95_ms.toFixed(1)}ms (threshold 200ms)`);
  }
}

main().catch(e => {
  console.error('Perf benchmark error:', e);
  process.exit(1);
});
