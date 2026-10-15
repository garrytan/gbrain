/** Benchmark setup only: production page projection and verified ingestion, bounded parallel batches. */
import type { BrainEngine } from '../../src/core/engine.ts';
import { hydraProjection } from '../../src/core/hydradb-mirror.ts';
import { isPrivatePage } from '../../src/core/search/private-visibility.ts';
import { redactFindings } from '../../src/core/secret-scan.ts';
import { hydraDocId, hydraDocMetadata, type HydraConnection } from '../../src/core/hydradb.ts';
import { ingestHydra } from '../../src/core/hydradb-transfer.ts';

export async function uploadBenchmarkCorpus(engine: BrainEngine, conn: HydraConnection,
  sources: string[], concurrency: number, progress: (indexed: number) => void) {
  const refs = await engine.executeRaw<{ source_id: string; slug: string }>(
    'SELECT source_id, slug FROM pages WHERE source_id = ANY($1::text[]) AND deleted_at IS NULL ORDER BY source_id, slug', [sources]);
  const cancel = new AbortController();
  let next = 0, indexed = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    try {
      for (;;) {
        cancel.signal.throwIfAborted();
        const offset = next; next += 50;
        const batch = refs.slice(offset, offset + 50);
        if (!batch.length) return;
        const form = new FormData();
        form.set('type', 'knowledge'); form.set('database', conn.database); form.set('upsert', 'true');
        const metadata: Array<{ id: string; additional_metadata: ReturnType<typeof hydraDocMetadata> }> = [];
        for (const ref of batch) {
          const page = await engine.getPage(ref.slug, { sourceId: ref.source_id });
          if (!page || isPrivatePage(page)) throw new Error('The benchmark corpus contains a missing or private page.');
          const text = await hydraProjection(engine, page);
          if (!text) throw new Error('The benchmark corpus contains an empty outgoing projection.');
          const title = redactFindings(page.title || page.slug, { highEntropy: true }).text;
          form.append('documents', new Blob([`# ${title}\n\n${text}\n`], { type: 'text/markdown' }), `${title.replace(/[\\/\x00-\x1f]/g, ' ').slice(0, 120)}.md`);
          metadata.push({ id: hydraDocId(ref.source_id, ref.slug), additional_metadata: hydraDocMetadata(ref.source_id, ref.slug, page) });
        }
        form.set('document_metadata', JSON.stringify(metadata));
        await ingestHydra(conn, form, metadata.map(m => m.id), cancel.signal);
        indexed += batch.length; progress(indexed);
      }
    } catch (error) { cancel.abort(); throw error; }
  });
  const results = await Promise.allSettled(workers);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) throw failed.reason;
  if (indexed !== refs.length) throw new Error('Incomplete cloud corpus; refusing to benchmark.');
  return { upserted: indexed, removed: 0, skipped: 0, concurrency,
    method: 'production_projection_and_ingestHydra', batches: Math.ceil(refs.length / 50) };
}
