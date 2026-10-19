/** Database-free, one index per process: bun scripts/bench-reference-index.ts 100000 (also 300000, 600000). */
import { buildSourceLocalReferenceIndex } from '../src/core/source-local-reference-index.ts';

const count = Number(process.argv[2]);
if (![100_000, 300_000, 600_000].includes(count)) throw new Error('Pass 100000, 300000 or 600000 pages.');
const pages = Array.from({ length: count }, (_, i) => {
  const id = String(i).padStart(6, '0');
  return { slug: `records/record-${id}`, title: `Record ${id}`, aliases: [`Public record ${id}`, `Entry ${id}`] };
});
const metadataBytes = pages.reduce((sum, page) => sum + Buffer.byteLength(JSON.stringify([
  page.slug, page.title, page.aliases.map(alias => alias.toLowerCase()),
])), 0);
const rssBeforeMiB = process.memoryUsage().rss / 1024 ** 2;
const start = performance.now();
const index = buildSourceLocalReferenceIndex(pages, { maxPages: count, maxBytes: metadataBytes });
const buildMs = performance.now() - start;
const last = String(count - 1).padStart(6, '0');
if (index.resolveMatches(`Public record ${last}`)[0] !== `records/record-${last}`) throw new Error('Index lookup failed.');
console.log(JSON.stringify({ pages: count, metadataMiB: metadataBytes / 1024 ** 2, buildMs,
  rssBeforeMiB, peakRssMiB: process.resourceUsage().maxRSS / 1024 }));
