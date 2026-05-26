#!/usr/bin/env bun
/**
 * Direct embed-stale recovery script.
 *
 * Bypasses gbrain's embed.ts entirely (which has a hang issue at a specific
 * cursor position that we couldn't diagnose). Talks directly to PGLite + OpenAI:
 *
 *   1. SELECT id, page_id, chunk_index, chunk_text FROM content_chunks
 *      WHERE embedding IS NULL ORDER BY (page_id, chunk_index)
 *   2. Batch chunk_texts up to BATCH_SIZE per OpenAI embeddings call
 *   3. UPDATE content_chunks SET embedding = ... per row
 *
 * Cursor pagination on (page_id, chunk_index) so we resume cleanly across
 * runs. A page that errors out is skipped; re-run picks it up.
 *
 * Env:
 *   OPENAI_API_KEY     required
 *   PGLITE_PATH        default: C:/Users/rwo3/.gbrain/brain.pglite
 *   BATCH_SIZE         default: 512  (chunks per OpenAI call)
 *   PARALLEL           default: 8    (concurrent embed+store ops)
 *   CALL_TIMEOUT_MS    default: 60000 (per OpenAI call)
 */
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import OpenAI from 'openai';

const PGLITE_PATH = process.env.PGLITE_PATH || 'C:/Users/rwo3/.gbrain/brain.pglite';
// FETCH_SIZE: rows pulled from PGLite per cursor advance. Big enough that
// downstream token-based packing has room to fill multiple OpenAI batches.
const FETCH_SIZE = parseInt(process.env.FETCH_SIZE || '2000', 10);
// MAX_BATCH_TOKENS: OpenAI's embeddings endpoint caps at 300K tokens per
// request. Empirical observation: char-based estimate undercounts by ~40%
// on dense content (URLs, structured data, base64). Target 180K so the
// worst case is well under the 300K hard cap.
const MAX_BATCH_TOKENS = parseInt(process.env.MAX_BATCH_TOKENS || '180000', 10);
// Hard ceiling on rows per OpenAI call. Most chunks are short, so a 2048
// cap rarely binds — token-based packing is the real limit.
const MAX_BATCH_ROWS = parseInt(process.env.MAX_BATCH_ROWS || '2048', 10);
// Single-chunk safety: OpenAI's text-embedding-3-large accepts up to 8191
// tokens per input. Chunks larger than that need to be truncated before send.
const MAX_INPUT_TOKENS = 8000;
const PARALLEL = parseInt(process.env.PARALLEL || '8', 10);
const CALL_TIMEOUT_MS = parseInt(process.env.CALL_TIMEOUT_MS || '60000', 10);

// Token estimate from char length. Empirical observation on this corpus:
// dense content (URLs, structured data) hits ~2.5 chars/token; conservative
// English averages ~3.5. We use 2.5 to over-estimate (safe).
function estTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

function truncateToTokenLimit(text: string, limit: number): string {
  const estChars = limit * 3;  // conservative (under-estimate chars per token)
  return text.length > estChars ? text.slice(0, estChars) : text;
}

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY not set');
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 1,
  timeout: CALL_TIMEOUT_MS,
});

console.log(`Opening PGLite at ${PGLITE_PATH}`);
const db = await PGlite.create(PGLITE_PATH, { extensions: { vector } });

const totalRes = await db.query<{ c: number }>(
  "SELECT COUNT(*)::int AS c FROM content_chunks WHERE embedding IS NULL"
);
const total = totalRes.rows[0].c;
console.log(`Stale chunks: ${total}`);
if (total === 0) {
  console.log('Nothing to do.');
  await db.close();
  process.exit(0);
}

let cursor: [number, number] = [0, -1];
let done = 0;
let errors = 0;
const startTime = Date.now();
let lastReportTime = startTime;
let lastReportDone = 0;

type Row = { id: number; page_id: number; chunk_index: number; chunk_text: string };

// Buffer holding rows fetched from PGLite but not yet packed into a token
// batch. The producer (nextBatch) drains from here first; only when the
// buffer is empty does it page from PGLite.
let buffer: Row[] = [];
let bufferExhausted = false;

async function refillBuffer(): Promise<void> {
  const r = await db.query<Row>(
    `SELECT id, page_id, chunk_index, chunk_text
     FROM content_chunks
     WHERE embedding IS NULL AND (page_id, chunk_index) > ($1, $2)
     ORDER BY page_id, chunk_index
     LIMIT $3`,
    [cursor[0], cursor[1], FETCH_SIZE],
  );
  if (r.rows.length === 0) {
    bufferExhausted = true;
    return;
  }
  const last = r.rows[r.rows.length - 1];
  cursor = [last.page_id, last.chunk_index];
  buffer = r.rows;
  if (r.rows.length < FETCH_SIZE) bufferExhausted = true;
}

async function nextBatch(): Promise<Row[] | null> {
  if (buffer.length === 0) {
    if (bufferExhausted) return null;
    await refillBuffer();
    if (buffer.length === 0) return null;
  }
  const batch: Row[] = [];
  let tokenSum = 0;
  while (buffer.length > 0) {
    const next = buffer[0];
    const tokens = Math.min(estTokens(next.chunk_text), MAX_INPUT_TOKENS);
    // First row always goes in even if it exceeds (we truncate it on send).
    if (batch.length === 0 || (tokenSum + tokens <= MAX_BATCH_TOKENS && batch.length < MAX_BATCH_ROWS)) {
      batch.push(buffer.shift()!);
      tokenSum += tokens;
    } else {
      break;
    }
  }
  return batch;
}

