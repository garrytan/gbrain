// src/core/office/table.ts
//
// Table handling for office ingest (docs/proposals/office-ingest.md §11).
// Per table block we emit:
//   - a one-line SUMMARY chunk (召回) — LLM-generated when a chat provider +
//     model are configured, else a deterministic template. Never throws.
//   - a ROW chunk carrying the markdown table (精确).
// Conditional Facts extraction is a later task; low-confidence tables (carried
// in DocIR.warnings) should be excluded from Facts by the caller.

import { chat as gatewayChat, isAvailable } from '../ai/gateway.ts';
import type { DocBlock, OfficeChunk } from './types.ts';
import type { OfficeConfig } from './config.ts';

/** Build summary + row chunks for one table block. */
export async function tableChunksFor(block: DocBlock, cfg: OfficeConfig): Promise<OfficeChunk[]> {
  const out: OfficeChunk[] = [];
  const summary = (await llmSummary(block, cfg)) ?? templateSummary(block);
  out.push({ chunk_text: summary, chunk_source: 'table_summary', source_locator: block.locator });
  if (block.markdown.trim().length > 0) {
    out.push({ chunk_text: block.markdown, chunk_source: 'table_rows', source_locator: block.locator });
  }
  return out;
}

function locHint(block: DocBlock): string {
  const l = block.locator;
  if (l.page != null) return ` on page ${l.page}`;
  if (l.slide != null) return ` on slide ${l.slide}`;
  if (l.sheet) return ` in sheet "${l.sheet}"`;
  return '';
}

/** Deterministic, zero-cost summary. Always available — the fallback path. */
export function templateSummary(block: DocBlock): string {
  const t = block.table;
  const cols = t?.columns?.length ? `; columns: ${t.columns.join(', ')}` : '';
  return `Table${locHint(block)}: ${t?.n_rows ?? 0} rows × ${t?.n_cols ?? 0} columns${cols}.`;
}

/** LLM summary. Returns null (→ template fallback) when disabled, no model
 *  configured, no chat provider available, or on any error. */
async function llmSummary(block: DocBlock, cfg: OfficeConfig): Promise<string | null> {
  if (!cfg.tableSummaryEnabled || !cfg.tableSummaryModel) return null;
  const t = block.table;
  if (!t) return null;
  if (!isAvailable('chat', cfg.tableSummaryModel)) return null;
  try {
    const sample = (t.rows ?? []).slice(0, 6).map((r) => r.join(' | ')).join('\n');
    const res = await gatewayChat({
      model: cfg.tableSummaryModel,
      system:
        'Summarize a data table in ONE sentence for search retrieval: what it is about, ' +
        'its columns, and the range of key values. No preamble, no markdown.',
      messages: [{ role: 'user', content: `Columns: ${t.columns.join(', ')}\nSample rows:\n${sample}` }],
      maxTokens: 120,
    });
    const text = (res.text ?? '').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null; // any failure → caller falls back to the template (import never fails)
  }
}
