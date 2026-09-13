/**
 * emit.ts — JSONL emission for the LongMemEval harness: the per-row emitter
 * (stdout or file; truncate or append) and the resume-safe `by_type_summary`
 * writer. Peeled from src/commands/eval-longmemeval.ts.
 *
 * INVARIANT: the summary is the FINAL line of the output and there is at most
 * one — any prior `kind:"by_type_summary"` line is removed before the new one
 * is appended, so a resume never stacks summaries. Its `_meta.metric_glossary`
 * is the ONE glossary block per response ([CDX-25]) and names exactly the
 * metrics the summary carries (recall_all@k, recall_any@k, and qa_accuracy
 * when the judged lane ran).
 *
 * INVARIANT: a CR inside an emitted line is corrupt input, never a silent
 * line break — both writers throw instead of splitting a JSONL record.
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { buildMetricGlossaryMeta } from '../../core/eval/metric-glossary.ts';
import type { ByTypeSummaryV2 } from './metrics.ts';

export interface JsonlEmitter {
  emit(obj: object): void;
  close(): void;
}

/**
 * `outputPath` undefined → stdout (stays open). Append mode is used by
 * --resume-from when the output path IS the resume file (truncating would
 * erase the already-answered, paid rows): every new / judged / retried row is
 * appended as it lands and the file is compacted to one row per question_id
 * at run end (`compactJsonlByQuestionId`). A resume into a DIFFERENT output
 * path is a fresh file, so truncate mode is safe there.
 */
export function makeEmitter(outputPath?: string, append: boolean = false): JsonlEmitter {
  if (!outputPath) {
    return {
      emit(obj) {
        const json = JSON.stringify(obj);
        if (json.includes('\r')) throw new Error('CRLF in JSONL emit (corrupt input)');
        process.stdout.write(Buffer.from(json + '\n', 'utf8'));
      },
      close() { /* stdout stays open */ },
    };
  }
  const fd = openSync(outputPath, append ? 'a' : 'w');
  let closed = false;
  return {
    emit(obj) {
      const json = JSON.stringify(obj);
      if (json.includes('\r')) throw new Error('CRLF in JSONL emit (corrupt input)');
      writeSync(fd, Buffer.from(json + '\n', 'utf8'));
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}

/**
 * Compact an appended resume file to ONE row per question_id (the LAST
 * occurrence wins — a judged backfill row or a retry supersedes the row it
 * duplicates), dropping summary lines (the caller re-emits the summary).
 * Order is the first-seen order of question ids. Written atomically
 * (`<path>.compact.tmp` + rename) so a kill mid-compaction leaves the
 * appended file intact. Returns the row counts for the run log.
 */
export function compactJsonlByQuestionId(outputPath: string): { rows: number; superseded: number; summaries_dropped: number } {
  if (!existsSync(outputPath)) return { rows: 0, superseded: 0, summaries_dropped: 0 };
  const order: string[] = [];
  const latest = new Map<string, string>();
  let superseded = 0;
  let summaries = 0;
  const passthrough: string[] = [];
  for (const line of readFileSync(outputPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: { question_id?: unknown; kind?: unknown } | null = null;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // corrupt tail (SIGKILL) — dropped, the resume loader never trusted it either
    }
    if (row && typeof row === 'object' && row.kind === 'by_type_summary') { summaries++; continue; }
    if (row && typeof row === 'object' && typeof row.question_id === 'string') {
      if (latest.has(row.question_id)) superseded++;
      else order.push(row.question_id);
      latest.set(row.question_id, line);
      continue;
    }
    passthrough.push(line);
  }
  const out = [...passthrough, ...order.map((id) => latest.get(id)!)];
  const tmp = `${outputPath}.compact.tmp`;
  writeFileSync(tmp, out.length > 0 ? out.join('\n') + '\n' : '', 'utf8');
  renameSync(tmp, outputPath);
  return { rows: order.length, superseded, summaries_dropped: summaries };
}

/**
 * Emit the by_type_summary as the final line (replacing any prior summary
 * line) with its glossary block. The file rewrite is atomic
 * (`<path>.summary.tmp` + rename, like `compactJsonlByQuestionId`): a kill
 * mid-write leaves the paid rows intact instead of a truncated file.
 */
export function emitByTypeSummary(outputPath: string | undefined, summary: ByTypeSummaryV2): void {
  const keys = [`recall_all@${summary.k}`, `recall_any@${summary.k}`, ...(summary.qa_accuracy ? ['qa_accuracy'] : [])];
  const withMeta = { ...summary, _meta: { metric_glossary: buildMetricGlossaryMeta(keys) } };
  const json = JSON.stringify(withMeta);
  if (json.includes('\r')) throw new Error('CRLF in by_type_summary emit (corrupt input)');
  if (!outputPath) {
    process.stdout.write(Buffer.from(json + '\n', 'utf8'));
    return;
  }
  let existing = '';
  if (existsSync(outputPath)) existing = readFileSync(outputPath, 'utf8');
  const kept: string[] = [];
  for (const line of existing.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && (row as { kind?: unknown }).kind === 'by_type_summary') continue;
    } catch {
      // Corrupt line — keep as-is; the resume loader has its own skip logic.
    }
    kept.push(line);
  }
  kept.push(json);
  const tmp = `${outputPath}.summary.tmp`;
  writeFileSync(tmp, kept.join('\n') + '\n', 'utf8');
  renameSync(tmp, outputPath);
}
