/**
 * Engine parity for the two ways out of a writer claim on a brain whose managed persistence was never activated:
 * `gbrain sources writer deactivate` (release the claim, classic sync resumes) and `gbrain sources writer activate`
 * (turn managed persistence on, then deactivate back to classic), run through runPersistenceAdministration and
 * performSync as the CLI runs them.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: after a reviewed claim, classic sync of the claimed source refuses `writer_coordinator_required` and
 *    names deactivate as the fix; a reviewed deactivate releases the claim (no binding left, the worktree retired, a
 *    committed pre-activation `writer_deactivate` topology change, the brain still classic at the same mode epoch) and
 *    the next sync imports the checkout; a reviewed activate turns managed persistence on with the claimed source as
 *    its one filesystem source and moves the mode epoch by one; a reviewed deactivate of that managed brain retires the
 *    worktree, moves the epoch once more and leaves the source unclaimed, and sync imports the checkout again.
 *    Called directly, the release store reads a fresh brain the same on every arm (no bindings, roots or recovering
 *    effect, `default` configured, audit pages in slug order after a cursor) and addPersistenceCounters changes an
 *    existing counter row only, refusing a sum below zero with the row unchanged.
 *  - Regression: an engine whose release or activation path refuses (`engine_capability_missing`), so a claim on it
 *    has no supported exit and fences sync for good.
 *  - Why existing coverage misses it: test/persistence-preactivation-claim.test.ts runs on PGLite and Postgres only and
 *    claims through the internal claimWorktree; the Rust engine refused every raw-SQL step of both paths.
 *  - Seam: none. Real engines, real Git checkout, typed members only.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { readPersistenceBrain } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { performSync } from '../../src/commands/sync.ts';

const { parityTest } = parityArms(testBackends());

/** Runs `run` with a scratch GBRAIN_HOME and a one-note Git checkout registered as source `work`. */
async function withClaimableCheckout<T>(engine: BrainEngine, backend: ParityBackend, run: (root: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-writer-release-parity-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'checkout');
      mkdirSync(join(root, 'notes'), { recursive: true });
      execFileSync('git', ['-C', root, 'init', '-q']);
      writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
      await createSource(engine, backend, 'work', {}, root);
      try { return await run(root); } finally { await disposePersistenceConsumer(engine); }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The code a refused call threw, or `applied` when it did not refuse. */
async function refusal(run: Promise<unknown>): Promise<string> {
  return run.then(() => 'applied', (error: unknown) => String((error as { code?: unknown } | null)?.code ?? (error as Error).message));
}

const reviewed = async (engine: BrainEngine, operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
const claim = async (engine: BrainEngine, root: string) =>
  (await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed(engine, 'writer_claim') })).claimed;
const sync = (engine: BrainEngine, root: string) => performSync(engine, { sourceId: 'work', repoPath: root, noPull: true, noEmbed: true, noExtract: true });

