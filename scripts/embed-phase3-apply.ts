#!/usr/bin/env bun
/**
 * Phase 3 of the 3-phase embed-recovery: read (id, vec) JSONL produced by
 * the Python embed call, UPDATE the chunks in PGLite.
 */
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { readFileSync } from 'fs';

const PGLITE_PATH = process.env.PGLITE_PATH || 'C:/Users/rwo3/.gbrain/brain.pglite';
const INPUT_PATH = process.argv[2] || 'C:/Users/rwo3/AppData/Local/Temp/embed-vectors.jsonl';

console.log(`Reading ${INPUT_PATH}`);
const content = readFileSync(INPUT_PATH, 'utf-8');
const rows: Array<{ id: number; vec: number[] }> = [];
for (const line of content.split('\n')) {
  const trim = line.trim();
  if (trim) rows.push(JSON.parse(trim));
}
console.log(`Applying ${rows.length} embeddings to ${PGLITE_PATH}`);

const db = await PGlite.create(PGLITE_PATH, { extensions: { vector } });

// Smaller transactions = more frequent commits, less work lost per kill.
// Bun's stdout buffers; using console.log instead of process.stdout.write
// flushes per line via the standard logger.
const BATCH = 100;
let done = 0;
const start = Date.now();
for (let i = 0; i < rows.length; i += BATCH) {
  const slice = rows.slice(i, i + BATCH);
  await db.transaction(async (tx) => {
    for (const r of slice) {
      const vec = `[${r.vec.join(',')}]`;
      await tx.query(
        `UPDATE content_chunks SET embedding = $1::vector, embedded_at = NOW() WHERE id = $2`,
        [vec, r.id],
      );
    }
  });
  done += slice.length;
  const dt = (Date.now() - start) / 1000;
  const rate = done / dt;
  console.log(`applied ${done}/${rows.length} (${(done/rows.length*100).toFixed(1)}%) rate=${rate.toFixed(0)}/s`);
}
await db.close();
console.log(`Done. Applied ${done} embeddings in ${((Date.now()-start)/1000).toFixed(1)}s.`);
