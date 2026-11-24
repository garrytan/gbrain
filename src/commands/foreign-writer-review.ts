/** Local, append-only operator acknowledgements for reviewed historical foreign commits. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { acquireNativeLockSync } from '../core/persistence/native-lock.ts';

export const FOREIGN_WRITER_REVIEW_FILE = 'foreign-writer-reviews.jsonl';
const LOCK_FILE = 'foreign-writer-reviews.lock';
export interface ForeignWriterReview { v: 1; e: 'contained'; t: string; source_id: string; sha: string; reason: string }

function files(common: string) {
  const dir = join(common, 'gbrain');
  return { dir, review: join(dir, FOREIGN_WRITER_REVIEW_FILE), lock: join(dir, LOCK_FILE) };
}

export function readForeignWriterReviews(common: string): ForeignWriterReview[] {
  const file = files(common).review;
  if (!existsSync(file)) return [];
  const rows: ForeignWriterReview[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const row = JSON.parse(line) as ForeignWriterReview;
      if (row?.v === 1 && row.e === 'contained' && typeof row.source_id === 'string' && /^[0-9a-f]{40}$/.test(row.sha) && typeof row.reason === 'string') rows.push(row);
    } catch { /* a torn or unrelated local line is not a containment acknowledgement */ }
  }
  return rows;
}

export function appendForeignWriterReviews(common: string, rows: ForeignWriterReview[]): void {
  const f = files(common);
  mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  const lock = acquireNativeLockSync(f.lock, { timeoutMs: 2_000 });
  if (!lock) throw new Error(`foreign-writer review lock stayed busy: ${f.lock}`);
  try { appendFileSync(f.review, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 }); }
  finally { lock.release(); }
}

export function foreignWriterReviewHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