describe('writer release on a never-activated brain', () => {
  parityTest('a claimed source fences sync until a reviewed deactivate releases the claim, then sync imports the checkout', {
    methods: ['readWriterAdminState', 'worktreeClaimStore', 'isSourceClaimed', 'writerReleaseStore', 'addPersistenceCounters', 'listRetiredDeactivations'],
    timeout: 120_000,
  }, async (engine, backend) => withClaimableCheckout(engine, backend, async (root) => {
    const before = await readPersistenceBrain(engine);
    const claimed = await claim(engine, root);
    const fenced = await refusal(sync(engine, root));
    const preview = await runPersistenceAdministration(engine, 'writer_deactivate', { dry_run: true }) as Record<string, any>;
    const done = await runPersistenceAdministration(engine, 'writer_deactivate', await reviewed(engine, 'writer_deactivate')) as Record<string, any>;
    const after = await readPersistenceBrain(engine);
    const claimedAfter = await engine.isSourceClaimed('work');
    const synced = await sync(engine, root);
    const page = await engine.getPage('notes/alice-example', { sourceId: 'work' });
    const reclaimed = await claim(engine, root);
    const answers = {
      claimed, fenced,
      preview: { mode: preview.mode, deactivated: preview.deactivated, source_bindings: preview.source_bindings, blockers: preview.blockers,
        claims: preview.pre_activation_claims.map((c: { source_id: string; roots: string[] }) => [c.source_id, c.roots.length]) },
      done: { mode: done.mode, deactivated: done.deactivated, claims: done.pre_activation_claims.map((c: { source_id: string }) => c.source_id),
        retired: done.retired_worktrees.length, markers: done.local_markers?.state },
      brain: { enabled: after.enabled, same_epoch: String(after.mode_epoch) === String(before.mode_epoch) },
      claimed_after: claimedAfter,
      synced: ['first_sync', 'synced'].includes(synced.status), title: page?.title ?? null, reclaimed,
    };
    expect(answers).toEqual({
      claimed: true, fenced: 'writer_coordinator_required',
      preview: { mode: 'classic', deactivated: false, source_bindings: 1, blockers: [], claims: [['work', 1]] },
      done: { mode: 'classic', deactivated: false, claims: ['work'], retired: 1, markers: 'cleared' },
      brain: { enabled: false, same_epoch: true }, claimed_after: false,
      synced: true, title: 'Alice Example', reclaimed: true,
    });
    return answers;
  }));

  parityTest('a reviewed activate after a claim turns managed persistence on with the claimed source', {
    methods: ['readWriterAdminState', 'worktreeClaimStore', 'writerReleaseStore'],
    timeout: 120_000,
  }, async (engine, backend) => withClaimableCheckout(engine, backend, async (root) => {
    const before = await readPersistenceBrain(engine);
    const claimed = await claim(engine, root);
    const preview = await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, dry_run: true }) as Record<string, any>;
    const activated = await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed(engine, 'writer_activate') }) as Record<string, any>;
    const after = await readPersistenceBrain(engine);
    const again = await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed(engine, 'writer_activate') }) as Record<string, any>;
    const answers = {
      claimed,
      preview: { enabled: preview.enabled, activated: preview.activated, filesystem_sources: preview.filesystem_sources, legacy_locks: preview.legacy_locks },
      activated: { enabled: activated.enabled, activated: activated.activated, filesystem_sources: activated.filesystem_sources },
      brain: { enabled: after.enabled, epoch_moved: Number(after.mode_epoch) - Number(before.mode_epoch) },
      again: { activated: again.activated, reason: again.reason },
    };
    expect(answers).toEqual({
      claimed: true,
      preview: { enabled: false, activated: false, filesystem_sources: 1, legacy_locks: [] },
      activated: { enabled: true, activated: true, filesystem_sources: 1 },
      brain: { enabled: true, epoch_moved: 1 },
      again: { activated: false, reason: 'already_enabled' },
    });
    return answers;
  }));

  parityTest('a reviewed deactivate after activation returns the brain to classic, then sync imports the checkout', {
    methods: ['readWriterAdminState', 'worktreeClaimStore', 'writerReleaseStore', 'addPersistenceCounters', 'listRetiredDeactivations'],
    timeout: 120_000,
  }, async (engine, backend) => withClaimableCheckout(engine, backend, async (root) => {
    const before = await readPersistenceBrain(engine);
    const claimed = await claim(engine, root);
    await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed(engine, 'writer_activate') });
    const preview = await runPersistenceAdministration(engine, 'writer_deactivate', { dry_run: true }) as Record<string, any>;
    const done = await runPersistenceAdministration(engine, 'writer_deactivate', await reviewed(engine, 'writer_deactivate')) as Record<string, any>;
    const after = await readPersistenceBrain(engine);
    const claimedAfter = await engine.isSourceClaimed('work');
    const synced = await sync(engine, root);
    const page = await engine.getPage('notes/alice-example', { sourceId: 'work' });
    const answers = {
      claimed,
      preview: { mode: preview.mode, deactivated: preview.deactivated, source_bindings: preview.source_bindings, blockers: preview.blockers,
        retired: preview.retired_worktrees.length },
      done: { mode: done.mode, deactivated: done.deactivated, source_bindings: done.source_bindings, retired: done.retired_worktrees.length,
        epochs: [done.retired_mode_epoch - Number(before.mode_epoch), done.mode_epoch - Number(before.mode_epoch)], markers: done.local_markers?.state },
      brain: { enabled: after.enabled, epoch_moved: Number(after.mode_epoch) - Number(before.mode_epoch) },
      claimed_after: claimedAfter,
      synced: ['first_sync', 'synced'].includes(synced.status), title: page?.title ?? null,
    };
    expect(answers).toEqual({
      claimed: true,
      preview: { mode: 'managed', deactivated: false, source_bindings: 1, blockers: [], retired: 1 },
      done: { mode: 'classic', deactivated: true, source_bindings: 1, retired: 1, epochs: [1, 2], markers: 'cleared' },
      brain: { enabled: false, epoch_moved: 2 },
      claimed_after: false,
      synced: true, title: 'Alice Example',
    });
    return answers;
  }));

  parityTest('the release store reads a fresh brain and adds to an existing counter row only', {
    methods: ['writerReleaseStore', 'addPersistenceCounters', 'lockPersistenceCounters', 'readCounterRows'],
    timeout: 60_000,
  }, async (engine) => {
    const store = await engine.writerReleaseStore();
    for (const slug of ['b', 'ab', 'aa', 'c']) await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Body.', timeline: '' });
    const slugs = (rows: { slug: string }[]) => rows.map(r => r.slug);
    const fresh = {
      bindings: await store.sourceBindingCount(),
      bound: await store.boundSourceIds(),
      roots: await store.liveWorktreeRoots(),
      claims: await store.claimRoots(),
      sources: (await store.configuredSources(false)).map(s => s.id),
      recovering: await store.hasRecoveringEffect(),
    };
    // Plain lower-case slugs sort the same in byte order and under en_US.utf8: the audit SQL has no COLLATE, so
    // Postgres pages punctuated slugs in its locale order (the Rust byte order is pinned in tests/writer_release.rs).
    const audit = { all: slugs(await store.auditPages('default', '', 10)), after: slugs(await store.auditPages('default', 'ab', 2)),
      none: await store.auditPages('nope', '', 10), first: await store.auditPages('default', '', 1).then(([r]) => r ? { slug: r.slug, reason: r.database_only_reason } : 'missing') };
    // A missing row changes nothing; an existing row takes the add; a sum below zero refuses and changes nothing.
    await engine.addPersistenceCounters('principal:release', { outstanding_count: 2 });
    const missing = await engine.readCounterRows(['principal:release']);
    await engine.lockPersistenceCounters(['principal:release']);
    await engine.addPersistenceCounters('principal:release', { outstanding_count: 2, intent_bytes: 10 });
    const below = await engine.addPersistenceCounters('principal:release', { outstanding_count: -3 }).then(() => 'applied', () => 'refused');
    const [row] = await engine.readCounterRows(['principal:release']);
    const answers = { fresh, audit, missing, below, outstanding: Number(row?.outstanding_count), intent: Number(row?.intent_bytes) };
    expect(answers).toEqual({
      fresh: { bindings: 0, bound: [], roots: [], claims: [], sources: ['default'], recovering: false },
      audit: { all: ['aa', 'ab', 'b', 'c'], after: ['b', 'c'], none: [], first: { slug: 'aa', reason: null } },
      missing: [], below: 'refused', outstanding: 2, intent: 10,
    });
    return answers;
  });
});
