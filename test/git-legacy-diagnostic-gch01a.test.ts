/**
 * GCH-01a: a Git diagnostic an older build stored with git's own error line (`last_error.line`) never prints and is
 * never written again.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every output that lists a held Git effect's targets (`gbrain sources writer retry-effects --dry-run` and
 *    its real run, doctor `parked_effects`, the `settle-effects` preview) shows each stored diagnostic in the fixed
 *    shape `{phase, step, reason, identity?}` (git-diagnostic.ts storedGitDiagnostic), and every rewrite of the effect
 *    (the retry's requeue, the next park) stores that shape, never the stored line.
 *  - Regression: a token, a private key path or a URL password from a stored line printed in JSON or kept in the row.
 *  - Why existing coverage misses it: slice 4 pinned only the `sync status` holds; these outputs print the stored
 *    entries as they are, and the retry and park paths spread the stored data into the new row.
 *  - Seam: none. A real journal and effect runner on PGLite and Postgres over a claimed worktree on a real repository.
 *    The legacy shape is seeded into the effect row, as the build from a514a9a10a wrote it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { retryParkedEffects } from '../src/core/persistence/effect-retry.ts';
import { settleEffects } from '../src/core/persistence/effect-settle.ts';
import { checkParkedEffects } from '../src/commands/doctor/checks/parked-effects.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { gitAsync } from './helpers/git-publication.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

/** The leak inputs of GCH-01 (test/git-commit-holds.test.ts LEAKS): a live key, a private key path, a URL password. */
const LEGACY_PARKED = { line: 'error: filter failed: sk_live_8fJ2kQ9xZ7vP3mN1 reading /home/alice-example/.ssh/id_ed25519', step: 'add', phase: 'commit' };
const LEGACY_LAST = { line: 'fatal: unable to access https://bob:pa/ss@example.com/repo', step: 'push', phase: 'push' };
/** A legacy entry whose step and reason are themselves free text: both fall back to the fixed names. */
const LEGACY_ODD = { line: 'x', step: 'sk_live_8fJ2kQ9xZ7vP3mN1', reason: 'https://bob:pa/ss@example.com/repo', phase: 'commit' };
const LEAK = /sk_live_|alice-example|id_ed25519|\.ssh|bob:|pa\/ss|example\.com|"line"/;
const SLUG = 'notes/lee-example';

