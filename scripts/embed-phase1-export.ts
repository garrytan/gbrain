#!/usr/bin/env bun
/**
 * Phase 1 of the 3-phase embed-recovery: export stale chunks to JSONL.
 * Bun handles PGLite. Python (phase 2) handles OpenAI. Bun again (phase 3)
 * writes results back. Splitting avoids bun's flaky Windows HTTP stack.
 */
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { writeFileSync } from 'fs';

const PGLITE_PATH = process.env.PGLITE_PATH || 'C:/Users/rwo3/.gbrain/brain.pglite';
const OUT_PATH = process.argv[2] || 'C:/Users/rwo3/AppData/Local/Temp/embed-stale-chunks.jsonl';

console.log(`Opening PGLite at ${PGLITE_PATH}`);
const db = await PGlite.create(PGLITE_PATH, { extensions: { vector } });
const r = await db.query<{ id: number; chunk_text: string }>(
  `SELECT id, chunk_text FROM content_chunks
   WHERE embedding IS NULL
   ORDER BY page_id, chunk_index`,
);
console.log(`Exporting ${r.rows.length} stale chunks to ${OUT_PATH}`);

const lines: string[] = [];
for (const row of r.rows) {
  lines.push(JSON.stringify({ id: row.id, text: row.chunk_text }));
}
writeFileSync(OUT_PATH, lines.join('\n') + '\n');
await db.close();
console.log(`Wrote ${lines.length} rows to ${OUT_PATH}`);
