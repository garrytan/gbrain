import type {PhaseResult} from '../../core/cycle.ts';
import {captureReportLine,type CaptureStopReason} from '../../core/cycle/entity-capture-budget.ts';

export function mergeCaptureWindow(previous:PhaseResult|undefined,current:PhaseResult):PhaseResult{
  if(!previous)return current;
  const before=previous.details,details={...current.details};
  for(const key of ['input_tokens','output_tokens','pages_submitted','pages_processed','chunks_submitted','chunks_processed','pages_failed','chunks_failed','entities_written','relations_created','relations_removed','direct_links_created','mention_links_created','ner_links_created','extract_links_created']){
    details[key]=Number(before[key]??0)+Number(details[key]??0);
  }
  for(const key of ['written_slugs','source_slugs','relation_slugs'])details[key]=[...new Set([...(before[key] as string[]??[]),...(details[key] as string[]??[])])];
  for(const key of ['unresolved_references','page_failures'])details[key]=[...new Map([...(before[key] as unknown[]??[]),...(details[key] as unknown[]??[])].map(value=>[JSON.stringify(value),value])).values()];
  details.cost_cny=before.cost_cny==null||details.cost_cny==null?null:Number((Number(before.cost_cny)+Number(details.cost_cny)).toFixed(6));
  details.cost_cap_cny=before.cost_cap_cny??details.cost_cap_cny;
  const line=captureReportLine({model:details.model_id as string,pagesProcessed:Number(details.pages_processed),pagesRemaining:Number(details.pages_remaining??0),entitiesCreated:Number(details.entities_written),relationsCreated:Number(details.relations_created),costCny:details.cost_cny as number|null,costCapCny:details.cost_cap_cny as number|null,ollama:details.ollama===true,stopReason:details.stop_reason as CaptureStopReason});
  const priorLine=String(details.report_line??'');details.report_line=line;
  return {...current,duration_ms:previous.duration_ms+current.duration_ms,details,status:current.status==='ok'&&(details.unresolved_references as unknown[]).length?'warn':current.status,summary:priorLine?current.summary.replace(priorLine,line):line};
}
