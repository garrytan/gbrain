import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';

export const PROJECTION_OVERRIDE_SETTING = 'gbrain.current_projections_only_override';

/** Queue reasons that can arise from a current canonical write. Unknown reasons are historical. */
export function currentProjectionReasonSql(reason: string): string {
  return `(${reason} IN ('canonical_change','canonical_change_rebuild_failed','chunk_replacement_deferred')
    OR split_part(${reason},':',1) IN ('segmented_projecting','chunk_replacement_continuing'))`;
}
export const CURRENT_PROJECTION_JOB_SQL = currentProjectionReasonSql('j.reason');
export const PROJECTION_POLICY_ADMITS_SQL = `(COALESCE((SELECT value='true' FROM config WHERE key='embed.current_projections_only'),false) IS NOT TRUE
  OR COALESCE(current_setting('${PROJECTION_OVERRIDE_SETTING}',true),'')='false' OR ${CURRENT_PROJECTION_JOB_SQL})`;

/** Over pages p and an optional queue row j. Missing proof is held. */
export const HISTORICAL_PROJECTION_HELD_SQL = `(CASE WHEN j.reason IS NOT NULL THEN NOT ${CURRENT_PROJECTION_JOB_SQL}
  ELSE COALESCE(p.chunker_version,0) < ${SAFE_FENCE_CHUNKER_VERSION}
    OR p.text_projection_revision IS DISTINCT FROM p.knowledge_revision END)`;
