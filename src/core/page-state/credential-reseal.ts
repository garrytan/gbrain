/**
 * Credential-safe re-chunk of existing pages (security wave ENG-2). Schema
 * migration v189 unseals every live markdown/code page whose canonical body
 * carries a private-key marker, which withholds its old chunks from every
 * retrieval path. This module counts those pages and re-seals them from their
 * unchanged canonical body through the projection installer: no page write,
 * no journal admission and no provider call. Vectors of chunks whose text is
 * unchanged are kept; re-chunked key chunks wait for `gbrain embed --stale`.
 *
 * A page whose re-chunk fails item-scoped is held under op_checkpoints
 * `credential-reseal-hold` (page id, revision, chunker generation, error code,
 * consecutive attempts): its chunks stay withheld, doctor
 * text_projection_readiness lists it, and `gbrain repair safe-chunks --source
 * <id> --apply` retries it. A hold never blocks a retry and stops applying when
 * the page changes, seals or the chunker generation moves.
 */
import type { BrainEngine } from '../engine.ts';
import { resealSafeChunks } from './projections.ts';
import { buildSegmentedProjection } from '../page-body/projection.ts';
import { PageRevisionConflictError } from './types.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../chunkers/recursive.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../search/safe-chunks.ts';
import type { Action } from '../agent-output.ts';
import { ItemRun } from '../item-failure.ts';
import { redactConnectionInfo } from '../audit/redact-connection-info.ts';

const KEY_MARKER = `'-----(BEGIN|END) [A-Z ]*PRIVATE KEY-----'`;
const REBUILDABLE = `(p.page_kind='markdown' OR (p.page_kind='code' AND COALESCE(p.frontmatter->>'file',p.source_path) IS NOT NULL))`;
/** Wave B: a segmented page's private keys are its live manifest rows' `pem` regions (its body columns are NULL). */
const SEGMENTED_KEYS = `EXISTS (SELECT 1 FROM page_body_manifest m WHERE m.page_id=p.id AND m.gen_to IS NULL AND m.staging_id IS NULL
    AND m.protected_regions @> '[{"kind":"pem"}]'::jsonb)`;
const PENDING = `p.deleted_at IS NULL AND p.page_kind IN ('markdown','code')
  AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
  AND (p.compiled_truth ~ ${KEY_MARKER} OR COALESCE(p.timeline,'') ~ ${KEY_MARKER} OR (p.body_storage='segmented' AND ${SEGMENTED_KEYS}))`;

export interface CredentialPending { rebuildable: number; kept: number }

/** Pending pages in active sources; `kept` cannot be rebuilt here (code without a recorded source path). */
export async function credentialProjectionPending(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds?: string[]): Promise<CredentialPending> {
  const [row] = await engine.executeRaw<{ rebuildable: number; kept: number }>(`SELECT
      COUNT(*) FILTER (WHERE ${REBUILDABLE})::int AS rebuildable,
      COUNT(*) FILTER (WHERE NOT ${REBUILDABLE})::int AS kept
    FROM pages p JOIN sources s ON s.id=p.source_id AND s.archived IS NOT TRUE
    WHERE ${PENDING} ${sourceIds ? 'AND p.source_id=ANY($1::text[])' : ''}`, sourceIds ? [sourceIds] : []);
  return { rebuildable: Number(row?.rebuildable ?? 0), kept: Number(row?.kept ?? 0) };
}

/** GBRA-130 A-27: one page whose re-chunk failed item-scoped, recorded under op_checkpoints `credential-reseal-hold` keyed by page id. */
export interface CredentialResealHold {
  page_id: number; source_id: string; slug: string;
  /** The page's knowledge_revision when it failed: a new revision is a new item and the hold no longer applies. */
  revision: string;
  /** The chunker generation that failed it: a chunker change retries every page. */
  producer: string;
  code: string; message: string;
  /** Consecutive failing runs at this revision, producer and code. */
  attempts: number;
  at: string;
}

const HOLD_OP = 'credential-reseal-hold';
const PRODUCER = `chunker-v${MARKDOWN_CHUNKER_VERSION}.fence-v${SAFE_FENCE_CHUNKER_VERSION}`;
/** A hold applies while its page is live, still at the held revision and producer, and still unsealed. */
const LIVE_HOLD = `p.deleted_at IS NULL AND p.knowledge_revision::text = h.completed_keys->0->>'revision'
  AND h.completed_keys->0->>'producer' = '${PRODUCER}' AND p.text_projection_revision IS DISTINCT FROM p.knowledge_revision`;
const HOLD_PAGES = `op_checkpoints h JOIN pages p ON p.id = (h.completed_keys->0->>'page_id')::int`;

/** SQL predicate over `pages p`: the page has a live credential re-chunk hold (`gbrain repair safe-chunks` retries it). */
export const CREDENTIAL_RESEAL_HELD = `(p.text_projection_revision IS DISTINCT FROM p.knowledge_revision AND EXISTS (SELECT 1 FROM op_checkpoints h
  WHERE h.op='${HOLD_OP}' AND h.fingerprint = p.id::text AND p.knowledge_revision::text = h.completed_keys->0->>'revision'
  AND h.completed_keys->0->>'producer' = '${PRODUCER}'))`;

