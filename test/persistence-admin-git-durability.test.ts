/**
 * #5182 / #5808: per-host Git-durability opt-in for managed worktrees.
 *
 * [R7i]  The policy resolver is tri-state and fail-closed: a recorded setting
 *        wins over the legacy hook probe in both directions, and an absent
 *        setting defers to the probe, whose failure is an error, not "durable".
 * [R7ii] `writer git-durability` is a real admin verb: it refuses an unclaimed
 *        source, names an unborn branch as unborn (not "detached HEAD"),
 *        requires the admin-intent handshake, records the setting on the
 *        binding, re-queues the Git effects skipped while durability was off
 *        and the worker then commits them; `--disable` wins over a hook.
 *        `--pat-file` refuses a readable token file before writing anything.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { PERSISTENCE_ADMIN_OPERATIONS } from '../src/core/persistence/admin-contract.ts';
import { parsePersistenceAdminArgs } from '../src/commands/persistence-admin.ts';
import { gitDurabilityPolicy, gitDurabilityState, planGitDurabilityCatchUp } from '../src/core/persistence/git-durability-policy.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { v232 } from '../src/core/schema-migrations/v232-persistence-git-durability.ts';
import { PERSISTENCE_GIT_DURABILITY_COLUMN_SQL, PERSISTENCE_SCHEMA_STATEMENTS } from '../src/core/persistence/schema.ts';
import { gitAsync } from './helpers/git-publication.ts';
import { withEnv } from './helpers/with-env.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';

let engine: PGLiteEngine;
const roots: string[] = [];
const config = { engine: 'pglite' as const, embedding_disabled: true };
const page = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body.trim(), timeline: '', frontmatter: {} });
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

/** Everything runs under a private GBRAIN_HOME so the host identity, the credential store and the file-transport flag are the test's own. */
async function isolated<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-git-durability-')); roots.push(home);
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
      GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => { await registerLocalWriter(engine, 'cli'); return run(home); });
  } finally { await disposePersistenceConsumer(engine); }
}

async function gitRoot(home: string, opts: { commit?: boolean; remote?: boolean } = {}): Promise<string> {
  const root = join(home, `root-${randomUUID().slice(0, 8)}`); mkdirSync(root);
  await gitAsync(root, 'init', '-q', '-b', 'main');
  await gitAsync(root, 'config', 'user.name', 'Example Writer');
  await gitAsync(root, 'config', 'user.email', 'writer@example.invalid');
  if (opts.commit !== false) {
    writeFileSync(join(root, 'initial.md'), 'Initial\n');
    await gitAsync(root, 'add', 'initial.md'); await gitAsync(root, 'commit', '-q', '-m', 'Initial');
  }
  if (opts.remote) {
    const remote = join(home, `remote-${randomUUID().slice(0, 8)}.git`); mkdirSync(remote);
    await gitAsync(remote, 'init', '-q', '--bare');
    await gitAsync(root, 'remote', 'add', 'origin', remote); await gitAsync(root, 'push', '-q', '-u', 'origin', 'main');
  }
  return root;
}

