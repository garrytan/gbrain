/**
 * GBRA-218 (PR A2): `gbrain access rule migrate`, moving a source's folder rules
 * between the database store and the git store without a moment where a rule
 * is missing. The applied rulebook in the database stays in force throughout;
 * only the store (`sources.config.access_store`) changes, last.
 *
 *  - database → git (a repo-less source gained a repo): write
 *    `.gbrain/access.approved` (the latest approved revision) and `.gbrain/access.yml`
 *    (the desired revision) through the git door, then switch the store; the
 *    next sync reads the same rules back, so nothing changes.
 *  - git → database (the repo is gone or this host cannot see it): switch the
 *    store; the database copy already holds the effective applied rulebook
 *    (automatic narrowings and pending coverage included) and the held
 *    widenings stay held.
 *
 * Each phase is journaled (access_policy_migrations) under a durable id, so an
 * interrupted migrate resumes where it stopped and a repeat is idempotent.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import type { FolderRule } from './folder-rules.ts';
import { appliedRules, ensurePolicyState, getRevision, listRevisions, lockSource, readAccessStore, writeAccessStore, type AccessStore } from './policy.ts';
import { APPROVED_FILE, commitPolicyFile, isGitWorkTree, POLICY_FILE, sourcePolicyRoot, syncGitPolicy } from './policy-git.ts';
import { serializePolicyYaml } from './folder-rules.ts';

export interface MigratePreview {
  source_id: string;
  from: AccessStore | null;
  to: AccessStore;
  root: string | null;
  desired: FolderRule[];
  approved: FolderRule[];
  resume: { id: string; phase: string } | null;
}

/** Test seam: runs after a phase is journaled ('committed', then 'switched'), before the next step. */
export const migrateSeams: { afterPhase?: (phase: string) => Promise<void> | void } = {};

async function unfinished(engine: BrainEngine, sourceId: string): Promise<{ id: string; phase: string; direction: string; receipts: Record<string, unknown> } | null> {
  const [row] = await engine.executeRaw<{ id: string; phase: string; direction: string; receipts: unknown }>(
    `SELECT id, phase, direction, receipts FROM access_policy_migrations WHERE source_id = $1 AND phase <> 'switched' ORDER BY created_at DESC LIMIT 1`, [sourceId]);
  if (!row) return null;
  return { ...row, receipts: (typeof row.receipts === 'string' ? JSON.parse(row.receipts) : row.receipts) as Record<string, unknown> ?? {} };
}

export async function previewMigrate(engine: BrainEngine, sourceId: string): Promise<MigratePreview> {
  const from = await readAccessStore(engine, sourceId);
  const root = await sourcePolicyRoot(engine, sourceId);
  const gitRoot = root && isGitWorkTree(root) ? root : null;
  const pending = await unfinished(engine, sourceId).catch(() => null);
  const to: AccessStore = pending ? (pending.direction === 'to_git' ? 'git' : 'database') : from === 'git' ? 'database' : 'git';
  if (to === 'git' && !gitRoot) {
    throw opError('invalid_params', `Source ${sourceId} has no git work tree at its root (${root ?? 'no local path'}), so its folder rules stay in the database store.`,
      'Initialize or clone the repository at the source root first, then run gbrain access rule migrate again.');
  }
  const applied = await appliedRules(engine, sourceId);
  const desired = (await getRevision(engine, sourceId))?.rules ?? applied;
  const approved = (await listRevisions(engine, sourceId, 500)).find(r => r.approved_at)?.rules ?? applied;
  return { source_id: sourceId, from, to, root: gitRoot, desired, approved, resume: pending ? { id: pending.id, phase: pending.phase } : null };
}

export async function migrateAccessStore(engine: BrainEngine, sourceId: string): Promise<{ id: string; from: AccessStore | null; to: AccessStore; phase: string; receipts: Record<string, unknown> }> {
  const p = await previewMigrate(engine, sourceId);
  await ensurePolicyState(engine, sourceId);
  let job = await unfinished(engine, sourceId);
  if (!job) {
    const id = `mig_${randomUUID()}`;
    await engine.executeRaw(`INSERT INTO access_policy_migrations (id, source_id, direction, phase) VALUES ($1, $2, $3, 'started')`, [id, sourceId, p.to === 'git' ? 'to_git' : 'to_database']);
    job = { id, phase: 'started', direction: p.to === 'git' ? 'to_git' : 'to_database', receipts: {} };
  }
  const receipts = { ...job.receipts };
  const record = async (phase: string) => {
    await engine.executeRaw('UPDATE access_policy_migrations SET phase = $2, receipts = $3::text::jsonb, updated_at = now() WHERE id = $1', [job!.id, phase, JSON.stringify(receipts)]);
    job!.phase = phase;
  };
  if (p.to === 'git') {
    if (job.phase === 'started') {
      receipts.approved = await commitPolicyFile(p.root!, APPROVED_FILE, () => serializePolicyYaml(p.approved, 'The folder rules an operator approved with gbrain access apply. Written by gbrain; do not edit.'), `access: move folder rules of ${sourceId} to git (approved)`);
      await record('exported');
    }
    if (job.phase === 'exported') {
      receipts.desired = await commitPolicyFile(p.root!, POLICY_FILE, () => serializePolicyYaml(p.desired, 'Folder read rules for this source (gbrain access rule add|rm). Narrowing changes apply at the next sync;\nwidening changes wait for gbrain access apply --source <id> on the brain host.'), `access: move folder rules of ${sourceId} to git`);
      await record('committed');
    }
  } else if (job.phase === 'started') {
    await record('committed');
  }
  await migrateSeams.afterPhase?.('committed');
  await engine.transaction(async tx => {
    await lockSource(tx, sourceId);
    await writeAccessStore(tx, sourceId, p.to);
    await tx.executeRaw(`UPDATE access_policy_migrations SET phase = 'switched', receipts = $2::text::jsonb, updated_at = now() WHERE id = $1`, [job!.id, JSON.stringify(receipts)]);
  });
  job.phase = 'switched';
  await migrateSeams.afterPhase?.('switched');
  if (p.to === 'git') receipts.sync = (await syncGitPolicy(engine, sourceId, p.root!)).state;
  return { id: job.id, from: p.from, to: p.to, phase: job.phase, receipts };
}
