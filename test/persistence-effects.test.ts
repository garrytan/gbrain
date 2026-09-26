import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree, prepareWriterTransfer } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, completeWrite, getWriteRequestById } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { prepareFileTarget } from '../src/core/persistence/page-prepare.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { publicEffectsForRequest } from '../src/core/persistence/effect-journal.ts';
import { publishGitEffect } from '../src/core/persistence/effect-git.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { parseFactsFence, upsertFactRow } from '../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { durableGitRepo } from './helpers/git-publication.ts';

let engine: PGLiteEngine;
const roots: string[] = [];
const hostId = localHostId();
const page = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body.trim(), timeline: '', frontmatter: {} });
const config = { engine: 'pglite' as const, embedding_disabled: true };
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); await registerLocalWriter(engine, 'cli');
}, 120_000);
afterAll(async () => { await engine.disconnect(); for (const root of roots) rmSync(root, { recursive: true, force: true }); });

async function fixture(body = 'Before', slug = 'page') {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-effects-')); roots.push(root);
  const sourceId = `effects-${randomUUID()}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  const binding = await claimWorktree(engine, sourceId, root, hostId);
  await engine.putPage(slug, page(body), { sourceId });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const file = join(root, `${slug}.md`); mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
  const ctx: OperationContext = { engine, config, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', sourceId, binding.source_incarnation, slug);
  return { root, file, sourceId, binding, snapshot, authority, slug };
}
async function admit(f: Awaited<ReturnType<typeof fixture>>) {
  return admitWrite(engine, { principal: f.authority.principal, authority: f.authority, operation: 'put_page', sourceId: f.sourceId,
    sourceIncarnation: f.binding.source_incarnation, slug: f.slug, pageId: f.snapshot.page.id, requestId: randomUUID(),
    callerIntent: { content: 'After' }, intent: { content: 'After' }, worktreeId: f.binding.worktree_id, topologyGeneration: f.binding.topology_generation });
}
async function withdraw(f: Awaited<ReturnType<typeof fixture>>) {
  const row = await admit(f);
  const [fact] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,source,visibility)
    VALUES($1,$2,'Withdraw this claim','test conversation','world') RETURNING id`, [f.sourceId, f.slug]);
  await engine.transaction(async tx => {
    await recordFactWithdrawal(tx, Number(fact.id), f.sourceId, false, { requestId: row.id });
    await completeWrite(tx, row, 'committed', { status: 'forgotten' });
  });
  return row;
}
async function onlyEffects(id: string) {
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE request_id<>$1::uuid", [id]);
  await engine.executeRaw('UPDATE persistence_effects SET next_attempt_at=now() WHERE request_id=$1::uuid', [id]);
}
const body = () => upsertFactRow('Stable prose', { claim: 'Withdraw this claim', kind: 'fact', visibility: 'world', confidence: 1, notability: 'medium' }).body;