async function claimedSource(root: string) {
  const sourceId = `durability-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  const binding = await claimWorktree(engine, sourceId, root, localHostId());
  return { sourceId, binding };
}

/** A committed page write whose Git effect is queued (the persistence-effects fixture, minus the hook). */
async function committedWrite(root: string, sourceId: string, slug: string) {
  const binding = (await getWorktreeBinding(engine, sourceId, localHostId()))!;
  await engine.putPage(slug, page('Before'), { sourceId });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const file = join(root, `${slug}.md`); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
  const ctx: OperationContext = { engine, config, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', sourceId, binding.source_incarnation, slug);
  const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
    sourceIncarnation: binding.source_incarnation, slug, pageId: snapshot.page.id, requestId: randomUUID(),
    callerIntent: { content: 'After' }, intent: { content: 'After' }, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  const row = (await claimNextWrite(engine, localHostId()))!;
  expect(row.id).toBe(admitted.id);
  const result = await publishMutation(engine, row, { observedRevision: snapshot.revision, file: { path: file, root, content: 'After' },
    apply: async tx => { await tx.putPage(slug, page('After'), { sourceId }); return {}; } }, localHostId());
  expect(result.state).toBe('committed');
  return row.id;
}
async function gitOutcome(requestId: string) {
  const [row] = await engine.executeRaw<{ state: string; outcome: Record<string, unknown> | null; data: Record<string, unknown> }>(
    "SELECT state,outcome,data FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [requestId]);
  return row;
}
async function runEffects() {
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git'");
  await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 10 });
}

describe('[R7i] git durability policy is tri-state and fail-closed', () => {
  const probeCalls: string[] = [];
  const probe = (answer: boolean | Error) => async (root: string) => { probeCalls.push(root); if (answer instanceof Error) throw answer; return answer; };

  test('a recorded setting wins over the legacy hook probe in both directions, and the probe is not consulted', async () => {
    probeCalls.length = 0;
    expect(await gitDurabilityPolicy({ git_durability: 'enabled' }, '/srv/a', probe(false))).toEqual({ durable: true, source: 'binding' });
    expect(await gitDurabilityPolicy({ git_durability: 'disabled' }, '/srv/a', probe(true))).toEqual({ durable: false, source: 'binding' });
    expect(probeCalls).toEqual([]);
  });

  test('an absent setting defers to the probe, and a probe failure is an error rather than durable', async () => {
    expect(await gitDurabilityPolicy({ git_durability: null }, '/srv/b', probe(true))).toEqual({ durable: true, source: 'legacy_hook' });
    expect(await gitDurabilityPolicy(null, '/srv/b', probe(false))).toEqual({ durable: false, source: 'no_hook' });
    await expect(gitDurabilityPolicy(undefined, '/srv/b', probe(new Error('hooks dir unreadable')))).rejects.toThrow('hooks dir unreadable');
    expect(gitDurabilityState({ git_durability: 'enabled' })).toBe('on');
    expect(gitDurabilityState({ git_durability: 'disabled' })).toBe('off');
    expect(gitDurabilityState(null)).toBe('unknown');
  });

  test('the column is created by CREATE TABLE on a fresh brain and by v232 on an existing one, never by the replayed schema blob', async () => {
    const [column] = await engine.executeRaw<{ data_type: string; is_nullable: string }>(
      "SELECT data_type,is_nullable FROM information_schema.columns WHERE table_name='persistence_host_bindings' AND column_name='git_durability'");
    expect(column).toEqual({ data_type: 'text', is_nullable: 'YES' });
    expect(v232.sql).toBe(PERSISTENCE_GIT_DURABILITY_COLUMN_SQL);
    expect(v232.sqlFor?.postgres).toContain("lock_timeout = '2s'");
    expect(v232.idempotent).toBe(true);
    expect(await v232.verify!(engine)).toBe(true);
    expect(PERSISTENCE_SCHEMA_STATEMENTS.some(statement => statement.includes('ADD COLUMN IF NOT EXISTS git_durability'))).toBe(false);
    await expect(engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='maybe' WHERE false")).resolves.toBeDefined();
    const [{ ok }] = await engine.executeRaw<{ ok: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM information_schema.check_constraints WHERE check_clause LIKE '%git_durability%') AS ok`);
    expect(ok).toBe(true);
  });
});

