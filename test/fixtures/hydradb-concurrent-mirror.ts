/** Separate-process synthetic HydraDB transport for the PostgreSQL ordering regression. */
import { writeFileSync } from 'node:fs';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { mirrorBrain } from '../../src/core/hydradb-mirror.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';

const [source, slug, stored, ready] = process.argv.slice(2) as [string, string, string, string];
const engine = new PostgresEngine();
const reply = (data: unknown) => new Response(JSON.stringify({ data }));
globalThis.fetch = (async (input: unknown, init: RequestInit) => {
  const url = new URL(String(input));
  if (url.pathname === '/context/ingest') {
    const form = init.body as FormData;
    const metadata = JSON.parse(String(form.get('document_metadata')));
    const files = form.getAll('documents') as File[];
    for (let i = 0; i < files.length; i++) {
      if (metadata[i].additional_metadata.gbrain_source === source && metadata[i].additional_metadata.gbrain_slug === slug) {
        writeFileSync(stored, await files[i]!.text());
      }
    }
    return reply({ failed_count: 0, results: metadata.map((item: { id: string }) => ({ id: item.id, status: 'queued' })) });
  }
  if (url.pathname === '/context/status') return reply({ statuses: (url.searchParams.get('ids') ?? '').split(',').map(id => ({ id, indexing_status: 'completed' })) });
  if (url.pathname === '/context' && init.method === 'DELETE') return reply({ results: JSON.parse(String(init.body)).ids.map((id: string) => ({ id, deleted: true })) });
  throw new Error(`Unexpected synthetic request ${url.pathname}`);
}) as typeof fetch;
await engine.connect({ database_url: requirePostgresTestDatabase(), poolSize: 3 });
try {
  writeFileSync(ready, 'ready');
  await mirrorBrain(engine, { database: 'review-synthetic', apiKey: 'hk_synthetic.fake' }, { full: true });
} finally { await engine.disconnect(); }
