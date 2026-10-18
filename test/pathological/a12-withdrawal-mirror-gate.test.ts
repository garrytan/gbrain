/**
 * GBRA-130 A-12: a withdrawal-mirror effect that ended `failed` (one parked
 * target, or `source_changed` when its source was archived while it was queued)
 * gated its request's Git and embedding effects forever: both claim queries and
 * the lifecycle settlement waited on `mirror.state<>'committed'`. The withdrawn
 * pages stayed vectorless, Git never committed, and the source's lifecycle refused.
 *
 * Authoring gate: (1) protects "a finished mirror releases exactly the targets it
 * committed": Git and embedding run for the mirrored pages and park every other
 * target with `withdrawal_mirror_failed` (a mirror that failed before rewriting a
 * file never lets Git commit withdrawn text), the coalesced single-file Git claim
 * honours the same list, retry-effects reruns a failed mirror and re-arms the
 * withheld targets, and a run-scoped failure reading the list parks nothing.
 * The list is the pages whose file the mirror recorded rewriting, never its
 * cursor: a page it passed without rewriting (a drifted or missing file) is
 * never committed by Git, and an attempt that finds its mirror queued again
 * (retry-effects between the claim and the attempt) waits instead of running
 * unrestricted.
 * (2) Reverting the gate in effect-journal.ts leaves Git and embedding queued and
 * every item case goes red; reverting the allowlist commits withdrawn files.
 * (3) No existing test fails a mirror and then looks at its siblings.
 * (4) The failure is a real one: a directory where the mirror expects the page file.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { retryRequestEffects } from '../../src/core/persistence/effect-retry.ts';
import { settleTopologyRequests, topologyPrincipal } from '../../src/core/persistence/topology-locks.ts';
import { checkParkedEffects } from '../../src/commands/doctor/checks/parked-effects.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { committedActiveClaim, committedSinceSeed, drain, effectsOf, embeddedPages, passes, SOURCE, TARGETS, UNTOUCHED, withdrawalBrain } from './effects-fixture.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const [W1, W2, W3] = TARGETS;
const WITHHELD = 'withdrawal_mirror_failed';
/** A directory where the mirror expects page W2's file: every mirror attempt for it fails before writing anything. */
const breakFile = (root: string, slug = W2) => { rmSync(join(root, `${slug}.md`)); mkdirSync(join(root, `${slug}.md`)); };
const fixFile = (root: string, slug = W2) => { rmSync(join(root, `${slug}.md`), { recursive: true }); git(root, 'checkout', '--', `${slug}.md`); };
const actions = (result: Record<string, unknown>) => Object.fromEntries((result.effects as Array<{ kind: string; action: string }>).map(e => [e.kind, e.action]));

/** One claim per pass: only the mirror runs (Git and embedding wait on it) until it ends `state`. */
async function mirrorOnly(engine: BrainEngine, requestId: string, state: 'failed' | 'committed'): Promise<void> {
  for (let pass = 0; pass < 20 && (await effectsOf(engine, requestId))['withdrawal-mirror'].state !== state; pass++) {
    await expectUnitNotAborted(() => drain(engine, 1, { limit: 1 }));
  }
}