// Parse "Please try again in Xms" or "in X.Ys" from a 429 error message.
function parseRetryAfter(msg: string): number | null {
  const ms = msg.match(/try again in (\d+)ms/i);
  if (ms) return parseInt(ms[1], 10);
  const sec = msg.match(/try again in ([\d.]+)s/i);
  if (sec) return Math.ceil(parseFloat(sec[1]) * 1000);
  return null;
}

async function callEmbeddings(inputs: string[]): Promise<number[][]> {
  // Up to 6 attempts on 429 (TPM rate-limit waves at tier 5 are short, 100ms-2s).
  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await openai.embeddings.create({
        model: 'text-embedding-3-large',
        input: inputs,
        dimensions: 1536,
      });
      return resp.data.map(d => d.embedding);
    } catch (e: any) {
      const status = e?.status ?? e?.response?.status;
      const msg = e?.message ?? String(e);
      if (status === 429 && attempt < MAX_ATTEMPTS) {
        const retryMs = parseRetryAfter(msg) ?? 1000;
        // Add 20% jitter so concurrent workers don't re-sync on the next wave.
        const jittered = Math.floor(retryMs * (1 + Math.random() * 0.4));
        await new Promise(r => setTimeout(r, jittered));
        continue;
      }
      throw e;
    }
  }
  throw new Error('embeddings.create: exhausted retries');
}

async function embedAndStore(batch: Row[]): Promise<void> {
  // Truncate any single chunk over the model's 8191-token input cap.
  const inputs = batch.map(b => truncateToTokenLimit(b.chunk_text, MAX_INPUT_TOKENS));
  // OpenAI batch embed — token-bounded by the packer, row-bounded by MAX_BATCH_ROWS.
  const embeddings = await callEmbeddings(inputs);
  if (embeddings.length !== batch.length) {
    throw new Error(`Embed response mismatch: got ${embeddings.length}, expected ${batch.length}`);
  }
  // For the body below we want resp.data[i].embedding; rename for minimal diff.
  const resp = { data: embeddings.map(embedding => ({ embedding })) };
  if (resp.data.length !== batch.length) {
    throw new Error(`Embed response mismatch: got ${resp.data.length}, expected ${batch.length}`);
  }
  // UPDATE per row in a single transaction. PGLite's local cost per UPDATE
  // is dominated by the wire-format conversion of the vector, not the
  // SQL execution. A transaction batches the commit.
  await db.transaction(async (tx) => {
    for (let i = 0; i < batch.length; i++) {
      const vec = `[${resp.data[i].embedding.join(',')}]`;
      await tx.query(
        `UPDATE content_chunks
         SET embedding = $1::vector, embedded_at = NOW()
         WHERE id = $2`,
        [vec, batch[i].id],
      );
    }
  });
  done += batch.length;
  // Throttled progress reporting (every 5 seconds).
  const now = Date.now();
  if (now - lastReportTime >= 5000) {
    const deltaDone = done - lastReportDone;
    const deltaTime = (now - lastReportTime) / 1000;
    const recentRate = deltaDone / deltaTime;
    const remaining = total - done;
    const eta = remaining / Math.max(recentRate, 0.001);
    console.log(
      `embedded ${done}/${total} (${(done / total * 100).toFixed(1)}%) ` +
      `recent=${recentRate.toFixed(1)}/s eta=${(eta / 60).toFixed(1)}min errors=${errors}`,
    );
    lastReportTime = now;
    lastReportDone = done;
  }
}

// Sliding pool: a single producer (fetchBatch) feeds N parallel consumers.
// fetchBatch is called sequentially to advance the cursor cleanly.
let inFlight = 0;
let producerDone = false;

// End-to-end timeout per batch. If a single batch can't finish in this
// window (counting all retries + DB UPDATE), we abort it and mark the
// chunks as errored. The chunks stay stale and a future run picks them up.
// Without this, a single problematic page can hold a worker hostage and —
// if multiple workers wedge on the same problematic point — stall the
// whole pipeline.
const BATCH_TIMEOUT_MS = parseInt(process.env.BATCH_TIMEOUT_MS || '90000', 10);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function tick(): Promise<void> {
  // Block until a slot is free or producer is done.
  while (inFlight >= PARALLEL && !producerDone) {
    await new Promise(r => setTimeout(r, 25));
  }
  if (producerDone) return;
  const batch = await nextBatch();
  if (batch === null) {
    producerDone = true;
    return;
  }
  inFlight++;
  withTimeout(embedAndStore(batch), BATCH_TIMEOUT_MS, `batch (first id ${batch[0].id})`)
    .catch(e => {
      errors++;
      console.error(`batch failed (${batch.length} chunks, first id ${batch[0].id}): ${e instanceof Error ? e.message : e}`);
    })
    .finally(() => {
      inFlight--;
    });
}

while (!producerDone) {
  await tick();
}
// Drain remaining in-flight embeds.
while (inFlight > 0) {
  await new Promise(r => setTimeout(r, 100));
}

const elapsed = (Date.now() - startTime) / 1000;
console.log(`\nDone. Embedded ${done}/${total} chunks in ${elapsed.toFixed(1)}s (avg ${(done / elapsed).toFixed(1)}/s). Errors: ${errors}.`);
await db.close();
