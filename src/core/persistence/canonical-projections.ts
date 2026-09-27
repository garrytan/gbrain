import type { BrainEngine } from '../engine.ts';
import type { ParsedPage } from '../import-file.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence } from '../takes-fence.ts';
import { extractFactsFromFenceText } from '../facts/extract-from-fence.ts';
import { takesPreparation } from '../takes-write.ts';
import { parseTimelineEntries } from '../link-extraction.ts';
import { extractTimelineFromContent } from '../timeline-extract.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { OperationError } from '../ops/contract.ts';

/** Compile synchronous, provider-free projections before entering publication. */
export function prepareCanonicalProjections(page: ParsedPage, slug: string, sourceId: string): (tx: BrainEngine) => Promise<void> {
  const fields=[page.compiled_truth,page.timeline ?? ''];
  for(const field of fields) for(const marker of [FACTS_FENCE_BEGIN,FACTS_FENCE_END,TAKES_FENCE_BEGIN,TAKES_FENCE_END]) {
    if(field.split(marker).length>2) throw new OperationError('invalid_params','Each canonical body section must contain at most one facts fence and one takes fence.');
  }
  const factSets=fields.map(parseFactsFence),takeSets=fields.map(parseTakesFence);
  if ([...factSets,...takeSets].some(set=>set.warnings.length)) throw new OperationError('invalid_params','A canonical facts or takes fence cannot be parsed losslessly.');
  const facts=factSets.flatMap(set=>set.facts),takes=takeSets.flatMap(set=>set.takes);
  for(const rows of [facts,takes]) if(new Set(rows.map(row=>row.rowNum)).size!==rows.length) {
    throw new OperationError('invalid_params','Canonical row numbers must be unique across the entire page.');
  }
  const body=fields.join('\n');
  const factRows=extractFactsFromFenceText(facts,slug,sourceId);
  const safe=sanitizeRemoteBody(body);
  const timeline=new Map(extractTimelineFromContent(safe,slug).map(t=>[JSON.stringify([t.date,t.source,t.summary]),t]));
  for (const t of parseTimelineEntries(safe)) timeline.set(JSON.stringify([t.date,t.source??'markdown',t.summary]),{...t,source:t.source??'markdown',slug});
  return async tx=>{
    const snapshot=await tx.readPageSnapshot(slug,{sourceId});
    if (!snapshot) return;
    // Fact IDs in permanent receipts remain meaningful when a canonical row is
    // removed/replaced. Expire and detach its row position instead of deleting it.
    const incoming=JSON.stringify(factRows.map(f=>({row_num:f.row_num,fact:f.fact,visibility:f.visibility})));
    await tx.executeRaw(`UPDATE facts f SET expired_at=COALESCE(expired_at,now()),row_num=NULL
      WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($3::text::jsonb) AS n(row_num integer,fact text,visibility text)
        WHERE n.row_num=f.row_num AND n.fact=f.fact AND n.visibility=f.visibility)`,[sourceId,slug,incoming]);
    if (factRows.length) {
      await tx.insertFacts(factRows,{source_id:sourceId}); // gbrain-allow-direct-insert: canonical fence projection shares the journal publication transaction
      for (const fact of factRows) await tx.executeRaw(`UPDATE facts SET kind=$4,notability=$5,context=$6,
        valid_from=COALESCE($7::timestamptz,valid_from),valid_until=$8::timestamptz,expired_at=$9::timestamptz,
        source=$10,confidence=$11,claim_metric=$12,claim_value=$13,claim_unit=$14,claim_period=$15
        WHERE source_id=$1 AND source_markdown_slug=$2 AND row_num=$3`,
      [sourceId,slug,fact.row_num,fact.kind,fact.notability,fact.context,fact.valid_from?.toISOString()??null,
        fact.valid_until?.toISOString()??null,fact.expired_at?.toISOString()??null,fact.source,fact.confidence,
        fact.claim_metric??null,fact.claim_value??null,fact.claim_unit??null,fact.claim_period??null]);
    }
    const pageId=snapshot.page.id;
    await tx.executeRaw('DELETE FROM takes WHERE page_id=$1 AND NOT(row_num=ANY($2::integer[]))',[pageId,takes.map(t=>t.rowNum)]);
    if (takes.length) await tx.addTakesBatch(takes.map(t=>takesPreparation.toBatchInput(pageId,t,
      t.active?null:Number(t.source?.match(/superseded by #(\d+)/)?.[1])||null)));
    // Full canonical versions include resolution fields; a revert restores those
    // fields from Markdown too, without the ordinary immutable-resolution API.
    for (const take of takes) await tx.executeRaw(`UPDATE takes SET resolved_at=$3::timestamptz,
      resolved_quality=$4,resolved_outcome=$5,resolved_source=$6,resolved_value=$7,resolved_unit=$8,resolved_by=$9
      WHERE page_id=$1 AND row_num=$2`,[pageId,take.rowNum,take.resolvedAt??null,take.resolvedQuality??null,
        take.resolvedQuality==='correct'?true:take.resolvedQuality==='incorrect'?false:null,
        take.resolvedEvidence??null,take.resolvedValue??null,take.resolvedUnit??null,take.resolvedBy??null]);
    // Event-page references have a different canonical origin and remain intact.
    const tuples=[...timeline.values()];
    await tx.executeRaw(`DELETE FROM timeline_entries t WHERE page_id=$1 AND event_page_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) AS n(date date,source text,summary text)
        WHERE n.date=t.date AND n.source=t.source AND n.summary=t.summary)`,[pageId,JSON.stringify(tuples)]);
    for (const entry of tuples) {
      await tx.addTimelineEntry(slug,entry,{sourceId});
      await tx.executeRaw(`UPDATE timeline_entries SET detail=$5 WHERE page_id=$1 AND date=$2::date
        AND source=$3 AND summary=$4 AND event_page_id IS NULL`,[pageId,entry.date,entry.source,entry.summary,entry.detail??'']);
    }
  };
}
