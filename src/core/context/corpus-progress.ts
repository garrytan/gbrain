import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { MAX_TURN_TEXT_CHARS } from '../facts/extract.ts';
import type { runFactsPipeline } from '../facts/backstop.ts';

/** Independent of .ingested: session-end invalidates completion on resume. */
export const CORPUS_PROGRESS_SUFFIX = '.progress';
type Result = Awaited<ReturnType<typeof runFactsPipeline>>;
interface Progress {
  source_id: string;
  offset: number;
  prefix_hash: string;
  inserted: number;
  duplicate: number;
  entity_slugs: string[];
  skipped_reason?: Result['skipped_reason'];
}
export const corpusContentHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** New completion markers bind to a snapshot; old terminal markers still work. */
export async function corpusIsIngested(full: string): Promise<boolean> {
  let marker: string;
  try { marker = await readFile(full + '.ingested', 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let saved: { content_hash?: string } | null;
  try { saved = JSON.parse(marker); } catch { return true; } // legacy marker
  if (typeof saved?.content_hash !== 'string') return true;
  return saved.content_hash === corpusContentHash(await readFile(full, 'utf8'));
}

/** Prefer a line boundary, but always advance and never split a surrogate pair. */
function windowEnd(raw: string, start: number): number {
  let end = Math.min(raw.length, start + MAX_TURN_TEXT_CHARS);
  if (end < raw.length) {
    const newline = raw.lastIndexOf('\n', end - 1);
    if (newline >= start + MAX_TURN_TEXT_CHARS / 2) end = newline + 1;
    else if (/^[\uDC00-\uDFFF]$/.test(raw[end]) && /^[\uD800-\uDBFF]$/.test(raw[end - 1])) end--;
  }
  return end;
}

/** Called under the corpus claim. Commit progress only after a complete window. */
export async function extractCorpusWindows(
  full: string,
  raw: string,
  sourceId: string,
  extract: (text: string) => Promise<Result>,
  overBudget: () => boolean,
  signal: AbortSignal,
): Promise<Result | null> {
  const path = full + CORPUS_PROGRESS_SUFFIX;
  let progress: Progress = { source_id: sourceId, offset: 0, prefix_hash: corpusContentHash(''), inserted: 0, duplicate: 0, entity_slugs: [] };
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as Progress;
    if (saved && saved.source_id === sourceId && Number.isSafeInteger(saved.offset) && saved.offset >= 0 && saved.offset <= raw.length
      && saved.prefix_hash === corpusContentHash(raw.slice(0, saved.offset))
      && Number.isSafeInteger(saved.inserted) && saved.inserted >= 0
      && Number.isSafeInteger(saved.duplicate) && saved.duplicate >= 0
      && Array.isArray(saved.entity_slugs) && saved.entity_slugs.every(slug => typeof slug === 'string')) progress = saved;
  } catch (error) {
    // Missing/corrupt progress is safe to replay; actual I/O failures must not
    // silently reset a checkpoint and repeatedly pay for completed windows.
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const result: Result = { inserted: progress.inserted, duplicate: progress.duplicate, superseded: 0, fact_ids: [], entity_slugs: [...progress.entity_slugs], ...(progress.skipped_reason ? { skipped_reason: progress.skipped_reason } : {}) };
  while (progress.offset < raw.length) {
    if (overBudget() || signal.aborted) return null;
    const end = windowEnd(raw, progress.offset);
    const r = await extract(raw.slice(progress.offset, end));
    if (signal.aborted) return null; // partial pipeline results are not a checkpoint
    result.inserted += r.inserted;
    result.duplicate += r.duplicate;
    result.superseded += r.superseded;
    result.fact_ids.push(...r.fact_ids);
    result.entity_slugs.push(...r.entity_slugs);
    if (r.skipped_reason) {
      result.skipped_reason = r.skipped_reason;
      // A terminal non-transport skip retires this window, not the unread tail.
    }
    result.entity_slugs = [...new Set(result.entity_slugs)];
    progress = { source_id: sourceId, offset: end, prefix_hash: corpusContentHash(raw.slice(0, end)), inserted: result.inserted, duplicate: result.duplicate, entity_slugs: result.entity_slugs, ...(result.skipped_reason ? { skipped_reason: result.skipped_reason } : {}) };
    const tmp = `${path}.tmp-${process.pid}`;
    try {
      await writeFile(tmp, JSON.stringify(progress) + '\n', { mode: 0o600 });
      await rename(tmp, path);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  return result;
}
