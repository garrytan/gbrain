/** Local-only, explicit preview/CAS authorization of pre-cutover job rows. */
import type { BrainEngine } from '../engine.ts';
import { catalogueError } from '../error-catalogue.ts';
import { OperationError } from '../ops/contract.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { APPLICATION_AUTHORITY, parseSubmissionAuthority } from './submission-authority.ts';
import {
  assertNoActiveJobs, formatSelection, selectCommand, selectedStatuses, summarizeSelection,
  type LegacyJobSelection, type SelectionSummary,
} from './legacy-selection.ts';

const IDS_EXAMPLE = 'gbrain jobs authorize-legacy --ids 12,34';

function idsPreviewCommand(ids: number[]): string {
  return `gbrain jobs authorize-legacy --ids ${ids.join(',')}`;
}

function selectionInvalid(message: string, hint: string) {
  return catalogueError('legacy_job_selection_invalid', message, hint);
}

export function parseLegacyJobIds(raw: string | undefined): number[] {
  if (!raw || !/^\d+(,\d+)*$/.test(raw)) {
    throw selectionInvalid('authorize-legacy requires --ids <id,id,...> or --select <filter>; implicit/all-job approval is unavailable.',
      `${IDS_EXAMPLE}, or gbrain jobs authorize-legacy --select "status=waiting"`);
  }
  const ids = [...new Set(raw.split(',').map(Number))].sort((a, b) => a - b);
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw selectionInvalid('Job ids must be positive safe integers.', IDS_EXAMPLE);
  return ids;
}