describe('[R7ii] writer git-durability verb', () => {
  test('the verb is an admin operation with a CLI spelling, and its flags parse', () => {
    expect(PERSISTENCE_ADMIN_OPERATIONS).toContain('writer_git_durability');
    const parsed = parsePersistenceAdminArgs('writer', ['git-durability', 'notes', '--enable', '--dry-run', '--json']);
    expect(parsed).toMatchObject({ operation: 'writer_git_durability', params: { source_id: 'notes', enable: true, dry_run: true }, json: true });
    expect(parsePersistenceAdminArgs('writer', ['git-durability', 'notes', '--pat-file', '/tmp/token']).params.pat_file).toBe('/tmp/token');
    expect(() => parsePersistenceAdminArgs('writer', ['git-durability', 'notes', '--enable=yes'])).toThrow(/does not accept a value/);
  });

  test('an unclaimed source is refused with the claim as the next step; --enable and --disable together are refused', () => isolated(async () => {
    await expect(runPersistenceAdministration(engine, 'writer_git_durability', { source_id: `nobody-${randomUUID().slice(0, 6)}`, enable: true, dry_run: true }))
      .rejects.toMatchObject({ code: 'writer_registration_required' });
    await expect(runPersistenceAdministration(engine, 'writer_git_durability', { source_id: 'x', enable: true, disable: true, dry_run: true }))
      .rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('not both') });
    await expect(runPersistenceAdministration(engine, 'writer_git_durability', { source_id: 'x', dry_run: true }))
      .rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('--enable, --disable, or --pat-file') });
  }));

  test('an unborn branch is named as unborn, a detached HEAD as detached, and a plain directory as not a checkout', () => isolated(async home => {
    const unborn = await claimedSource(await gitRoot(home, { commit: false }));
    const refusal = await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: unborn.sourceId, enable: true, dry_run: true }).catch(error => error);
    expect(refusal).toMatchObject({ code: 'git_branch_unborn' });
    expect(refusal.message).toContain('unborn');
    expect(refusal.message).not.toContain('detached');
    expect(refusal.suggestion).toContain('git add -A && git commit');
    const detachedRoot = await gitRoot(home);
    await gitAsync(detachedRoot, 'checkout', '-q', '--detach');
    const detached = await claimedSource(detachedRoot);
    await expect(runPersistenceAdministration(engine, 'writer_git_durability', { source_id: detached.sourceId, enable: true, dry_run: true }))
      .rejects.toMatchObject({ code: 'git_detached_head' });
    const plain = join(home, 'plain'); mkdirSync(plain);
    const notGit = await claimedSource(plain);
    await expect(runPersistenceAdministration(engine, 'writer_git_durability', { source_id: notGit.sourceId, enable: true, dry_run: true }))
      .rejects.toMatchObject({ code: 'git_checkout_required' });
    // A refused preview recorded nothing.
    for (const { sourceId } of [unborn, detached, notGit]) expect((await getWorktreeBinding(engine, sourceId, localHostId()))!.git_durability).toBeNull();
  }));

  test('enable needs the admin-intent handshake, records the setting, re-queues skipped Git effects and the worker commits them', () => isolated(async home => {
    const root = await gitRoot(home, { remote: true });
    const { sourceId } = await claimedSource(root);
    // Without a hook and nothing recorded, a managed write's Git effect completes as skipped.
    const first = await committedWrite(root, sourceId, 'alpha');
    const second = await committedWrite(root, sourceId, 'beta');
    await runEffects();
    expect(await gitOutcome(first)).toMatchObject({ state: 'committed', outcome: { reason: 'durability_not_enabled' } });
    expect(await gitOutcome(second)).toMatchObject({ state: 'committed', outcome: { reason: 'durability_not_enabled' } });
    expect((await gitAsync(root, 'status', '--porcelain', '--', 'alpha.md', 'beta.md')).trim()).not.toBe('');

    const preview = await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: sourceId, enable: true, dry_run: true });
    expect(preview).toMatchObject({ dry_run: true, git_durability: { before: null, after: 'enabled' }, current_policy: { durable: false, source: 'no_hook' },
      branch: 'main', tracking_remote: 'origin', push_probe: { ok: true }, catch_up: { planned: 2 }, queued_catch_up: 0 });
    expect((preview.fix as { argv: string[] }).argv.join(' ')).toContain('--admin-intent writer_git_durability --expected-state ');
    expect((await getWorktreeBinding(engine, sourceId, localHostId()))!.git_durability).toBeNull();
    expect((await planGitDurabilityCatchUp(engine, (await getWorktreeBinding(engine, sourceId, localHostId()))!)).map(effect => effect.relative_path).sort()).toEqual(['alpha.md', 'beta.md']);

    await expect(runPersistenceAdministration(engine, 'writer_git_durability', { source_id: sourceId, enable: true }))
      .rejects.toMatchObject({ code: 'writer_admin_intent_required' });
    await expect(runPersistenceAdministration(engine, 'writer_git_durability', { source_id: sourceId, enable: true, admin_intent: 'writer_activate', expected_state: 'f'.repeat(64) }))
      .rejects.toMatchObject({ code: 'writer_admin_intent_required' });
    const stale = await reviewedWriterIntent(engine, 'writer_git_durability');
    const applied = await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: sourceId, enable: true, ...stale });
    expect(applied).toMatchObject({ applied: true, git_durability: { before: null, after: 'enabled' }, queued_catch_up: 2 });
    expect((await getWorktreeBinding(engine, sourceId, localHostId()))!.git_durability).toBe('enabled');
    expect(await gitOutcome(first)).toMatchObject({ state: 'queued', outcome: null, data: { durability_catch_up: 1 } });

    // The recorded setting is part of the admin state: the pre-apply fingerprint is stale now.
    await expect(runPersistenceAdministration(engine, 'writer_git_durability', { source_id: sourceId, disable: true, ...stale }))
      .rejects.toMatchObject({ code: 'writer_admin_state_changed' });
    const status = await runPersistenceAdministration(engine, 'writer_status', { source_id: sourceId }) as { bindings: Array<Record<string, unknown>> };
    expect(status.bindings.find(binding => binding.source_id === sourceId)).toMatchObject({ git_durability: 'enabled', git_durability_state: 'on' });

    // The worker runs the re-queued effects: both files are committed and pushed, with no hook anywhere.
    await runEffects();
    expect(await gitOutcome(first)).toMatchObject({ state: 'committed', outcome: { git: 'committed' } });
    expect(await gitOutcome(second)).toMatchObject({ state: 'committed', outcome: { git: 'committed' } });
    expect((await gitAsync(root, 'status', '--porcelain', '--', 'alpha.md', 'beta.md')).trim()).toBe('');
    expect(await gitAsync(root, 'ls-tree', '--name-only', 'origin/main')).toContain('alpha.md');
    expect(await gitAsync(root, 'ls-tree', '--name-only', 'origin/main')).toContain('beta.md');
    // Enabling again plans nothing: the caught-up effects are no longer skipped.
    const again = await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: sourceId, enable: true, dry_run: true });
    expect(again).toMatchObject({ catch_up: { planned: 0 }, why: expect.stringContaining('already as requested') });
  }), 120_000);

  test('--disable wins over a legacy hook: the next Git effect completes as skipped; --pat-file refuses a readable token file first', () => isolated(async home => {
    const root = await gitRoot(home);
    const hook = join(root, '.git', 'hooks', 'post-commit');
    writeFileSync(hook, '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n'); chmodSync(hook, 0o755);
    const { sourceId } = await claimedSource(root);
    expect(await gitDurabilityPolicy(await getWorktreeBinding(engine, sourceId, localHostId()), root)).toEqual({ durable: true, source: 'legacy_hook' });
    const disabled = await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: sourceId, disable: true, ...await reviewedWriterIntent(engine, 'writer_git_durability') });
    expect(disabled).toMatchObject({ applied: true, git_durability: { before: null, after: 'disabled' }, queued_catch_up: 0 });
    const request = await committedWrite(root, sourceId, 'gamma');
    await runEffects();
    expect(await gitOutcome(request)).toMatchObject({ state: 'committed', outcome: { reason: 'durability_not_enabled' } });
    expect(await gitAsync(root, 'log', '--oneline')).not.toContain('gamma');

    const token = join(home, 'token'); writeFileSync(token, 'ghp_exampletoken\n'); chmodSync(token, 0o644);
    const refusal = await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: sourceId, pat_file: token, dry_run: true }).catch(error => error);
    expect(refusal).toMatchObject({ code: 'pat_file_unreadable' });
    expect(refusal.message).not.toContain('ghp_exampletoken');
    expect(refusal.suggestion).toContain('chmod 600');
    expect((await gitAsync(root, 'config', '--local', '--get', 'credential.helper').catch(() => '')).trim()).toBe('');
    await expect(runPersistenceAdministration(engine, 'writer_git_durability', { source_id: sourceId, disable: true, pat_file: token, dry_run: true }))
      .rejects.toMatchObject({ code: 'invalid_params', message: expect.stringContaining('--pat-file cannot be combined with --disable') });
  }), 120_000);
});
