import type { BrainEngine } from '../engine.ts';
import type { ParsedMarkdown } from '../markdown.ts';
import { OperationError } from '../ops/contract.ts';
import { prepareCanonicalProjections } from '../persistence/canonical-projections.ts';
import { extractFactsFromFenceText } from '../facts/extract-from-fence.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { parseTakesFence } from '../takes-fence.ts';
import { takesPreparation } from '../takes-write.ts';
import { buildTakeRows } from '../batch-rows.ts';
import { deriveResolutionTuple } from '../takes-resolution.ts';

type Row = Record<string, unknown>;

function timestamp(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) return value;
  return new Date(value as string | number | Date).toISOString().replace(/(\.\d{3})Z$/, '$1000Z');
}

function differences(stored: Row, expected: Row): string[] {
  return Object.keys(expected).filter(key => {
    const before = stored[key] ?? null, after = expected[key] ?? null;
    if (key.endsWith('_at') || key === 'valid_from' || key === 'valid_until') return timestamp(before) !== timestamp(after);
    if (key === 'confidence' || key === 'weight') return Math.fround(Number(before)) !== Math.fround(Number(after));
    return before !== after;
  });
}

export async function assertExportProjectionRoundtrip(engine: BrainEngine, page: ParsedMarkdown, pageId: number, sourceId: string): Promise<void> {
  prepareCanonicalProjections(page, page.slug, sourceId);
  const fields = [page.compiled_truth, page.timeline];
  const facts = extractFactsFromFenceText(fields.flatMap(field => parseFactsFence(field).facts), page.slug, sourceId);
  const takes = fields.flatMap(field => parseTakesFence(field).takes);
  const storedFacts = await engine.executeRaw<Row>(`SELECT *,
    to_char(valid_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from,
    to_char(valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_until,
    to_char(expired_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expired_at
    FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND (row_num IS NOT NULL OR expired_at IS NULL)`, [sourceId, page.slug]);
  const storedTakes = await engine.executeRaw<Row>(`SELECT *,
    to_char(resolved_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS resolved_at
    FROM takes WHERE page_id=$1`, [pageId]);
  const conflicts: string[] = [];
  for (const stored of storedFacts) {
    const fact = facts.find(row => row.row_num === stored.row_num);
    if (!fact) { conflicts.push(`facts row ${stored.row_num ?? 'unfenced'}: missing canonical row`); continue; }
    const target = fact.superseded_by_row === undefined ? undefined : storedFacts.find(row => row.row_num === fact.superseded_by_row && row.expired_at == null && row.row_num !== fact.row_num);
    const expected: Row = {
      source_id: sourceId, entity_slug: fact.entity_slug, source_markdown_slug: page.slug,
      row_num: fact.row_num, fact: fact.fact, kind: fact.kind, visibility: fact.visibility,
      notability: fact.notability, context: fact.context, source: fact.source, confidence: fact.confidence,
      valid_from: fact.valid_from ?? stored.valid_from, valid_until: fact.valid_until, expired_at: fact.expired_at,
      claim_metric: fact.claim_metric, claim_value: fact.claim_value, claim_unit: fact.claim_unit, claim_period: fact.claim_period,
      superseded_by: target?.id ?? null,
    };
    const changed = differences(stored, expected);
    if (changed.length) conflicts.push(`facts row ${fact.row_num}: ${changed.join(', ')}`);
  }
  for (const fact of facts) if (!storedFacts.some(row => row.row_num === fact.row_num)) conflicts.push(`facts row ${fact.row_num}: would insert a missing database row`);
  const normalized = buildTakeRows(takes.map(take => takesPreparation.toBatchInput(pageId, take,
    take.active ? null : Number(take.source?.match(/superseded by #(\d+)/)?.[1]) || null))).rows;
  for (const stored of storedTakes) {
    const take = takes.find(row => row.rowNum === stored.row_num), base = normalized.find(row => row.row_num === stored.row_num);
    if (!take || !base) { conflicts.push(`takes row ${stored.row_num}: missing canonical row`); continue; }
    let resolution: ReturnType<typeof deriveResolutionTuple> | null = null;
    if (take.resolvedQuality !== undefined) {
      if (!take.resolvedBy) throw new OperationError('unsupported_export_data', `Canonical takes row ${take.rowNum} has a resolution without resolved_by. Restore the recorded resolver in the fence before export; no identity was inferred.`);
      resolution = deriveResolutionTuple({ quality: take.resolvedQuality, resolvedBy: take.resolvedBy });
    }
    const expected: Row = { ...base, resolved_at: take.resolvedAt ?? null, resolved_quality: resolution?.quality ?? null,
      resolved_outcome: resolution?.outcome ?? null,
      resolved_source: take.resolvedEvidence ?? null, resolved_value: take.resolvedValue ?? null,
      resolved_unit: take.resolvedUnit ?? null, resolved_by: take.resolvedBy ?? null };
    const changed = differences(stored, expected);
    if (changed.length) conflicts.push(`takes row ${take.rowNum}: ${changed.join(', ')}`);
  }
  for (const take of takes) if (!storedTakes.some(row => row.row_num === take.rowNum)) conflicts.push(`takes row ${take.rowNum}: would insert a missing database row`);
  if (conflicts.length) throw new OperationError('unsupported_export_data', `Canonical projection would change database fields (${conflicts.slice(0, 20).join('; ')}${conflicts.length > 20 ? '; additional rows differ' : ''}). Reconcile the source fences before export; no rows or files were changed.`);
}