/** The command that retries a held page: `gbrain repair safe-chunks` for its source (a segmented page is rebuilt by the projection drain). */
function holdFix(hold: Pick<CredentialResealHold, 'source_id'>, segmented: boolean): Action {
  return segmented
    ? { argv: ['gbrain', 'projections', 'drain'], preview_argv: ['gbrain', 'projections', 'drain', '--dry-run', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Rebuilds the segmented page\'s projection from its stored regions and seals it; no provider call.' }
    : { argv: ['gbrain', 'repair', 'safe-chunks', '--source', hold.source_id, '--apply'], preview_argv: ['gbrain', 'repair', 'safe-chunks', '--source', hold.source_id],
      consent: [], actor: 'agent', requires_exclusive: false, why: 'Re-chunks the held page from its unchanged body without provider calls; its key chunks stay withheld until it seals.' };
}

/** Live holds (optionally for some sources), oldest page first, each with the command that retries it. */
export async function readCredentialResealHolds(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds?: string[]): Promise<Array<CredentialResealHold & { fix: Action }>> {
  const rows = await engine.executeRaw<{ hold: CredentialResealHold; segmented: boolean }>(`SELECT h.completed_keys->0 AS hold, p.body_storage IS NOT DISTINCT FROM 'segmented' AS segmented
    FROM ${HOLD_PAGES} WHERE h.op='${HOLD_OP}' AND ${LIVE_HOLD} ${sourceIds ? 'AND p.source_id=ANY($1::text[])' : ''} ORDER BY p.id`, sourceIds ? [sourceIds] : []);
  return rows.map(row => ({ ...row.hold, fix: holdFix(row.hold, row.segmented === true) }));
}

/**
 * Records this run's failed pages (attempts count consecutive runs at the same revision, producer and code) and drops
 * every hold that no longer applies. Called only for a run that finished: a run-scoped or systemic stop records nothing.
 */
async function recordCredentialResealHolds(engine: BrainEngine, failed: Array<Omit<CredentialResealHold, 'producer' | 'attempts' | 'at'>>): Promise<CredentialResealHold[]> {
  await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op='${HOLD_OP}' AND fingerprint NOT IN (SELECT h.fingerprint FROM ${HOLD_PAGES} WHERE h.op='${HOLD_OP}' AND ${LIVE_HOLD})`);
  const holds: CredentialResealHold[] = [];
  for (const item of failed) {
    const [prior] = await engine.executeRaw<{ hold: CredentialResealHold }>(`SELECT completed_keys->0 AS hold FROM op_checkpoints WHERE op='${HOLD_OP}' AND fingerprint=$1`, [String(item.page_id)]);
    const same = prior?.hold && prior.hold.revision === item.revision && prior.hold.producer === PRODUCER && prior.hold.code === item.code;
    const hold: CredentialResealHold = { ...item, producer: PRODUCER, attempts: same ? prior.hold.attempts + 1 : 1, at: new Date().toISOString() };
    await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('${HOLD_OP}',$1,$2::text::jsonb)
      ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [String(item.page_id), JSON.stringify([hold])]);
    holds.push(hold);
  }
  return holds;
}

export interface CredentialResealResult { resealed: number; superseded: number; failed: number; kept: number; held: CredentialResealHold[] }

/**
 * Re-seal every rebuildable pending page, one page per transaction, so an interrupted run resumes where it stopped.
 * GBRA-130 A-27: a page whose re-chunk fails item-scoped is held (`readCredentialResealHolds`) with its revision and
 * code and its chunks stay withheld; the run goes on. A run-scoped failure, or most pages failing
 * (`item_failures_systemic`), is thrown and records no hold.
 */
export async function resealCredentialProjections(engine: BrainEngine): Promise<CredentialResealResult> {
  const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; body_storage: string; revision: string }>(`SELECT p.id,p.source_id,p.slug,p.body_storage,
      p.knowledge_revision::text AS revision
    FROM pages p JOIN sources s ON s.id=p.source_id AND s.archived IS NOT TRUE
    WHERE ${PENDING} AND ${REBUILDABLE} ORDER BY p.id`);
  const result: CredentialResealResult = { resealed: 0, superseded: 0, failed: 0, kept: 0, held: [] };
  const run = new ItemRun('migration.credential_reseal');
  const failed: Array<Omit<CredentialResealHold, 'producer' | 'attempts' | 'at'>> = [];
  for (const row of rows) {
    try {
      // A segmented page's chunks are built from its stored pem regions; its projection rebuild re-seals it.
      const resealed = row.body_storage === 'segmented'
        ? (await buildSegmentedProjection(engine, { sourceId: row.source_id, slug: row.slug })).sealed
        : await resealSafeChunks(engine, row.slug, row.source_id);
      run.succeed();
      if (resealed) result.resealed++;
      else result.superseded++;
    } catch (error) {
      if (error instanceof PageRevisionConflictError) { run.succeed(); result.superseded++; continue; }
      const failure = run.fail(`${row.source_id}:${row.slug}`, error);
      failed.push({ page_id: Number(row.id), source_id: row.source_id, slug: row.slug, revision: row.revision, code: failure.code, message: redactConnectionInfo(failure.message) });
      process.stderr.write(`[gbrain] Credential-safe re-chunk failed for ${row.source_id}:${row.slug} (${failure.code}); its chunks stay withheld. `
        + `Retry: gbrain repair safe-chunks --source ${row.source_id} --apply\n`);
    }
  }
  result.held = await recordCredentialResealHolds(engine, failed);
  result.failed = failed.length;
  result.kept = (await credentialProjectionPending(engine)).kept;
  return result;
}
