/**
 * #6678: `git-durability --pat-file` retries every parked push of the worktree.
 * Effects reference the internal journal id; the bulk retry joins the public
 * receipt id, selects each journal row by its internal id (two principals may
 * share one receipt id), and reports a request refused on its own in `refused`
 * with the same envelope in preview and apply (status `partial`).
 * #6697 (D6 option A): a revoked writer's parked Git effect previews as
 * `owner_revoked` instead of throwing, and the owner host may retry it once under
 * its own authority with the admin-intent handshake (`retried_under: owner_host`).
 * Withdrawal effects keep the strict original-authority rule.
 * Based on PR #6683 by @javieraldape.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { retryParkedPushes } from '../src/core/persistence/git-durability-administration.ts';
import { retryParkedEffects } from '../src/core/persistence/effect-retry.ts';
import { checkParkedEffects } from '../src/commands/doctor/checks/parked-effects.ts';
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

async function isolated<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parked-push-')); roots.push(home);
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
      GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => { await registerLocalWriter(engine, 'cli'); return run(home); });
  } finally { await disposePersistenceConsumer(engine); }
}

async function gitRoot(home: string): Promise<string> {
  const root = join(home, `root-${randomUUID().slice(0, 8)}`); mkdirSync(root);
  await gitAsync(root, 'init', '-q', '-b', 'main');
  await gitAsync(root, 'config', 'user.name', 'Example Writer');
  await gitAsync(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, 'initial.md'), 'Initial\n');
  await gitAsync(root, 'add', 'initial.md'); await gitAsync(root, 'commit', '-q', '-m', 'Initial');
  return root;
}

async function claimedSource(root: string) {
  const sourceId = `parked-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  const binding = await claimWorktree(engine, sourceId, root, localHostId());
  return { sourceId, binding };
}

/** A committed page write whose Git effect is queued (the persistence-effects fixture, minus the hook). */
async function committedWrite(root: string, sourceId: string, slug: string, opts: { requestId?: string; remote?: boolean } = {}) {
  const binding = (await getWorktreeBinding(engine, sourceId, localHostId()))!;
  await engine.putPage(slug, page('Before'), { sourceId });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const file = join(root, `${slug}.md`); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
  const ctx: OperationContext = { engine, config, remote: opts.remote === true, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', sourceId, binding.source_incarnation, slug);
  const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
    sourceIncarnation: binding.source_incarnation, slug, pageId: snapshot.page.id, requestId: opts.requestId ?? randomUUID(),
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
async function parked(root: string, sourceId: string, slug: string, opts: { requestId?: string; remote?: boolean } = {}, code = 'git_push_unavailable') {
  const id = await committedWrite(root, sourceId, slug, opts);
  await engine.executeRaw(`UPDATE persistence_effects SET state='failed',error_code='targets_parked',
    data=data || $2::text::jsonb WHERE request_id=$1::uuid AND kind='git'`,
  [id, JSON.stringify({ parked: [{ slug, error_code: code }], target_failures: 5 })]);
  return id;
}
async function publicId(id: string): Promise<string> {
  const [request] = await engine.executeRaw<{ request_id: string }>('SELECT request_id::text AS request_id FROM persistence_requests WHERE id=$1::uuid', [id]);
  return request.request_id;
}
async function revoke(id: string) {
  await engine.executeRaw(`UPDATE persistence_local_writers SET revoked_at=now()
    WHERE id=(SELECT principal_id::uuid FROM persistence_requests WHERE id=$1::uuid)`, [id]);
}

describe('#6678 credential repair retries parked Git pushes', () => {
  test('preview leaves effects parked, apply queues one retry, and other worktrees and causes stay untouched', () => isolated(async home => {
    const root = await gitRoot(home);
    const { sourceId, binding } = await claimedSource(root);
    const id = await parked(root, sourceId, 'push');
    expect(await publicId(id)).not.toBe(id);
    const otherCause = await parked(root, sourceId, 'ignored', {}, 'git_target_unsafe');
    const otherRoot = await gitRoot(home);
    const other = await claimedSource(otherRoot);
    const otherId = await parked(otherRoot, other.sourceId, 'foreign');
    const clean = { status: 'ok' as const, requests: 1, queued: 1, unchanged: 0, refused: [] };
    expect(await retryParkedPushes(engine, binding.worktree_id, true)).toEqual(clean);
    expect(await gitOutcome(id)).toMatchObject({ state: 'failed', data: { parked: [{ error_code: 'git_push_unavailable' }] } });
    expect(await retryParkedPushes(engine, binding.worktree_id, false)).toEqual(clean);
    expect(await gitOutcome(id)).toMatchObject({ state: 'queued', data: { retried: 1, target_failures: 4 } });
    expect((await gitOutcome(id)).data.parked).toBeUndefined();
    expect(await retryParkedPushes(engine, binding.worktree_id, false)).toEqual({ status: 'ok', requests: 0, queued: 0, unchanged: 0, refused: [] });
    for (const untouched of [otherCause, otherId]) expect(await gitOutcome(untouched)).toMatchObject({ state: 'failed' });
    await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled' WHERE worktree_id=$1::uuid", [binding.worktree_id]);
    await runEffects();
    expect(await gitOutcome(id)).toMatchObject({ state: 'committed', outcome: { git: 'committed' } });
    expect((await gitAsync(root, 'status', '--porcelain', '--', 'push.md')).trim()).toBe('');
  }), 120_000);

  test('distinct principals sharing one receipt ID both retry, while public-ID retry remains ambiguous', () => isolated(async home => {
    const root = await gitRoot(home);
    const { sourceId, binding } = await claimedSource(root);
    const requestId = randomUUID();
    const first = await parked(root, sourceId, 'cli', { requestId });
    await registerLocalWriter(engine, 'stdio');
    const second = await parked(root, sourceId, 'stdio', { requestId, remote: true });
    expect(first).not.toBe(second);
    expect(await retryParkedEffects(engine, sourceId, requestId, false)).toBeNull();
    expect(await retryParkedPushes(engine, binding.worktree_id, true)).toEqual({ status: 'ok', requests: 2, queued: 2, unchanged: 0, refused: [] });
    for (const id of [first, second]) expect(await gitOutcome(id)).toMatchObject({ state: 'failed' });
    expect(await retryParkedPushes(engine, binding.worktree_id, false)).toEqual({ status: 'ok', requests: 2, queued: 2, unchanged: 0, refused: [] });
    for (const id of [first, second]) expect(await gitOutcome(id)).toMatchObject({ state: 'queued', data: { retried: 1 } });
  }), 120_000);

  test('a revoked writer is refused on its own: the healthy push is queued, preview and apply list the same refusal, status partial', () => isolated(async home => {
    const root = await gitRoot(home);
    const { sourceId, binding } = await claimedSource(root);
    const revoked = await parked(root, sourceId, 'revoked');
    await registerLocalWriter(engine, 'cli', undefined, true);
    const healthy = await parked(root, sourceId, 'healthy');
    await revoke(revoked);
    const preview = await retryParkedPushes(engine, binding.worktree_id, true);
    expect(preview).toMatchObject({ status: 'partial', requests: 2, queued: 1, unchanged: 0 });
    expect(preview.refused).toEqual([expect.objectContaining({ source_id: sourceId, request_id: await publicId(revoked), code: 'permission_denied',
      message: expect.stringContaining('Git backup of revoked is incomplete'), fix: expect.objectContaining({ ask_user: true, user_message: expect.stringContaining('Git backup') }) })]);
    expect(preview.refused[0].fix!.argv).toEqual(expect.arrayContaining(['retry-effects', '--admin-intent', 'writer_retry_effects', '--expected-state']));
    const applied = await retryParkedPushes(engine, binding.worktree_id, false);
    expect(applied).toMatchObject({ status: 'partial', requests: 2, queued: 1, unchanged: 0 });
    expect(applied.refused).toEqual(preview.refused);
    expect(await gitOutcome(revoked)).toMatchObject({ state: 'failed', data: { target_failures: 5 } });
    expect(await gitOutcome(healthy)).toMatchObject({ state: 'queued', data: { retried: 1 } });
  }), 120_000);

  test('a foreign owner still stops the whole bulk retry without changing the parked effect', () => isolated(async home => {
    const root = await gitRoot(home);
    const { sourceId, binding } = await claimedSource(root);
    const id = await parked(root, sourceId, 'owner');
    await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [binding.worktree_id, randomUUID()]);
    await expect(retryParkedPushes(engine, binding.worktree_id, false)).rejects.toMatchObject({ code: 'owner_unavailable' });
    expect(await gitOutcome(id)).toMatchObject({ state: 'failed' });
  }), 120_000);
});

describe('#6697 revoked writer: parked Git effect', () => {
  test('the dry-run preview reports owner_revoked instead of throwing, and plain apply is refused', () => isolated(async home => {
    const root = await gitRoot(home);
    const { sourceId } = await claimedSource(root);
    const id = await parked(root, sourceId, 'revoked6697');
    const requestId = await publicId(id);
    await revoke(id);
    const preview = await retryParkedEffects(engine, sourceId, requestId, true);
    expect(preview).toMatchObject({ action: 'owner_revoked', authority: { ok: false, code: 'permission_denied' },
      effects: [{ kind: 'git', action: 'owner_revoked', state: 'parked' }], fix: { ask_user: true } });
    expect((preview!.fix as { user_message: string }).user_message).toContain('Git backup of revoked6697 is incomplete');
    await expect(runPersistenceAdministration(engine, 'writer_retry_effects', { source_id: sourceId, request_id: requestId }))
      .rejects.toMatchObject({ code: 'permission_denied' });
    expect(await gitOutcome(id)).toMatchObject({ state: 'failed', data: { target_failures: 5 } });
  }), 120_000);

  test('the owner host retries it once under owner authority with the admin-intent handshake', () => isolated(async home => {
    const root = await gitRoot(home);
    const { sourceId } = await claimedSource(root);
    const id = await parked(root, sourceId, 'owned6697');
    const requestId = await publicId(id);
    await revoke(id);
    await registerLocalWriter(engine, 'cli', undefined, true);
    await expect(runPersistenceAdministration(engine, 'writer_retry_effects', { source_id: sourceId, request_id: requestId, admin_intent: 'writer_retry_effects', expected_state: 'f'.repeat(64) }))
      .rejects.toMatchObject({ code: 'writer_admin_state_changed' });
    const preview = await runPersistenceAdministration(engine, 'writer_retry_effects', { source_id: sourceId, request_id: requestId, dry_run: true, admin_intent: 'writer_retry_effects' });
    expect(preview).toMatchObject({ effects: [{ action: 'would_retry', retried_under: 'owner_host' }] });
    expect(await gitOutcome(id)).toMatchObject({ state: 'failed' });
    const applied = await runPersistenceAdministration(engine, 'writer_retry_effects',
      { source_id: sourceId, request_id: requestId, ...await reviewedWriterIntent(engine, 'writer_retry_effects') });
    expect(applied).toMatchObject({ effects: [{ action: 'retry_queued', retried_under: 'owner_host' }] });
    expect(await gitOutcome(id)).toMatchObject({ state: 'queued', data: { retried: 1, retried_under: 'owner_host', retried_by_host: localHostId() } });
  }), 120_000);

  test('a withdrawal effect of a revoked writer keeps the strict rule even under owner approval', () => isolated(async home => {
    const root = await gitRoot(home);
    const { sourceId } = await claimedSource(root);
    const id = await parked(root, sourceId, 'withdrawn6697');
    const requestId = await publicId(id);
    await engine.executeRaw("UPDATE persistence_effects SET kind='withdrawal-mirror' WHERE request_id=$1::uuid AND kind='git'", [id]);
    await revoke(id);
    await registerLocalWriter(engine, 'cli', undefined, true);
    const applied = await runPersistenceAdministration(engine, 'writer_retry_effects',
      { source_id: sourceId, request_id: requestId, ...await reviewedWriterIntent(engine, 'writer_retry_effects') });
    expect(applied).toMatchObject({ action: 'owner_revoked', effects: [{ kind: 'withdrawal-mirror', action: 'owner_revoked' }], fix: { ask_user: true } });
    expect((applied.fix as { argv?: string[] }).argv).toBeUndefined();
    const [effect] = await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_effects WHERE request_id=$1::uuid AND kind='withdrawal-mirror'", [id]);
    expect(effect.state).toBe('failed');
  }), 120_000);

  test('doctor names the owner-authority exit for a revoked writer instead of the bare retry command', () => isolated(async home => {
    const root = await gitRoot(home);
    const { sourceId } = await claimedSource(root);
    const revoked = await parked(root, sourceId, 'doctor-revoked');
    await registerLocalWriter(engine, 'cli', undefined, true);
    const healthy = await parked(root, sourceId, 'doctor-healthy');
    await revoke(revoked);
    const check = await checkParkedEffects(engine, [sourceId]);
    const effects = (check.details as { effects: Array<Record<string, unknown>> }).effects;
    const byRequest = Object.fromEntries(effects.map(effect => [effect.request_id as string, effect]));
    expect(byRequest[await publicId(revoked)]).toMatchObject({ owner_revoked: expect.any(String), exit: expect.stringContaining('--admin-intent writer_retry_effects') });
    expect(byRequest[await publicId(healthy)].exit).toBeUndefined();
    expect(check.status).toBe('warn');
    expect(check.message).toContain(`doctor-revoked (git_push_unavailable); the original writer is revoked`);
    expect(check.message).toContain(`doctor-healthy (git_push_unavailable); gbrain sources writer retry-effects ${sourceId} --request-id ${await publicId(healthy)} --dry-run`);
  }), 120_000);
});

describe('#6665 doctor parked_effects', () => {
  test('names the fix for a parked git_target_pending target', () => isolated(async home => {
    const root = await gitRoot(home);
    const { sourceId } = await claimedSource(root);
    await parked(root, sourceId, 'gone', {}, 'git_target_pending');
    const check = await checkParkedEffects(engine, [sourceId]);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gone (git_target_pending)');
    expect(check.message).toContain('git -c core.fscache=false status');
  }), 120_000);
});