for (const kind of testBackends()) {
  describe(`GCH-01a ${kind}: a stored git line never prints and is never written again`, () => {
    let engine: BrainEngine;
    let home: string;
    let close: (() => Promise<void>) | undefined;
    const config = { engine: kind, embedding_disabled: true } as const;
    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'gbrain-gch01a-'));
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    }, 120_000);
    afterAll(async () => {
      await disposePersistenceConsumer(engine); await engine.disconnect(); if (close) await close();
      rmSync(home, { recursive: true, force: true });
    });
    const isolated = (fn: () => Promise<void>) => () => withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined,
      GBRAIN_DATABASE_URL: undefined, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', GBRAIN_BACKUP_CHECK: '0' }, fn);

    /** A claimed, durable worktree whose .gitignore covers notes/, so the page's Git effect parks git_target_ignored when it runs. */
    async function claimedRepo() {
      await registerLocalWriter(engine, 'cli');
      const root = join(home, `brain-${randomUUID().slice(0, 8)}`); mkdirSync(root);
      await gitAsync(root, 'init', '-q', '-b', 'main');
      await gitAsync(root, 'config', 'user.name', 'Example Writer'); await gitAsync(root, 'config', 'user.email', 'writer@example.invalid');
      writeFileSync(join(root, '.gitignore'), 'notes/\n');
      await gitAsync(root, 'add', '-A'); await gitAsync(root, 'commit', '-q', '-m', 'Initial');
      const sourceId = `gch01a-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      const binding = await claimWorktree(engine, sourceId, root, localHostId());
      await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled' WHERE worktree_id=$1::uuid", [binding.worktree_id]);
      return { root, sourceId };
    }

    /** A committed page write whose Git effect is parked with the legacy diagnostic shape seeded into its row. */
    async function legacyParked(root: string, sourceId: string) {
      const binding = (await getWorktreeBinding(engine, sourceId, localHostId()))!;
      const page = (body: string) => ({ type: 'note', title: 'Lee Example', compiled_truth: body, timeline: '', frontmatter: {} });
      await engine.putPage(SLUG, page('Before'), { sourceId });
      const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId }))!;
      const file = join(root, `${SLUG}.md`); mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
      const ctx: OperationContext = { engine, config, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
      const authority = await submissionAuthority(ctx, 'put_page', sourceId, binding.source_incarnation, SLUG);
      const requestId = randomUUID();
      await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
        sourceIncarnation: binding.source_incarnation, slug: SLUG, pageId: snapshot.page.id, requestId,
        callerIntent: { content: 'After' }, intent: { content: 'After' }, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
      const row = (await claimNextWrite(engine, localHostId()))!;
      const result = await publishMutation(engine, row, { observedRevision: snapshot.revision, file: { path: file, root, content: 'After' },
        apply: async tx => { await tx.putPage(SLUG, page('After'), { sourceId }); return {}; } }, localHostId());
      expect(result.state).toBe('committed');
      await engine.executeRaw(`UPDATE persistence_effects SET state='failed',error_code='targets_parked',data=data || $2::text::jsonb
        WHERE request_id=$1::uuid AND kind='git'`, [row.id, JSON.stringify({ target_failures: 5, last_error: LEGACY_LAST,
        parked: [{ slug: SLUG, error_code: 'git_unavailable', last_error: LEGACY_PARKED }, { slug: 'notes/odd-example', error_code: 'git_unavailable', last_error: LEGACY_ODD }] })]);
      return { id: row.id, requestId };
    }
    const data = async (id: string) => (await engine.executeRaw<{ state: string; error_code: string | null; data: Record<string, unknown> }>(
      "SELECT state,error_code,data FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [id]))[0]!;
    const fixed = { parked: { phase: 'commit', step: 'add', reason: 'other' }, odd: { phase: 'commit', step: 'git', reason: 'other' }, last: { phase: 'push', step: 'push', reason: 'other' } };

    test('retry-effects --dry-run prints each target\'s diagnostic in the fixed shape and writes nothing', isolated(async () => {
      const { root, sourceId } = await claimedRepo();
      const w = await legacyParked(root, sourceId);
      const preview = await retryParkedEffects(engine, sourceId, w.requestId, true);
      const [entry] = (preview!.effects as Array<{ targets: Array<{ slug: string; last_error?: unknown }> }>);
      expect(entry!.targets.map(target => target.last_error)).toEqual([fixed.parked, fixed.odd]);
      expect(JSON.stringify(preview)).not.toMatch(LEAK);
      // A preview writes nothing: the seeded row is as it was.
      expect(JSON.stringify((await data(w.id)).data)).toMatch(/sk_live_/);
    }), 120_000);

    test('doctor parked_effects lists each target\'s diagnostic in the fixed shape', isolated(async () => {
      const { root, sourceId } = await claimedRepo();
      await legacyParked(root, sourceId);
      const doctor = await checkParkedEffects(engine, [sourceId]);
      const listed = (doctor.details!.effects as Array<{ parked: Array<{ last_error?: unknown }> }>)[0]!;
      expect(listed.parked.map(target => target.last_error)).toEqual([fixed.parked, fixed.odd]);
      expect(JSON.stringify(doctor)).not.toMatch(LEAK);
    }), 120_000);

    test('the settle-effects preview lists each target\'s diagnostic in the fixed shape', isolated(async () => {
      const { root, sourceId } = await claimedRepo();
      const w = await legacyParked(root, sourceId);
      const settle = await settleEffects(engine, { sourceId, requestId: w.requestId });
      expect(settle.effects[0]!.targets.map(target => (target as { last_error?: unknown }).last_error)).toEqual([fixed.parked, fixed.odd]);
      expect(JSON.stringify(settle)).not.toMatch(LEAK);
    }), 120_000);

    test('the retry\'s requeue stores the fixed shape, not the stored line', isolated(async () => {
      const { root, sourceId } = await claimedRepo();
      const w = await legacyParked(root, sourceId);
      const retried = await retryParkedEffects(engine, sourceId, w.requestId, false);
      const queued = await data(w.id);
      expect(queued.state).toBe('queued');
      expect(JSON.stringify(queued.data)).not.toMatch(LEAK);
      expect(queued.data.last_error).toEqual(fixed.last);
      expect(JSON.stringify(retried)).not.toMatch(LEAK);
    }), 120_000);

    test('the next park of an effect that carries the stored shape stores the fixed shape', isolated(async () => {
      const { root, sourceId } = await claimedRepo();
      const w = await legacyParked(root, sourceId);
      // The retry is the authorized way to queue it again; the seed below puts the old shape back on the queued row.
      await retryParkedEffects(engine, sourceId, w.requestId, false);
      // A target another build parked with the old shape rides on the queued effect; the next park carries it forward.
      await engine.executeRaw(`UPDATE persistence_effects SET data=data || $2::text::jsonb WHERE request_id=$1::uuid AND kind='git'`,
        [w.id, JSON.stringify({ last_error: LEGACY_LAST, parked: [{ slug: 'notes/odd-example', error_code: 'git_unavailable', last_error: LEGACY_PARKED }] })]);
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git'");
      await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 10 });
      const parked = await data(w.id);
      expect(parked).toMatchObject({ state: 'failed', error_code: 'targets_parked' });
      const entries = parked.data.parked as Array<{ slug: string; error_code: string; last_error?: unknown }>;
      expect(entries.map(target => [target.slug, target.error_code, target.last_error ?? null]))
        .toEqual([['notes/odd-example', 'git_unavailable', fixed.parked], [SLUG, 'git_target_ignored', null]]);
      expect(JSON.stringify(parked.data)).not.toMatch(LEAK);
    }), 120_000);
  });
}
