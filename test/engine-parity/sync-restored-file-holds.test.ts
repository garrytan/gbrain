/**
 * BrainEngine parity — a file restored after `gbrain delete` is held for the file-drift consent step (LC-1, decision E1).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a managed Git source, `gbrain delete` removes the page's file; when a person restores the same bytes
 *    (a commit that re-adds it), the next managed sync holds the file `file_drift` on the deleted side
 *    (`tombstone_edited`, `restored: true`) and the page stays deleted; after the retention purge the hold re-screens to
 *    `purged_differs`; `gbrain repair file-drift --held --side deleted --state purged_differs --prefer file` previews
 *    importing it as a new page, and its apply brings the page back. Every engine arm returns the same holds and pages.
 *  - Regression: sync settled the restored file as "Already up to date", the retention purge then dropped the page for
 *    good, and doctor's `sources retry-held --unindexed` imported nothing (LC-1 in docs/research/gbrain-behavior-audit.md).
 *  - Why existing coverage misses it: test/sync-restored-deleted-file-lc1.test.ts checks each SQL arm against fixed
 *    expectations, never one arm against another, and has no Rust arm.
 *  - Seam: none. Real managed sync, the delete intent, the retention purge and the repair, as the CLI runs them.
 *
 * Rust arm (a managed stop, by name, RUST_ENGINE.md row 47): the source is created through the harness fixture
 * (createSource), and on a Rust brain the first managed sync refuses `engine_capability_missing` naming
 * `managed_persistence` (`performManagedSync`), before any work; the case asserts that refusal (rethrowManagedStop) and
 * stops there. Managed mode on Rust is the managed-mode program's (lane LM), after the Dec 1 swap; the delete intent,
 * the retention purge and the repair behind it still read their rows through `executeRaw` (the persistence journal, sync
 * holds and deletion markers in `op_checkpoints`, src/core/persistence/sync-pass.ts `readFileRemovingDeletes`).
 */
import { describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { purgeDeletedPagesCoordinated } from '../../src/core/persistence/purge-deleted.ts';
import { createSource, parityArms } from './harness.ts';
import { rethrowManagedStop } from '../helpers/rust-by-design-stop.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

const SOURCE = 'lc1-notes';
const quiet = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;

async function gitEffectsSettled(engine: BrainEngine): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
    if (!(await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE source_id=$1 AND kind='git' AND state<>'committed'", [SOURCE])).length) return;
    await Bun.sleep(100);
  }
  throw new Error('git effects did not settle');
}

describe('engine parity: a file restored after a delete asks first', () => {
  parityTest(
    'a restored file is held tombstone_edited, re-screened purged_differs after the retention purge, and comes back only on repair file-drift --prefer file',
    { methods: ['executeRaw', 'readPageSnapshot'], requires: 'managed_persistence', timeout: 240_000 },
    async (engine, backend) => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-lc1-'));
      try {
        return await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
          try {
            const root = join(home, SOURCE);
            mkdirSync(join(root, 'notes'), { recursive: true });
            git(root, 'init', '-q');
            // gbrain's own Git effect commits with the checkout's identity; a CI runner has no global one.
            git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
            writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n');
            chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755);
            writeFileSync(join(root, 'notes', 'ivy.md'), note('Ivy', 'Ivy private note. Okapi keyword.'));
            writeFileSync(join(root, 'notes', 'jon.md'), note('Jon', 'Jon note.'));
            commit(root, 'fixture');
            // A SQL brain claims the worktree with managed persistence off, then turns it on; a Rust brain has no such switch.
            if (backend !== 'rust') await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
            await createSource(engine, backend, SOURCE, {}, root);
            await claimWorktree(engine, SOURCE, root);
            if (backend !== 'rust') await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
            const sync = () => performManagedSync(engine, { sourceId: SOURCE, noPull: true, noEmbed: true, noExtract: true });
            // The Rust arm's managed stop, by name (RUST_ENGINE.md row 47): the managed sync refuses managed_persistence.
            await sync().catch((e: unknown) => rethrowManagedStop(e));
            const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: SOURCE } as unknown as OperationContext;
            const holds = async () => ((await readGitSourceHolds(engine, { sourceIds: [SOURCE] }))[0]?.holds ?? [])
              .map(hold => [hold.path, hold.code, hold.meta.state ?? null, hold.meta.restored ?? null]).sort();
            const state = async (slug: string) => { const s = await engine.readPageSnapshot(slug, { sourceId: SOURCE, includeDeleted: true }); return !s ? 'none' : s.page.deleted_at ? 'deleted' : 'live'; };
            const snapshot = (await engine.readPageSnapshot('notes/ivy', { sourceId: SOURCE }))!;
            await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'notes/ivy', source_id: SOURCE, request_id: randomUUID(), expected_revision: snapshot.revision }, waitMs: 30_000 });
            await gitEffectsSettled(engine);
            // The delete committed the file's removal (the source has gbrain's post-commit hook); a person restores it in a commit.
            git(root, 'checkout', 'HEAD~1', '--', 'notes/ivy.md');
            commit(root, 'restore ivy');
            await sync();
            const afterRestore = { holds: await holds(), ivy: await state('notes/ivy') };
            const purged = (await purgeDeletedPagesCoordinated(engine, 0)).slugs;
            await sync();
            const afterPurge = { holds: await holds(), ivy: await state('notes/ivy') };
            const run = async (expectHash?: string) => (await repairRunner(engine, { apply: expectHash !== undefined, noEmbed: true, logger: quiet })).run('file-drift',
              await resolveRepairScope(engine, SOURCE), { explicit: true, sourceFlag: SOURCE, held: true, side: 'deleted', state: 'purged_differs', prefer: 'file', ...(expectHash ? { expect: expectHash } : {}) });
            const preview = await run();
            const planned = ((preview.details?.pages ?? []) as Array<{ slug: string; action?: string; verb?: string }>).map(page => [page.slug, page.action, page.verb]);
            await run(preview.preview_hash!);
            await sync();
            const result = { afterRestore, purged, afterPurge, planned, after: { holds: await holds(), ivy: await state('notes/ivy'), jon: await state('notes/jon') } };
            expect(result).toEqual({
              afterRestore: { holds: [['notes/ivy.md', 'file_drift', 'tombstone_edited', true]], ivy: 'deleted' },
              purged: ['notes/ivy'],
              afterPurge: { holds: [['notes/ivy.md', 'file_drift', 'purged_differs', true]], ivy: 'none' },
              planned: [['notes/ivy', 'import_file', 'import as a new page']],
              after: { holds: [], ivy: 'live', jon: 'live' },
            });
            return result;
          } finally { await disposePersistenceConsumer(engine); }
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
    },
  );
});
