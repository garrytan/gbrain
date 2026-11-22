/**
 * The credential re-chunk hold's identity (GBRA-130 A-27): its `op_checkpoints.op`, the producer a hold names and the
 * SQL predicate of a held page. A leaf, so the repair page scans (engine-sql/repair-page-scans.ts) read it without
 * loading the re-chunk itself (credential-reseal.ts).
 */
import { MARKDOWN_CHUNKER_VERSION } from '../chunkers/recursive.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';

export const CREDENTIAL_RESEAL_HOLD_OP = 'credential-reseal-hold';
/** The chunker a hold was recorded under; a hold of another producer no longer applies. */
export const CREDENTIAL_RESEAL_PRODUCER = `chunker-v${MARKDOWN_CHUNKER_VERSION}.fence-v${SAFE_FENCE_CHUNKER_VERSION}`;

/** SQL predicate over `pages p`: the page has a live credential re-chunk hold (`gbrain repair safe-chunks` retries it). */
export const CREDENTIAL_RESEAL_HELD = `(p.text_projection_revision IS DISTINCT FROM p.knowledge_revision AND EXISTS (SELECT 1 FROM op_checkpoints h
  WHERE h.op='${CREDENTIAL_RESEAL_HOLD_OP}' AND h.fingerprint = p.id::text AND p.knowledge_revision::text = h.completed_keys->0->>'revision'
  AND h.completed_keys->0->>'producer' = '${CREDENTIAL_RESEAL_PRODUCER}'))`;
