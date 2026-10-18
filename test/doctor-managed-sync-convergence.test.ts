/**
 * #6712 PR 4a: doctor's managed_sync_convergence counts (deep tier).
 *
 * Authoring gate: (1) protects doctor's read-only convergence counts per owned managed source; (2) a check that warns,
 * writes, or misses a source's unsettled paths fails here; (3) the shadow tests cover the receipt, not the doctor
 * surface; (4) no seam.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { managedSyncConvergenceEntry } from '../src/commands/doctor/checks/managed-sync-convergence.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes'); };

test('managed_sync_convergence reports each owned source\'s shadow counts, informational only', () => managedBrain(async ({ engine, root }) => {
  expect((await performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
  writeFileSync(join(root, 'one.md'), '---\ntitle: One\n---\n\nSynthetic one, edited.\n');
  commit(root);
  expect(managedSyncConvergenceEntry.tier).toBe('deep');
  const checks = await managedSyncConvergenceEntry.run({ engine, args: [] } as unknown as DoctorContext);
  expect(Array.isArray(checks)).toBe(true);
  const [check] = checks as Array<{ name: string; status: string; message: string; details: { dry_run: boolean; sources: Array<Record<string, unknown>> } }>;
  expect(check).toMatchObject({ name: 'managed_sync_convergence', status: 'ok', details: { dry_run: true } });
  expect(check!.details.sources).toEqual([expect.objectContaining({ source_id: 'default', status: 'read', candidates: 1, counts: { matched: 1, import: 1 }, would_hold: 0 })]);
  expect(check!.message).toContain('default 1 unsettled, 0 would hold');
}, { setup: ({ root }) => {
  git(root, 'init', '-q');
  writeFileSync(join(root, 'one.md'), '---\ntitle: One\n---\n\nSynthetic one.\n');
  writeFileSync(join(root, 'two.md'), '---\ntitle: Two\n---\n\nSynthetic two.\n');
  commit(root);
} }), 120_000);
