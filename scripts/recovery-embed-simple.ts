#!/usr/bin/env bun
/**
 * Simple sequential embed-stale recovery.
 *
 * Reads stale chunks, embeds in token-bounded OpenAI batches, writes back
 * via UPDATE. ONE worker. No parallelism, no complex queue. The point is to
 * isolate WHY the parallel version stalls — if THIS stalls, we know exactly
 * which chunk it's on (logs every batch start/end with first id).
 *
 * Env:
 *   OPENAI_API_KEY     required
 *   PGLITE_PATH        default: C:/Users/rwo3/.gbrain/brain.pglite
 *   MAX_BATCH_TOKENS   default: 180000
 *   FETCH_SIZE         default: 2000
 *   CALL_TIMEOUT_MS    default: 60000
 *   START_AFTER        default: 0:-1  (page_id:chunk_index resume point)
 */
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

const PGLITE_PATH = process.env.PGLITE_PATH || 'C:/Users/rwo3/.gbrain/brain.pglite';
const MAX_BATCH_TOKENS = parseInt(process.env.MAX_BATCH_TOKENS || '180000', 10);
const MAX_BATCH_ROWS = 2048;
const MAX_INPUT_TOKENS = 8000;
const FETCH_SIZE = parseInt(process.env.FETCH_SIZE || '2000', 10);
const CALL_TIMEOUT_MS = parseInt(process.env.CALL_TIMEOUT_MS || '60000', 10);
const startParts = (process.env.START_AFTER || '0:-1').split(':');
let cursorPid = parseInt(startParts[0], 10);
let cursorIdx = parseInt(startParts[1], 10);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY not set');
  process.exit(1);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;
// We use raw fetch() instead of the OpenAI SDK because the SDK's AbortSignal
// handling on bun/Windows has been observed to not fire reliably — calls
// hang indefinitely on certain payloads. fetch() + AbortController is the
// platform primitive and works deterministically.

function estTokens(text: string): number {
  return Math.ceil(text.length / 2.5);
}

function parseRetryAfter(msg: string): number | null {
  const ms = msg.match(/try again in (\d+)ms/i);
  if (ms) return parseInt(ms[1], 10);
  const sec = msg.match(/try again in ([\d.]+)s/i);
  if (sec) return Math.ceil(parseFloat(sec[1]) * 1000);
  return null;
}

type Row = { id: number; page_id: number; chunk_index: number; chunk_text: string };

import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TMP_DIR = join(tmpdir(), `embed-recovery-${process.pid}`);
mkdirSync(TMP_DIR, { recursive: true });
let tmpCounter = 0;

