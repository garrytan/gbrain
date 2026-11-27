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
import type { AccessMigrationRow } from '../engine-sql/access-setup.ts';
import { opError } from '../ops/contract.ts';
import type { FolderRule } from './folder-rules.ts';
import { appliedRules, ensurePolicyState, getRevision, listRevisions, lockSource, readAccessStore, writeAccessStore, type AccessStore } from './policy.ts';
import { APPROVED_FILE, commitPolicyFile, isGitWorkTree, POLICY_FILE, sourcePolicyRoot, syncGitPolicy } from './policy-git.ts';
import { serializePolicyYaml } from './folder-rules.ts';
import { ownerConnectionFor } from '../rust-engine/owner-ipc/client.ts';
import { ownerIpcRefusal } from '../rust-engine/owner-ipc/routes.ts';

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

function unfinished(engine: BrainEngine, sourceId: string): Promise<AccessMigrationRow | null> {
  return engine.readUnfinishedAccessMigration(sourceId);
}

/**
 * The direction is the unfinished migration's, else `requested` (GST-2638: `--to database` sets the database store from
 * unset with no commit and no file, for a checkout that cannot take commits), else the other store (git when unset).
 */
export async function previewMigrate(engine: BrainEngine, sourceId: string, requested?: AccessStore): Promise<MigratePreview> {
  const from = await readAccessStore(engine, sourceId);
  const root = await sourcePolicyRoot(engine, sourceId);
  const gitRoot = root && isGitWorkTree(root) ? root : null;
  const pending = await unfinished(engine, sourceId).catch(() => null);
  const to: AccessStore = pending ? (pending.direction === 'to_git' ? 'git' : 'database') : requested ?? (from === 'git' ? 'database' : 'git');
  if (pending && requested && requested !== to) {
    throw opError('invalid_params', `Source ${sourceId} has an unfinished migration ${pending.id} to the ${to} store, so it cannot move to the ${requested} store now; nothing was written.`,
      `Finish it first with gbrain access rule migrate --source ${sourceId} --yes, then run gbrain access rule migrate --to ${requested} --source ${sourceId}.`);
  }
  if (!pending && requested && requested === from) {
    throw opError('invalid_params', `Source ${sourceId} already keeps its folder rules in the ${from} store; nothing was written.`, `gbrain access rule status --source ${sourceId} shows the store and its rules.`);
  }
  if (to === 'git' && !gitRoot) {
    throw opError('invalid_params', `Source ${sourceId} has no git work tree at its root (${root ?? 'no local path'}), so its folder rules stay in the database store.`,
      'Initialize or clone the repository at the source root first, then run gbrain access rule migrate again.');
  }
  const applied = await appliedRules(engine, sourceId);
  const desired = (await getRevision(engine, sourceId))?.rules ?? applied;
  const approved = (await listRevisions(engine, sourceId, 500)).find(r => r.approved_at)?.rules ?? applied;
  return { source_id: sourceId, from, to, root: gitRoot, desired, approved, resume: pending ? { id: pending.id, phase: pending.phase } : null };
}

export async function migrateAccessStore(engine: BrainEngine, sourceId: string, requested?: AccessStore): Promise<{ id: string; from: AccessStore | null; to: AccessStore; phase: string; receipts: Record<string, unknown> }> {
  const p = await previewMigrate(engine, sourceId, requested);
  // The store switch below runs in a transaction, which does not cross the owner socket: refuse before any write.
  if (ownerConnectionFor(engine)) throw ownerIpcRefusal('transaction', 'gbrain access rule migrate switches the store inside one');
  await ensurePolicyState(engine, sourceId);
  let job = await unfinished(engine, sourceId);
  if (!job) {
    const id = `mig_${randomUUID()}`;
    await engine.insertAccessMigration(id, sourceId, p.to === 'git' ? 'to_git' : 'to_database');
    job = { id, phase: 'started', direction: p.to === 'git' ? 'to_git' : 'to_database', receipts: {} };
  }
  const receipts = { ...job.receipts };
  const record = async (phase: string) => {
    await engine.recordAccessMigrationPhase(job!.id, phase, receipts);
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
    await tx.switchAccessMigration(job!.id, receipts);
  });
  job.phase = 'switched';
  await migrateSeams.afterPhase?.('switched');
  if (p.to === 'git') receipts.sync = (await syncGitPolicy(engine, sourceId, p.root!)).state;
  return { id: job.id, from: p.from, to: p.to, phase: job.phase, receipts };
}