async function settleLifecycle(engine: BrainEngine): Promise<number> {
  const binding = (await getWorktreeBinding(engine, SOURCE, localHostId()))!;
  const principal = await topologyPrincipal(engine);
  return engine.transaction(tx => settleTopologyRequests(tx, [SOURCE], [binding.worktree_id], principal));
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-12 a failed withdrawal mirror releases only what it committed (${backend})`, () => {
    test('A-12 item: a mirror that parked one target lets Git and embedding finish the targets it committed and withholds the rest', async () => {
      await withdrawalBrain(databaseUrl, async ({ engine, root, request, ctx }) => {
        breakFile(root);
        const before = await snapshotItems(engine, SOURCE);
        await expectUnitNotAborted(() => drain(engine, 12));
        const effects = await effectsOf(engine, request.id);
        expect({ state: effects['withdrawal-mirror'].state, parked: effects['withdrawal-mirror'].data.parked?.map((p: { slug: string }) => p.slug) })
          .toEqual({ state: 'failed', parked: [W2] });
        for (const kind of ['git', 'embedding']) {
          expect({ kind, state: effects[kind].state, error_code: effects[kind].error_code }).toEqual({ kind, state: 'failed', error_code: 'targets_parked' });
          const [parked] = effects[kind].data.parked ?? [];
          expectItemFailure(parked && { key: parked.slug, code: parked.error_code }, { key: W2, code: WITHHELD });
        }
        expect(committedSinceSeed(root).sort()).toEqual([`${W1}.md`, `${W3}.md`]);
        expect(await embeddedPages(engine)).toEqual([W1, W3]);
        expectOthersUnchanged(before, await snapshotItems(engine, SOURCE), { changed: [W2], expectProgress: [W1, W3], progressFields: ['chunks'] });
        expect((await snapshotItems(engine, SOURCE)).get(UNTOUCHED)).toEqual(before.get(UNTOUCHED));
        const doctor = await checkParkedEffects(engine);
        expect(doctor.message).toContain(`${W2} (${WITHHELD})`);
        expect(doctor.message).toContain(`gbrain sources writer retry-effects ${SOURCE} --request-id ${request.request_id} --dry-run`);
        expect(await expectUnitNotAborted(() => settleLifecycle(engine))).toBe(0);

        // Recovery: the file is restored, one retry-effects reruns the mirror's parked target and re-arms the withheld ones.
        fixFile(root);
        expect(actions(await retryRequestEffects(engine, SOURCE, request.request_id, true, ctx.config)))
          .toEqual({ embedding: 'would_retry', git: 'would_retry', 'withdrawal-mirror': 'would_retry' });
        await retryRequestEffects(engine, SOURCE, request.request_id, false, ctx.config);
        await drain(engine, 8);
        const after = await effectsOf(engine, request.id);
        for (const kind of ['withdrawal-mirror', 'git', 'embedding']) expect({ kind, state: after[kind].state }).toEqual({ kind, state: 'committed' });
        expect(committedSinceSeed(root).sort()).toEqual([`${W1}.md`, `${W2}.md`, `${W3}.md`]);
        expect(await embeddedPages(engine)).toEqual(TARGETS);
      });
    }, 180_000);

    test('A-12 item: a mirror that failed source_changed withholds its remaining targets; retry-effects reruns it once the source is back', async () => {
      await withdrawalBrain(databaseUrl, async ({ engine, root, request, ctx }) => {
        await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [SOURCE]);
        await expectUnitNotAborted(() => drain(engine, 2, { projections: false }));
        await engine.executeRaw('UPDATE sources SET archived=false WHERE id=$1', [SOURCE]);
        const failed = await effectsOf(engine, request.id);
        expect(Object.fromEntries(Object.values(failed).map(e => [e.kind, e.state]))).toEqual({ embedding: 'failed', git: 'failed', 'withdrawal-mirror': 'failed' });
        expect(failed['withdrawal-mirror'].error_code).toBe('source_changed');
        expect(committedSinceSeed(root)).toEqual([]);
        expect(await expectUnitNotAborted(() => settleLifecycle(engine))).toBe(0);
        expect(actions(await retryRequestEffects(engine, SOURCE, request.request_id, true, ctx.config)))
          .toEqual({ embedding: 'would_retry', git: 'would_retry', 'withdrawal-mirror': 'would_retry' });
        await retryRequestEffects(engine, SOURCE, request.request_id, false, ctx.config);
        await drain(engine, 8);
        const after = await effectsOf(engine, request.id);
        for (const kind of ['withdrawal-mirror', 'git', 'embedding']) expect({ kind, state: after[kind].state }).toEqual({ kind, state: 'committed' });
        expect(committedSinceSeed(root).sort()).toEqual(TARGETS.map(slug => `${slug}.md`));
        expect(await embeddedPages(engine)).toEqual(TARGETS);
      });
    }, 180_000);

    test('A-12 item: retry-effects requeuing the failed mirror after a Git page walk was claimed keeps Git off the page the mirror never published', async () => {
      await withdrawalBrain(databaseUrl, async ({ engine, root, request, ctx }) => {
        const raw = readFileSync(join(root, `${W2}.md`));
        breakFile(root);
        // The race: Git is claimed behind the failed mirror with W2 next, then retry-effects requeues the mirror
        // (W2's file holds its pre-withdrawal bytes again) before the Git attempt reads the mirror's state.
        const original = engine.executeRaw;
        let raced = null as Record<string, string> | null;
        engine.executeRaw = (async function (this: BrainEngine, sql: string, params?: unknown[]) {
          if (!raced && /FROM persistence_effects WHERE kind='withdrawal-mirror'/.test(sql)) {
            const states = Object.fromEntries((await original.call(engine, `SELECT kind,state,data->>'after_slug' AS after FROM persistence_effects WHERE request_id=$1::uuid`,
              [request.id]) as Array<{ kind: string; state: string; after: string | null }>).map(row => [row.kind, `${row.state}:${row.after}`]));
            if (states.git === `running:${W1}` && !states.embedding?.startsWith('running')) {
              rmSync(join(root, `${W2}.md`), { recursive: true }); writeFileSync(join(root, `${W2}.md`), raw);
              raced = actions(await retryRequestEffects(engine, SOURCE, request.request_id, false, ctx.config));
            }
          }
          return original.call(this, sql, params);
        }) as BrainEngine['executeRaw'];
        try { await expectUnitNotAborted(() => drain(engine, 12)); } finally { engine.executeRaw = original; }
        expect(raced?.['withdrawal-mirror']).toBe('retry_queued');
        expect(committedActiveClaim(root)).toEqual([]);
        const after = await effectsOf(engine, request.id);
        for (const kind of ['withdrawal-mirror', 'git']) expect({ kind, state: after[kind].state }).toEqual({ kind, state: 'committed' });
        expect(committedSinceSeed(root).sort()).toEqual(TARGETS.map(slug => `${slug}.md`));
      }, { untracked: [W2] });
    }, 180_000);

    test('A-12 item: Git never commits a page the failed mirror passed without publishing its file, before or after retry-effects', async () => {
      await withdrawalBrain(databaseUrl, async ({ engine, root, request, ctx }) => {
        const raw = readFileSync(join(root, `${W1}.md`));
        writeFileSync(join(root, `${W1}.md`), `${raw}\nAn uncoordinated local edit.\n`);
        breakFile(root, W3);
        await mirrorOnly(engine, request.id, 'failed');
        const mirror = (await effectsOf(engine, request.id))['withdrawal-mirror'];
        expect({ state: mirror.state, skipped: mirror.data.skipped, parked: mirror.data.parked?.map((p: { slug: string }) => p.slug) })
          .toEqual({ state: 'failed', skipped: [{ slug: W1, reason: 'file_database_drift' }], parked: [W3] });
        expect(committedSinceSeed(root)).toEqual([]);
        // The local edit is undone: W1's file holds its pre-withdrawal bytes, which the database's withdrawal overlay still matches.
        writeFileSync(join(root, `${W1}.md`), raw);
        await expectUnitNotAborted(() => drain(engine, 12));
        expect(committedActiveClaim(root)).toEqual([]);
        expect(committedSinceSeed(root)).toEqual([`${W2}.md`]);
        const effects = await effectsOf(engine, request.id);
        expect({ state: effects.git.state, skipped: effects.git.data.skipped, parked: effects.git.data.parked })
          .toEqual({ state: 'failed', skipped: [{ slug: W1, reason: 'withdrawal_not_mirrored' }], parked: [{ slug: W3, error_code: WITHHELD }] });

        fixFile(root, W3);
        await retryRequestEffects(engine, SOURCE, request.request_id, false, ctx.config);
        await expectUnitNotAborted(() => drain(engine, 8));
        expect(committedActiveClaim(root)).toEqual([]);
        expect(committedSinceSeed(root).sort()).toEqual([`${W2}.md`, `${W3}.md`]);
        const after = await effectsOf(engine, request.id);
        for (const kind of ['withdrawal-mirror', 'git', 'embedding']) expect({ kind, state: after[kind].state }).toEqual({ kind, state: 'committed' });
        expect(await embeddedPages(engine)).toEqual(TARGETS);
      }, { untracked: [W1] });
    }, 180_000);

    test('A-12 item: a Git page parked behind the mirror is re-armed when the mirror commits, with no second retry-effects', async () => {
      await withdrawalBrain(databaseUrl, async ({ engine, root, request, ctx }) => {
        const raw = readFileSync(join(root, `${W2}.md`));
        breakFile(root);
        // The other order of the race: the Git attempt reads the failed mirror first, then retry-effects requeues
        // the mirror, so the attempt parks W2 behind it; the mirror then publishes W2 and commits.
        const original = engine.executeRaw;
        const retries: Record<string, string>[] = [];
        engine.executeRaw = (async function (this: BrainEngine, sql: string, params?: unknown[]) {
          const result = await original.call(this, sql, params);
          if (!retries.length && /FROM persistence_effects WHERE kind='withdrawal-mirror'/.test(sql)) {
            const states = Object.fromEntries((await original.call(engine, `SELECT kind,state,data->>'after_slug' AS after FROM persistence_effects WHERE request_id=$1::uuid`,
              [request.id]) as Array<{ kind: string; state: string; after: string | null }>).map(row => [row.kind, `${row.state}:${row.after}`]));
            if (states.git === `running:${W1}` && !states.embedding?.startsWith('running')) {
              rmSync(join(root, `${W2}.md`), { recursive: true }); writeFileSync(join(root, `${W2}.md`), raw);
              retries.push(actions(await retryRequestEffects(engine, SOURCE, request.request_id, false, ctx.config)));
            }
          }
          return result;
        }) as BrainEngine['executeRaw'];
        try { await expectUnitNotAborted(() => drain(engine, 16)); } finally { engine.executeRaw = original; }
        expect(retries.map(retry => retry['withdrawal-mirror'])).toEqual(['retry_queued']);
        expect(committedActiveClaim(root)).toEqual([]);
        const after = await effectsOf(engine, request.id);
        for (const kind of ['withdrawal-mirror', 'git', 'embedding']) expect({ kind, state: after[kind].state, parked: after[kind].data.parked ?? null }).toEqual({ kind, state: 'committed', parked: null });
        expect(committedSinceSeed(root).sort()).toEqual(TARGETS.map(slug => `${slug}.md`));
        expect(await embeddedPages(engine)).toEqual(TARGETS);
      }, { untracked: [W2] });
    }, 180_000);

    test('A-12 item: behind a mirror without a published list, Git commits a passed page whose file holds the mirror rendering and skips one that holds pre-withdrawal bytes', async () => {
      await withdrawalBrain(databaseUrl, async ({ engine, root, request }) => {
        const raw = readFileSync(join(root, `${W3}.md`));
        breakFile(root);
        await mirrorOnly(engine, request.id, 'failed');
        expect((await effectsOf(engine, request.id))['withdrawal-mirror'].data.published).toEqual([W1, W3]);
        // A mirror that failed before it recorded its publications.
        await engine.transaction(async tx => {
          await declarePersistenceProtocol(tx);
          await tx.executeRaw(`UPDATE persistence_effects SET data=data-'published' WHERE request_id=$1::uuid AND kind='withdrawal-mirror'`, [request.id]);
        });
        writeFileSync(join(root, `${W3}.md`), raw);
        await expectUnitNotAborted(() => drain(engine, 12));
        expect(committedActiveClaim(root)).toEqual([]);
        expect(committedSinceSeed(root)).toEqual([`${W1}.md`]);
        const git = (await effectsOf(engine, request.id)).git;
        expect({ state: git.state, skipped: git.data.skipped, parked: git.data.parked })
          .toEqual({ state: 'failed', skipped: [{ slug: W3, reason: 'withdrawal_not_mirrored' }], parked: [{ slug: W2, error_code: WITHHELD }] });
      }, { untracked: [W3] });
    }, 180_000);

    test('A-12 item: Git skips a page the mirror published whose file was reverted to its pre-withdrawal bytes', async () => {
      await withdrawalBrain(databaseUrl, async ({ engine, root, request }) => {
        const raw = readFileSync(join(root, `${W1}.md`));
        await mirrorOnly(engine, request.id, 'committed');
        expect((await effectsOf(engine, request.id))['withdrawal-mirror'].data.published).toEqual(TARGETS);
        writeFileSync(join(root, `${W1}.md`), raw);
        await expectUnitNotAborted(() => drain(engine, 12));
        expect(committedActiveClaim(root)).toEqual([]);
        expect(committedSinceSeed(root).sort()).toEqual([`${W2}.md`, `${W3}.md`]);
        const git = (await effectsOf(engine, request.id)).git;
        expect({ state: git.state, skipped: git.data.skipped }).toEqual({ state: 'committed', skipped: [{ slug: W1, reason: 'withdrawal_not_mirrored' }] });
      }, { untracked: [W1] });
    }, 180_000);

    test('A-12 item: the coalesced single-file Git claim commits a page behind a failed mirror only when the mirror committed it', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        const put = (slug: string) => submitPageMutation(ctx, { operation: 'put_page',
          params: { slug, request_id: randomUUID(), content: `---\ntype: note\ntitle: ${slug}\n---\n\nBody of ${slug}.\n` } });
        await put('notes/mirrored'); await put('notes/withheld');
        await disposePersistenceConsumer(engine);
        await passes(engine, ctx.config, 2);
        writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']);
        const git1 = await engine.executeRaw<{ id: string; request_id: string; slug: string; data: Record<string, unknown> }>(`SELECT e.id::text AS id,e.request_id::text AS request_id,r.slug,e.data
          FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='git' ORDER BY e.id`);
        await engine.transaction(async tx => {
          await declarePersistenceProtocol(tx);
          await tx.executeRaw(`UPDATE persistence_effects SET state='queued',attempts=0,execution_token=NULL,claim_expires_at=NULL,error_code=NULL,outcome=NULL,
            next_attempt_at=now() WHERE kind='git'`);
          for (const row of git1) {
            const page = { slug: row.slug, page_id: row.data.page_id, revision: randomUUID() };
            const data = row.slug === 'notes/mirrored'
              ? { version: 2, targets: [page, { slug: 'notes/zz-other', page_id: 0, revision: randomUUID() }], after_slug: 'notes/zz-other', parked: [{ slug: 'notes/zz-other', error_code: 'storage_error' }], published: [row.slug] }
              : { version: 2, targets: [page], after_slug: row.slug, parked: [{ slug: row.slug, error_code: 'storage_error' }] };
            await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id,state,error_code)
              SELECT request_id,'withdrawal-mirror',$2::text::jsonb,source_id,source_incarnation,worktree_id,'failed','targets_parked' FROM persistence_effects WHERE id=$1`,
            [row.id, JSON.stringify(data)]);
          }
        });
        await expectUnitNotAborted(() => runPersistenceEffects(engine, ctx.config, { hostId: localHostId(), limit: 1 }));
        const after = await engine.executeRaw<{ slug: string; state: string; error_code: string | null; attempts: number; parked: Array<{ slug: string; error_code: string }> | null }>(
          `SELECT r.slug,e.state,e.error_code,e.attempts,e.data->'parked' AS parked FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
            WHERE e.kind='git' ORDER BY r.slug`);
        expect(after.map(row => ({ slug: row.slug, state: row.state, attempts: Number(row.attempts) }))).toEqual([
          { slug: 'notes/mirrored', state: 'committed', attempts: 1 }, { slug: 'notes/withheld', state: 'failed', attempts: 1 }]);
        expectItemFailure(after[1].parked?.[0] && { key: after[1].parked[0].slug, code: after[1].parked[0].error_code }, { key: 'notes/withheld', code: WITHHELD });
        const log = git(root, 'log', '--name-only', '--pretty=format:');
        expect({ mirrored: log.includes('notes/mirrored.md'), withheld: log.includes('notes/withheld.md') }).toEqual({ mirrored: true, withheld: false });
      }, { databaseUrl });
    }, 180_000);

    for (const injected of runScopedErrors()) {
      test(`A-12 run: a run-scoped failure (${injected.name}) reading the mirror's committed targets parks nothing`, async () => {
        await withdrawalBrain(databaseUrl, async ({ engine, root, request }) => {
          breakFile(root);
          const original = engine.executeRaw;
          engine.executeRaw = (async function (this: BrainEngine, sql: string, params?: unknown[]) {
            if (/kind='withdrawal-mirror' AND \(state<>'committed'/.test(sql)) throw injected.error();
            return original.call(this, sql, params);
          }) as BrainEngine['executeRaw'];
          try { await expectUnitNotAborted(() => drain(engine, 12)); } finally { engine.executeRaw = original; }
          const effects = await effectsOf(engine, request.id);
          expect(effects['withdrawal-mirror'].state).toBe('failed');
          for (const kind of ['git', 'embedding']) expect({ kind, parked: effects[kind].data.parked ?? null }).toEqual({ kind, parked: null });
          expect({ state: effects.git.state, failures: effects.git.data.target_failures ?? null }).toEqual({ state: 'queued', failures: null });
          expect(committedSinceSeed(root)).toEqual([]);
        });
      }, 180_000);
    }
  });
}