test('canonical commit atomically records bounded Git/embedding debt, and rollback records none', async () => {
  const f = await fixture(); const admitted = await admit(f); const row = (await claimNextWrite(engine, hostId))!;
  expect(row.id).toBe(admitted.id);
  const result = await publishMutation(engine, row, { observedRevision: f.snapshot.revision, file: { path: f.file, root: f.root, content: 'After' },
    apply: async tx => { await tx.putPage('page', page('After'), { sourceId: f.sourceId }); return {}; } }, hostId);
  expect(result.state).toBe('committed');
  expect(await publicEffectsForRequest(engine, row.id)).toEqual([{ kind: 'embedding', state: 'queued' }, { kind: 'git', state: 'queued' }]);
  await onlyEffects(row.id); await runPersistenceEffects(engine, config, { hostId, limit: 2 });
  expect((await getWriteRequestById(engine, row.id))!.state).toBe('committed');
  const git = await engine.executeRaw<{ outcome: unknown }>("SELECT outcome FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [row.id]);
  expect(git[0].outcome).toMatchObject({ reason: 'durability_not_enabled' });
  const failed = await fixture(); const pending = await admit(failed); const attempt = (await claimNextWrite(engine, hostId))!;
  expect(attempt.id).toBe(pending.id);
  const original = readFileSync(failed.file, 'utf8');
  await publishMutation(engine, attempt, { observedRevision: failed.snapshot.revision,
    file: { path: failed.file, root: failed.root, content: 'Uncommitted' },
    apply: async tx => { await tx.putPage('page', page('Uncommitted'), { sourceId: failed.sourceId }); return {}; } }, hostId,
  { boundary: async name => { if (name === 'before_commit') throw new Error('rollback'); } });
  expect(readFileSync(failed.file, 'utf8')).toBe(original);
  expect(await publicEffectsForRequest(engine, attempt.id)).toEqual([]);
  const reset = (await getWriteRequestById(engine, attempt.id))!;
  await engine.transaction(tx => completeWrite(tx, reset, 'cancelled', {}));
});

test('withdrawal crash after rename recovers forward without changing canonical revision or receipt', async () => {
  const f = await fixture(body()); const row = await withdraw(f); await onlyEffects(row.id);
  const logical = (await engine.readPageSnapshot('page', { sourceId: f.sourceId }))!;
  await prepareFileTarget(engine, row, logical, serializePageToMarkdown(logical.page, logical.tags), hostId);
  expect(parseFactsFence(logical.page.compiled_truth).facts.filter(fact => fact.active)).toHaveLength(0);
  expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE request_id=$1::uuid', [row.id])).toHaveLength(3);
  let injected = false;
  await runPersistenceEffects(engine, config, { hostId, limit: 1, boundary: async name => {
    if (name === 'after_mirror_file') { injected = true; throw new Error('process ended before commit'); }
  } });
  expect(injected).toBe(true);
  expect((await publicEffectsForRequest(engine, row.id)).find(effect => effect.kind === 'withdrawal-mirror')!.state).toBe('recovering');
  const published = readFileSync(f.file, 'utf8');
  expect(parseFactsFence(published).facts.filter(fact => fact.active)).toHaveLength(0);
  expect((await getWriteRequestById(engine, row.id))!.state).toBe('committed');
  await onlyEffects(row.id); await runPersistenceEffects(engine, config, { hostId, limit: 1 });
  expect((await engine.readPageSnapshot('page', { sourceId: f.sourceId }))!.revision).toBe(logical.revision);
  expect(readFileSync(f.file, 'utf8')).toBe(published);
  expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE request_id=$1::uuid AND recovery IS NOT NULL', [row.id])).toHaveLength(0);
  expect(Number((await engine.executeRaw<{ recovery_bytes: string }>('SELECT recovery_bytes FROM persistence_counters WHERE key=$1', [`worktree:${f.binding.worktree_id}`]))[0].recovery_bytes)).toBe(0);
});

test('unexpected mirror bytes retain recovery, block this root and transfer, and allow another root', async () => {
  const f = await fixture(body()); const row = await withdraw(f); await onlyEffects(row.id);
  await runPersistenceEffects(engine, config, { hostId, limit: 1, boundary: async name => { if (name === 'after_mirror_file') throw new Error('crash'); } });
  writeFileSync(f.file, 'Uncoordinated external edit');
  await onlyEffects(row.id); await runPersistenceEffects(engine, config, { hostId, limit: 1 });
  expect(readFileSync(f.file, 'utf8')).toBe('Uncoordinated external edit');
  await expect(prepareWriterTransfer(engine, f.sourceId, hostId)).rejects.toMatchObject({ code: 'recovery_required' });
  const blocked = await admit(f);
  const other = await fixture(); const available = await admit(other);
  const claimed = (await claimNextWrite(engine, hostId))!;
  expect(claimed.id).toBe(available.id);
  await engine.transaction(tx => completeWrite(tx, claimed, 'cancelled', {}));
  await engine.transaction(tx => completeWrite(tx, blocked, 'cancelled', {}));
});

test('missing withdrawal files materialize and advance mirror and Git scans without resurrection', async () => {
  const f = await fixture(body());
  await engine.putPage('z-later', page(body()), { sourceId: f.sourceId });
  const later = (await engine.readPageSnapshot('z-later', { sourceId: f.sourceId }))!;
  const laterFile = join(f.root, 'z-later.md'); writeFileSync(laterFile, serializePageToMarkdown(later.page, later.tags));
  const row = await withdraw(f); await onlyEffects(row.id); rmSync(f.file);
  const logical = (await engine.readPageSnapshot('page', { sourceId: f.sourceId }))!;
  // Ordinary edits still refuse this unimported deletion.
  await expect(prepareFileTarget(engine, row, logical, 'Replacement', hostId)).rejects.toMatchObject({ code: 'source_changed' });
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE request_id=$1::uuid AND kind<>'withdrawal-mirror'", [row.id]);
  await runPersistenceEffects(engine, config, { hostId, limit: 3 });
  expect(existsSync(f.file)).toBe(false);
  expect((await publicEffectsForRequest(engine, row.id)).find(effect => effect.kind === 'withdrawal-mirror')!.state).toBe('committed');
  const [raw] = await engine.executeRaw<{ compiled_truth: string; knowledge_revision: string }>('SELECT compiled_truth,knowledge_revision FROM pages WHERE id=$1', [logical.page.id]);
  expect(raw.compiled_truth).toBe(logical.page.compiled_truth); expect(raw.knowledge_revision).toBe(logical.revision);
  expect(parseFactsFence(readFileSync(laterFile, 'utf8')).facts.filter(fact => fact.active)).toHaveLength(0);
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE request_id=$1::uuid AND kind='git'", [row.id]);
  await runPersistenceEffects(engine, config, { hostId, limit: 1 });
  const [git] = await engine.executeRaw<{ data: { after_slug: string }; error_code: string | null }>("SELECT data,error_code FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [row.id]);
  expect(git.data.after_slug).toBe('page'); expect(git.error_code).toBeNull(); expect(existsSync(f.file)).toBe(false);
  expect((await getWriteRequestById(engine, row.id))!.state).toBe('committed');
});

test('withdrawal redacts a present db_only cache file and keeps it out of a durable Git worktree', async () => {
  const f = await fixture(body(), 'conversations/page');
  writeFileSync(join(f.root, 'gbrain.yml'), 'storage:\n  db_only:\n    - conversations/\n');
  writeFileSync(join(f.root, '.gitignore'), 'conversations/\n');
  durableGitRepo(f.root, ['.gitignore', 'gbrain.yml']);
  const row = await withdraw(f); await onlyEffects(row.id);
  await runPersistenceEffects(engine, config, { hostId, limit: 10 });
  expect(parseFactsFence(readFileSync(f.file, 'utf8')).facts.filter(fact => fact.active)).toHaveLength(0);
  expect(await engine.executeRaw("SELECT kind,state,error_code FROM persistence_effects WHERE request_id=$1::uuid AND kind<>'embedding' ORDER BY kind", [row.id])).toEqual([
    { kind: 'git', state: 'committed', error_code: null },
    { kind: 'withdrawal-mirror', state: 'committed', error_code: null }]);
  expect(git(f.root, ['log', '--name-only', '--pretty=format:'])).not.toContain('conversations');
});

test('configured recovery capacity refuses file mutation without undoing withdrawal', async () => {
  const f = await fixture(body()); const original = readFileSync(f.file, 'utf8'); const row = await withdraw(f); await onlyEffects(row.id);
  await engine.setConfig('persistence.limits.worktree_recovery_bytes', '1');
  try { await runPersistenceEffects(engine, config, { hostId, limit: 1 }); }
  finally { await engine.executeRaw("DELETE FROM config WHERE key='persistence.limits.worktree_recovery_bytes'"); }
  expect(readFileSync(f.file, 'utf8')).toBe(original);
  expect((await getWriteRequestById(engine, row.id))!.state).toBe('committed');
  expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE request_id=$1::uuid AND recovery IS NOT NULL', [row.id])).toHaveLength(0);
  expect((await publicEffectsForRequest(engine, row.id)).find(effect => effect.kind === 'withdrawal-mirror')).toMatchObject({ reason: 'request_too_large' });
});

test('late embedding cannot replace vectors after a canonical revision changes', async () => {
  const f = await fixture(); const a = await admit(f); const row = (await claimNextWrite(engine, hostId))!;
  expect(row.id).toBe(a.id);
  await publishMutation(engine, row, { observedRevision: f.snapshot.revision, apply: async tx => {
    await tx.putPage('page', page('Current'), { sourceId: f.sourceId }); return {};
  } }, hostId);
  const prepared = (await readProjectionSnapshot(engine, 'page', f.sourceId, { allowUnsealed: true }))!;
  const snapshot = prepared.snapshot;
  await installPageProjection(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'Current' }], { seal: true });
  await onlyEffects(row.id);
  let calls = 0;
  await runPersistenceEffects(engine, { engine: 'pglite' }, { hostId, limit: 1, embedding: { signature: 'test:1536', model: 'test', embed: async () => {
    calls++; await engine.putPage('page', page('Newer'), { sourceId: f.sourceId });
    return [new Float32Array(1536).fill(0.1)];
  } } });
  expect(calls).toBe(1);
  expect((await engine.readPageSnapshot('page', { sourceId: f.sourceId }))!.page.compiled_truth).toBe('Newer');
  expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1 AND embedding IS NOT NULL', [snapshot.page.id])).toHaveLength(0);
});