async function snapshot(engine: BrainEngine, ids: number[], lock: boolean, previewCommand: string) {
  // The controlled cutover normally has no producers. Lock the graph table on
  // apply as well so a descendant insertion/reparent cannot race the CAS.
  if (lock) {
    await engine.executeRaw('LOCK TABLE minion_jobs IN SHARE ROW EXCLUSIVE MODE');
    await engine.executeRaw('LOCK TABLE sources IN SHARE MODE');
  }
  const jobs = await engine.executeRaw<Record<string, unknown>>(
    `SELECT *, submission_authority IS NULL AS legacy_authority_is_null
       FROM minion_jobs WHERE id = ANY($1::int[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [ids]);
  if (jobs.length !== ids.length) {
    const found = new Set(jobs.map(job => Number(job.id)));
    throw selectionInvalid(`Selected jobs no longer exist: ${ids.filter(id => !found.has(id)).slice(0, 10).join(', ')}.`, `Re-run the preview: ${previewCommand}`);
  }
  // JSONB null also decodes to JS null. Only the SQL NULL left by the cutover
  // represents historical provenance; never downgrade unknown/versioned authority.
  const unsupported = jobs.filter(job => job.legacy_authority_is_null !== true).map(job => Number(job.id));
  if (unsupported.length) {
    throw selectionInvalid(`Every selected job must have SQL NULL submission authority; jobs ${unsupported.slice(0, 10).join(', ')} carry unsupported non-NULL authority.`,
      `Run matching application and database versions, or cancel them locally: ${unsupported.slice(0, 10).map(id => `gbrain jobs cancel ${id}`).join('; ')}.`);
  }
  // The controlled upgrade drains before review. Recovery decisions belong to
  // the local operator, never an implicit status/retry rewrite in this command.
  await assertNoActiveJobs(engine, previewCommand);
  const graph = await engine.executeRaw<Record<string, unknown>>(
    `WITH RECURSIVE connected(id) AS (
       SELECT id FROM minion_jobs WHERE id = ANY($1::int[])
       UNION
       SELECT adjacent.id FROM minion_jobs adjacent
       JOIN minion_jobs edge ON adjacent.parent_job_id = edge.id OR adjacent.id = edge.parent_job_id
       JOIN connected c ON edge.id = c.id
     ) SELECT * FROM minion_jobs WHERE id IN (SELECT id FROM connected) ORDER BY id`, [ids]);
  const dependencies = graph.filter(job => !ids.includes(Number(job.id)));
  // Include source registration state in CAS without assuming old payload source
  // fields prove authority. The operator is approving the actual historical work.
  const sources = await engine.executeRaw<Record<string, unknown>>('SELECT id, local_path, config, archived, created_at FROM sources ORDER BY id');
  const version = await engine.getConfig('version');
  const digest = previewHash({ preview_version: 1, authority_version: 1, version, jobs, dependencies, sources });
  return {
    preview_version: 1 as const, authority_version: 1 as const, snapshot_digest: digest,
    jobs: jobs.map(job => ({
      id: job.id, name: job.name, status: job.status, data: job.data, previous_authority: job.submission_authority,
      data_digest: previewHash(job.data), parent_job_id: job.parent_job_id,
      delay_until: job.delay_until, attempts_made: job.attempts_made,
    })),
    // Full recursive graph, including payload and failure policy, makes downstream
    // cancellation/release effects reviewable. Only the explicitly selected IDs
    // gain authority; graph rows participate in the CAS without being rewritten.
    dependencies: dependencies.map((row): Record<string, unknown> => ({ ...row, claim_generation: String(row.claim_generation) })),
    effects: { implicitly_authorized_ids: [],
      startup_blocking_dependency_ids: dependencies.filter(row =>
        ['waiting', 'active', 'delayed', 'waiting-children', 'paused'].includes(String(row.status)) &&
        !parseSubmissionAuthority(row.submission_authority)).map(row => row.id),
      note: 'Parent completion/failure/cancellation keeps the existing graph policies shown in dependencies.' },
    // No dependency is implicitly authorized; unselected nonterminal legacy rows
    // continue to block worker startup until separately reviewed or cancelled.
  };
}

export async function authorizeLegacyJobs(engine: BrainEngine, ids: number[], expected?: string, yes = false, previewCommand = idsPreviewCommand(ids)) {
  if (ids.length === 0 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw selectionInvalid('Explicit positive job ids are required.', IDS_EXAMPLE);
  if (!yes && expected === undefined) return { ...(await snapshot(engine, ids, false, previewCommand)), applied: false, authorized: 0 };
  if (!yes || !expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw selectionInvalid('Apply requires BOTH --expect <preview snapshot_digest> and --yes.',
      expected && /^[a-f0-9]{64}$/.test(expected) ? `${previewCommand} --expect ${expected} --yes` : `Preview first: ${previewCommand}`);
  }
  return engine.transaction(async tx => {
    const preview = await snapshot(tx, ids, true, previewCommand);
    if (preview.snapshot_digest !== expected) {
      throw catalogueError('preview_changed', `Legacy authorization snapshot changed since ${expected}; re-run ${previewCommand} and use the new hash.`,
        `Re-run the preview: ${previewCommand}`);
    }
    const changed = await tx.executeRaw<{ id: number }>(
      `UPDATE minion_jobs SET submission_authority = $2::jsonb
        WHERE id = ANY($1::int[]) AND submission_authority IS NULL RETURNING id`, [ids, APPLICATION_AUTHORITY]);
    if (changed.length !== ids.length) throw previewChangedError(expected, previewCommand);
    return { ...preview, applied: true, authorized: changed.length };
  });
}

interface ApprovedLegacySelection { selection: string; ids: number[]; snapshot_digest: string }

export interface LegacySelectionPreview {
  selection: string;
  preview_command: string;
  /** Selected rows with SQL NULL authority: the set an apply authorizes. */
  summary: SelectionSummary;
  /** Matching live rows whose non-NULL authority is unsupported; never authorizable. */
  unsupported_ids: number[];
  /** The hash `--expect` takes: the filter plus the snapshot digest the apply re-checks. */
  preview_hash: string | null;
  apply_command: string | null;
  startup_blocking_dependency_count: number;
  snapshot: Awaited<ReturnType<typeof snapshot>> | null;
  applied: false;
}

/**
 * `gbrain jobs authorize-legacy --select <filter>`: lists every matching SQL
 * NULL row, hashes the same snapshot `--ids` reviews and saves the exact id
 * set under that hash, so `--expect <hash> --yes` approves exactly it.
 */
export async function previewLegacySelection(engine: BrainEngine, selection: LegacyJobSelection): Promise<LegacySelectionPreview> {
  const previewCommand = selectCommand('authorize-legacy', selection);
  const rows = await engine.executeRaw<{ id: number; name: string; status: string; submission_authority: unknown; legacy_authority_is_null: boolean }>(
    `SELECT id, name, status, submission_authority, submission_authority IS NULL AS legacy_authority_is_null
       FROM minion_jobs
      WHERE status = ANY($1::text[]) AND (cardinality($2::text[]) = 0 OR name = ANY($2::text[]))
        AND submission_authority IS DISTINCT FROM '{"version":1,"kind":"application"}'::jsonb
      ORDER BY id`, [selectedStatuses('authorize-legacy', selection), selection.names]);
  const legacy = rows.filter(row => row.legacy_authority_is_null === true);
  const unsupported_ids = rows.filter(row => row.legacy_authority_is_null !== true && !parseSubmissionAuthority(row.submission_authority)).map(row => Number(row.id));
  const base = { selection: formatSelection(selection), preview_command: previewCommand, summary: summarizeSelection(legacy), unsupported_ids, applied: false as const };
  if (!legacy.length) return { ...base, preview_hash: null, apply_command: null, startup_blocking_dependency_count: 0, snapshot: null };
  const ids = legacy.map(row => Number(row.id));
  const preview = await snapshot(engine, ids, false, previewCommand);
  // The approval hash binds the filter as well as the snapshot, so two filters
  // that happen to select the same rows never overwrite each other's set.
  const hash = previewHash({ selection: base.selection, snapshot_digest: preview.snapshot_digest });
  await saveApprovedSet<ApprovedLegacySelection>(engine, { command: 'authorize-legacy', hash }, [{ selection: base.selection, ids, snapshot_digest: preview.snapshot_digest }]);
  return {
    ...base, preview_hash: hash, apply_command: selectCommand('authorize-legacy', selection, hash),
    startup_blocking_dependency_count: preview.effects.startup_blocking_dependency_ids.length, snapshot: preview,
  };
}

/** `--select <filter> --expect <hash> --yes`: authorizes exactly the set the preview saved under `hash`, or refuses whole. */
export async function applyLegacySelection(engine: BrainEngine, selection: LegacyJobSelection, expected: string | undefined, yes: boolean) {
  const previewCommand = selectCommand('authorize-legacy', selection);
  if (!yes || !expected || !/^[a-f0-9]{64}$/.test(expected)) {
    throw selectionInvalid('Apply requires BOTH --expect <preview hash> and --yes.',
      expected && /^[a-f0-9]{64}$/.test(expected) ? selectCommand('authorize-legacy', selection, expected) : `Preview first: ${previewCommand}`);
  }
  const approved = await loadApprovedSet<ApprovedLegacySelection>(engine, { command: 'authorize-legacy', hash: expected, previewCommand });
  const [item] = approved.items;
  if (!item || item.selection !== formatSelection(selection) || !item.ids.length || !item.snapshot_digest) throw previewChangedError(expected, previewCommand);
  let result;
  try {
    result = await authorizeLegacyJobs(engine, item.ids, item.snapshot_digest, true, previewCommand);
  } catch (error) {
    if (error instanceof OperationError && error.code === 'preview_changed') throw previewChangedError(expected, previewCommand);
    throw error;
  }
  await clearApprovedSet(engine, { command: 'authorize-legacy', hash: expected });
  return { selection: item.selection, authorized_ids: item.ids, ...result };
}

