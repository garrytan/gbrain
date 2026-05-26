#!/usr/bin/env bun
/**
 * Look at chunks around the embed-stall point to find what's pathological.
 */
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

const PGLITE_PATH = process.env.PGLITE_PATH || 'C:/Users/rwo3/.gbrain/brain.pglite';
const START_ID = parseInt(process.argv[2] || '108354', 10);
const RANGE = parseInt(process.argv[3] || '200', 10);

const db = await PGlite.create(PGLITE_PATH, { extensions: { vector } });

// Get the chunks around the start id, including their slug
const r = await db.query<{
  id: number;
  page_id: number;
  chunk_index: number;
  slug: string;
  chunk_source: string;
  text_len: number;
  text_preview: string;
}>(
  `SELECT cc.id, cc.page_id, cc.chunk_index, p.slug, cc.chunk_source,
          LENGTH(cc.chunk_text) AS text_len,
          SUBSTR(cc.chunk_text, 1, 80) AS text_preview
   FROM content_chunks cc
   JOIN pages p ON p.id = cc.page_id
   WHERE cc.id >= $1 AND cc.id < $2 AND cc.embedding IS NULL
   ORDER BY cc.id
   LIMIT 250`,
  [START_ID, START_ID + RANGE],
);

console.log(`Stale chunks around id ${START_ID} (range ${RANGE}):`);
console.log(`Total: ${r.rows.length}`);
console.log('');

// Find the OUTLIERS by text length
const sortedByLen = [...r.rows].sort((a, b) => b.text_len - a.text_len);
console.log('Top 10 by length:');
for (const row of sortedByLen.slice(0, 10)) {
  console.log(`  id=${row.id} pid=${row.page_id} idx=${row.chunk_index} len=${row.text_len} slug=${row.slug} source=${row.chunk_source}`);
  console.log(`    preview: ${row.text_preview.replace(/\n/g, '\\n')}`);
}

// Histogram of text lengths
const buckets = { '0-500': 0, '500-2K': 0, '2K-8K': 0, '8K-20K': 0, '20K+': 0 };
for (const row of r.rows) {
  if (row.text_len < 500) buckets['0-500']++;
  else if (row.text_len < 2000) buckets['500-2K']++;
  else if (row.text_len < 8000) buckets['2K-8K']++;
  else if (row.text_len < 20000) buckets['8K-20K']++;
  else buckets['20K+']++;
}
console.log('\nLength histogram:');
for (const [k, v] of Object.entries(buckets)) {
  console.log(`  ${k}: ${v}`);
}

// Check for chunks with weird characters
const weird: typeof r.rows = [];
for (const row of r.rows) {
  if (/[\x00-\x08\x0E-\x1F\x7F]/.test(row.text_preview)) weird.push(row);
}
if (weird.length) {
  console.log(`\n${weird.length} chunks with control chars in first 80 bytes:`);
  for (const row of weird.slice(0, 5)) {
    console.log(`  id=${row.id} slug=${row.slug}`);
  }
}

await db.close();
