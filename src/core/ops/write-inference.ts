/**
 * Write-inference classes: what model work a write may do and when.
 *
 * The contract every write path keeps: saving text or a fact never waits on a
 * generative model. A write is acknowledged and keyword-queryable without one.
 * Embeddings are the configured feature. Generative work a write triggers runs
 * after the save, attributed and switchable. Opt-in media preprocessing (image
 * OCR) is the one exception that runs before the save, and only when enabled.
 *
 * Resolution order for an operation: its inline `writeInference` field, then
 * this map, then `'none'` (the strictest promise), so an operation added
 * without a class is held to the zero-model rule rather than exempted.
 * `test/write-path-zero-llm.serial.test.ts` checks the promise at runtime.
 */
import type { Operation } from './contract.ts';

export type WriteInference =
  /** No model call of any kind before the write commits (post-commit embedding effects are fine). */
  | 'none'
  /** May embed before commit (e.g. `remember` dedup); never calls a generative model. */
  | 'embedding'
  /** `none`/`embedding` before commit; may queue generative work that runs after commit (facts extraction). */
  | 'async_derived'
  /** May call a generative model before commit only when a user opt-in is on (image OCR). */
  | 'opt_in_media'
  /** The operation is itself an explicit model call (think, extract_facts, submit_agent, …). */
  | 'explicit_llm'
  /** Administrative state (jobs, sources, skills, notices); writes no memory content. */
  | 'non_content';

export const WRITE_INFERENCE_CLASSES: readonly WriteInference[] = [
  'none', 'embedding', 'async_derived', 'opt_in_media', 'explicit_llm', 'non_content',
];

/** Classes that promise no generative model call before the write commits. */
export const ZERO_GENERATIVE_BEFORE_COMMIT: ReadonlySet<WriteInference> = new Set<WriteInference>([
  'none', 'embedding', 'async_derived',
]);

export const OP_WRITE_INFERENCE: Readonly<Record<string, WriteInference>> = {
  // memory verbs and facts
  remember: 'embedding', forget: 'none', forget_fact: 'none', extract_facts: 'explicit_llm',
  // pages
  put_page: 'async_derived', put_pages: 'async_derived', capture: 'async_derived', edit_page: 'async_derived',
  revert_version: 'async_derived', delete_page: 'none', restore_page: 'none',
  purge_deleted_pages: 'none', cancel_write_request: 'none',
  put_raw_data: 'none', log_ingest: 'none', file_upload: 'opt_in_media',
  // graph, tags, timeline, takes
  add_tag: 'none', remove_tag: 'none', add_link: 'none', remove_link: 'none',
  add_timeline_entry: 'none', takes_add: 'none', takes_update: 'none',
  takes_resolve: 'none', takes_supersede: 'none', ontology_propose: 'none',
  // entities and loops
  extract_entities: 'embedding', extraction_review: 'none',
  entity_identity_link: 'none', entity_identity_unlink: 'none',
  loops_close: 'none', loops_mute: 'none', loops_unmute: 'none',
  // sync and connectors
  sync_brain: 'async_derived', connector_sync: 'async_derived',
  // explicit model work
  think: 'explicit_llm', submit_agent: 'explicit_llm', run_skillopt: 'explicit_llm',
  run_onboard: 'explicit_llm', chronicle_backfill: 'explicit_llm',
  // administrative state
  put_skill: 'non_content', delete_skill: 'non_content', set_skill_policy: 'non_content',
  prune_skill_revisions: 'non_content', retain_skill_revision: 'non_content',
  import_skill_proposal: 'non_content', join_brain: 'non_content',
  sync_brain_skills: 'non_content', leave_brain: 'non_content',
  submit_job: 'non_content', cancel_job: 'non_content', retry_job: 'non_content',
  pause_job: 'non_content', resume_job: 'non_content', replay_job: 'non_content',
  send_job_message: 'non_content', sources_add: 'non_content', sources_remove: 'non_content',
  request_tools: 'non_content', code_traversal_cache_clear: 'non_content',
  migrate_embeddings: 'non_content', schema_apply_mutations: 'non_content',
  mute_notice: 'non_content',
};

/** CLI writers that are not operations, with the class they keep. */
export const CLI_WRITE_INFERENCE: Readonly<Record<string, WriteInference>> = {
  import: 'embedding',
  sync: 'async_derived',
  'transcripts ingest': 'async_derived',
  'connectors sync': 'async_derived',
  'hook ipc banking': 'none',
  // P1: accept/undo/date append or remove a timeline line and re-derive links; reject records a verdict.
  'edge-proposals': 'none',
  // Core memory: mark or unmark a page as always loaded through put_page as the local owner.
  'core add': 'async_derived',
  'core remove': 'async_derived',
};

export function writeInferenceOf(op: Pick<Operation, 'name' | 'writeInference'>): WriteInference {
  return op.writeInference ?? OP_WRITE_INFERENCE[op.name] ?? 'none';
}