// Shell out to curl with body in a temp file (avoids stdin-pipe deadlocks
// observed with Bun.spawn). curl's --max-time is honored by libcurl at the
// socket level, so we get deterministic timeouts even when bun's fetch
// would hang. The temp file is overwritten per call and cleaned on success.
async function callEmbeddings(inputs: string[]): Promise<number[][]> {
  const body = JSON.stringify({
    model: 'text-embedding-3-large',
    input: inputs,
    dimensions: 1536,
  });
  const bodyFile = join(TMP_DIR, `body-${tmpCounter++}.json`);
  const outFile = join(TMP_DIR, `out-${tmpCounter}.json`);
  writeFileSync(bodyFile, body);

  for (let attempt = 1; attempt <= 6; attempt++) {
    const proc = Bun.spawn(
      [
        'curl',
        '--silent',
        '--show-error',
        '--max-time', String(Math.ceil(CALL_TIMEOUT_MS / 1000)),
        '-X', 'POST',
        '-H', `Authorization: Bearer ${OPENAI_API_KEY}`,
        '-H', 'Content-Type: application/json',
        '-o', outFile,
        '-w', '%{http_code}',
        '--data-binary', `@${bodyFile}`,
        'https://api.openai.com/v1/embeddings',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [statusStr, stderrBuf, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode === 28) {
      if (attempt < 6) {
        process.stdout.write(`[timeout] curl timed out after ${CALL_TIMEOUT_MS}ms, retrying (attempt ${attempt})\n`);
        continue;
      }
      throw new Error(`curl timed out after ${CALL_TIMEOUT_MS}ms on attempt ${attempt}`);
    }
    if (exitCode !== 0) {
      throw new Error(`curl exit ${exitCode}: ${stderrBuf}`);
    }
    const statusCode = parseInt(statusStr.trim(), 10);
    const bodyText = await Bun.file(outFile).text();

    if (statusCode === 429 && attempt < 6) {
      const retryMs = parseRetryAfter(bodyText) ?? 1000;
      const jittered = Math.floor(retryMs * (1 + Math.random() * 0.4));
      process.stdout.write(`[429] retry in ${jittered}ms (attempt ${attempt})\n`);
      await new Promise(r => setTimeout(r, jittered));
      continue;
    }
    if (statusCode < 200 || statusCode >= 300) {
      const err: any = new Error(`HTTP ${statusCode}: ${bodyText.slice(0, 200)}`);
      err.status = statusCode;
      throw err;
    }
    const json = JSON.parse(bodyText) as { data: Array<{ embedding: number[] }> };
    try { unlinkSync(bodyFile); unlinkSync(outFile); } catch {}
    return json.data.map(d => d.embedding);
  }
  try { unlinkSync(bodyFile); } catch {}
  throw new Error('embeddings: retries exhausted');
}

console.log(`Opening PGLite at ${PGLITE_PATH}`);
const db = await PGlite.create(PGLITE_PATH, { extensions: { vector } });
const totalRes = await db.query<{ c: number }>(
  "SELECT COUNT(*)::int AS c FROM content_chunks WHERE embedding IS NULL"
);
const total = totalRes.rows[0].c;
console.log(`Stale chunks: ${total}, starting after (${cursorPid}, ${cursorIdx})`);
if (total === 0) {
  console.log('Nothing to do.');
  await db.close();
  process.exit(0);
}

let done = 0;
let errors = 0;
let batchNum = 0;
const startTime = Date.now();

while (true) {
  // Fetch next page of rows.
  const r = await db.query<Row>(
    `SELECT id, page_id, chunk_index, chunk_text
     FROM content_chunks
     WHERE embedding IS NULL AND (page_id, chunk_index) > ($1, $2)
     ORDER BY page_id, chunk_index
     LIMIT $3`,
    [cursorPid, cursorIdx, FETCH_SIZE],
  );
  if (r.rows.length === 0) break;
  const last = r.rows[r.rows.length - 1];
  cursorPid = last.page_id;
  cursorIdx = last.chunk_index;

  // Pack into token-bounded batches and process each.
  let bufStart = 0;
  while (bufStart < r.rows.length) {
    const batch: Row[] = [];
    let tokenSum = 0;
    for (let i = bufStart; i < r.rows.length; i++) {
      const next = r.rows[i];
      const tokens = Math.min(estTokens(next.chunk_text), MAX_INPUT_TOKENS);
      if (batch.length === 0 || (tokenSum + tokens <= MAX_BATCH_TOKENS && batch.length < MAX_BATCH_ROWS)) {
        batch.push(next);
        tokenSum += tokens;
      } else {
        break;
      }
    }
    bufStart += batch.length;
    batchNum++;
    const batchStart = Date.now();
    process.stdout.write(`[batch ${batchNum}] ${batch.length} chunks, ~${tokenSum} tokens, first id ${batch[0].id} ... `);

    try {
      const inputs = batch.map(b => {
        const t = b.chunk_text;
        return t.length > MAX_INPUT_TOKENS * 3 ? t.slice(0, MAX_INPUT_TOKENS * 3) : t;
      });
      const embeddings = await callEmbeddings(inputs);
      if (embeddings.length !== batch.length) {
        throw new Error(`embed mismatch: ${embeddings.length} vs ${batch.length}`);
      }
      // UPDATE per row in a transaction.
      await db.transaction(async (tx) => {
        for (let i = 0; i < batch.length; i++) {
          const vec = `[${embeddings[i].join(',')}]`;
          await tx.query(
            `UPDATE content_chunks SET embedding = $1::vector, embedded_at = NOW() WHERE id = $2`,
            [vec, batch[i].id],
          );
        }
      });
      done += batch.length;
      const dt = ((Date.now() - batchStart) / 1000).toFixed(1);
      const totalDt = (Date.now() - startTime) / 1000;
      const rate = done / totalDt;
      const eta = (total - done) / Math.max(rate, 0.001) / 60;
      process.stdout.write(`OK ${dt}s | done=${done}/${total} (${(done/total*100).toFixed(1)}%) avg=${rate.toFixed(1)}/s eta=${eta.toFixed(1)}min\n`);
    } catch (e) {
      errors++;
      const dt = ((Date.now() - batchStart) / 1000).toFixed(1);
      process.stdout.write(`FAIL ${dt}s: ${e instanceof Error ? e.message : e}\n`);
      // Continue to next batch — bad batch's chunks stay stale for a future run.
    }
  }
}

const totalDt = (Date.now() - startTime) / 1000;
console.log(`\nDone. Embedded ${done}/${total} in ${totalDt.toFixed(1)}s (avg ${(done/totalDt).toFixed(1)}/s). Errors: ${errors}. Final cursor: (${cursorPid}, ${cursorIdx})`);
await db.close();
