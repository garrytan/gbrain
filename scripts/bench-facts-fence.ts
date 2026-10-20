/**
 * Synthetic repeated-reference benchmark; no brain, credentials, provider or DB is opened.
 * Run the same command on the base and patched worktrees:
 *   bun scripts/bench-facts-fence.ts [rows,...] [references,...]
 * SQL is stubbed with one immutable page; native snapshot overlay and remote sanitization run unchanged.
 */
import { createHash } from 'node:crypto';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { readPageSnapshot } from '../src/core/page-state/snapshot.ts';
import { sanitizeRemoteBody } from '../src/core/remote-body.ts';
import type { ReadQuery } from '../src/core/search/read-enrichment.ts';

function sizes(value: string | undefined, fallback: number[]): number[] {
  const numbers = value?.split(',').map(Number) ?? fallback;
  if (numbers.some(n => !Number.isSafeInteger(n) || n < 1 || n > 100_000)) throw new Error('Sizes must be integers in 1..100000');
  return numbers;
}

const results = [];
for (const count of sizes(process.argv[2], [100, 1000, 5000, 15_254])) {
  const facts: ParsedFact[] = Array.from({ length: count }, (_, i) => ({ rowNum: i + 1,
    claim: `Synthetic assertion ${i + 1}: ${'sample evidence '.repeat(8)}`, kind: 'fact', confidence: 1,
    visibility: i % 2 ? 'private' : 'world', notability: 'medium', validFrom: '2026-01-01', active: true,
    source: 'synthetic-fixture' }));
  const body = renderFactsTable(facts);
  const normalized = body.toLowerCase().split('\n').map(line => line.replace(/\s+/g, ' ')).join('\n');
  const ownerSlug = 'people/synthetic-owner';
  const row = { id: 1, source_id: 'fixture', slug: ownerSlug, type: 'person', title: 'Synthetic owner',
    compiled_truth: body, timeline: '', frontmatter: {}, created_at: '2026-01-01', updated_at: '2026-01-01',
    source_incarnation: 'fixture', snapshot_tags: [], fingerprint_body: normalized, fingerprint_timeline: '',
    snapshot_global_purges: { count: 0, latest: null }, snapshot_withdrawals: [{ visibility: 'private',
      fact_hash: createHash('sha256').update('unrelated withdrawn fixture claim').digest('hex'), withdrawn_at: '2026-10-01' }] };
  const query: ReadQuery = async <T>(_sql: string, params?: unknown[]) => {
    if (params?.[0] !== ownerSlug) throw new Error('Unexpected fixture query');
    return [{ ...row }] as T[];
  };
  for (const references of sizes(process.argv[3], [1, 10, 100])) {
    const pages = Array.from({ length: references }, (_, i) => ({ slug: `notes/reference-${i}`, body: `Reference [[${ownerSlug}]].` }));
    let checksum = 0;
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    for (const page of pages) {
      const target = /\[\[([^\]]+)\]\]/.exec(page.body)![1];
      const snapshot = await readPageSnapshot(query, target, { sourceId: 'fixture' });
      checksum += sanitizeRemoteBody(snapshot!.page.compiled_truth).length;
    }
    const usage = process.threadCpuUsage(cpu);
    results.push({ rows: count, bytes: Buffer.byteLength(body), references, wallMs: performance.now() - started,
      threadCpuMs: (usage.user + usage.system) / 1000, checksum, parsedRows: parseFactsFence(body).facts.length });
  }
}
console.log(JSON.stringify({ runtime: Bun.version, results }, null, 2));
