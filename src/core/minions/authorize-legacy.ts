/** Local-only, explicit preview/CAS authorization of pre-cutover job rows. */
import type { BrainEngine } from '../engine.ts';
import { APPLICATION_AUTHORITY, authorityDigest, parseSubmissionAuthority } from './submission-authority.ts';

export function parseLegacyJobIds(raw: string | undefined): number[] {
  if (!raw || !/^\d+(,\d+)*$/.test(raw)) throw new Error('authorize-legacy requires --ids <id,id,...>; implicit/all-job approval is unavailable');
  const ids = [...new Set(raw.split(',').map(Number))].sort((a, b) => a - b);
  if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('job ids must be positive safe integers');
  return ids;
}

async function snapshot(engine: BrainEngine, ids: number[], lock: boolean) {
  // The controlled cutover normally has no producers. Lock the graph table on
  // apply as well so a descendant insertion/reparent cannot race the CAS.
  if (lock) {
    await engine.executeRaw('LOCK TABLE minion_jobs IN SHARE ROW EXCLUSIVE MODE');
    await engine.executeRaw('LOCK TABLE sources IN SHARE MODE');
  }
  const jobs = await engine.executeRaw<Record<string, unknown>>(
    `SELECT *, submission_authority IS NULL AS legacy_authority_is_null
       FROM minion_jobs WHERE id = ANY($1::int[]) ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [ids]);
  if (jobs.length !== ids.length) throw new Error('One or more selected jobs no longer exist');
  // JSONB null also decodes to JS null. Only the SQL NULL left by the cutover
  // represents historical provenance; never downgrade unknown/versioned authority.
  if (jobs.some(job => job.legacy_authority_is_null !== true)) {
    throw new Error('Every selected job must have SQL NULL submission authority. For unsupported non-NULL authority, use matching application/database versions or explicitly cancel the job locally.');
  }
  const [active] = await engine.executeRaw<{ count: string }>("SELECT count(*)::text AS count FROM minion_jobs WHERE status = 'active'");
  // The controlled upgrade drains before review. Recovery decisions belong to
  // the local operator, never an implicit status/retry rewrite in this command.
  if (Number(active?.count ?? 0)) throw new Error('Drain or cancel all active jobs and stop producers/workers before authorizing legacy jobs');
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
  const digest = authorityDigest({ preview_version: 1, authority_version: 1, version, jobs, dependencies, sources });
  return {
    preview_version: 1 as const, authority_version: 1 as const, snapshot_digest: digest,
    jobs: jobs.map(job => ({
      id: job.id, name: job.name, status: job.status, data: job.data, previous_authority: job.submission_authority,
      data_digest: authorityDigest(job.data), parent_job_id: job.parent_job_id,
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

export async function authorizeLegacyJobs(engine: BrainEngine, ids: number[], expected?: string, yes = false) {
  if (ids.length === 0 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Explicit positive job ids required');
  if (!yes && expected === undefined) return { ...(await snapshot(engine, ids, false)), applied: false, authorized: 0 };
  if (!yes || !expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Apply requires BOTH --expect <preview snapshot_digest> and --yes');
  return engine.transaction(async tx => {
    const preview = await snapshot(tx, ids, true);
    if (preview.snapshot_digest !== expected) throw new Error('Legacy authorization snapshot changed; preview and review again');
    const changed = await tx.executeRaw<{ id: number }>(
      `UPDATE minion_jobs SET submission_authority = $2::jsonb
        WHERE id = ANY($1::int[]) AND submission_authority IS NULL RETURNING id`, [ids, APPLICATION_AUTHORITY]);
    if (changed.length !== ids.length) throw new Error('Legacy authorization CAS failed; no jobs authorized');
    return { ...preview, applied: true, authorized: changed.length };
  });
}