function git(root: string, args: string[]) {
  const result = Bun.spawnSync(['git', '-C', root, ...args]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
test('Git retry disables legacy hooks, preserves unrelated staging and never rebases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-effects-git-')); roots.push(root);
  git(root, ['init']); git(root, ['config', 'user.name', 'Example Writer']); git(root, ['config', 'user.email', 'writer@example.invalid']);
  writeFileSync(join(root, 'page.md'), 'Before'); git(root, ['add', 'page.md']); git(root, ['commit', '-m', 'Initial']);
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  const hook = join(root, '.git', 'hooks', 'post-commit');
  writeFileSync(hook, '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\ntouch forbidden-hook-ran\n'); chmodSync(hook, 0o755);
  writeFileSync(join(root, 'unrelated.md'), 'Unrelated'); git(root, ['add', 'unrelated.md']);
  writeFileSync(join(root, 'page.md'), 'After');
  expect(await publishGitEffect(root, 'page.md')).toMatchObject({ git: 'committed', push: 'skipped', reason: 'no_tracking_remote' });
  const head = git(root, ['rev-parse', 'HEAD']);
  expect(git(root, ['show', '--pretty=format:', '--name-only', 'HEAD'])).toBe('page.md');
  expect(git(root, ['diff', '--cached', '--name-only'])).toBe('unrelated.md');
  expect(existsSync(join(root, 'forbidden-hook-ran'))).toBe(false);
  expect(await publishGitEffect(root, 'page.md')).toMatchObject({ git: 'unchanged' });
  expect(git(root, ['rev-parse', 'HEAD'])).toBe(head);
});
