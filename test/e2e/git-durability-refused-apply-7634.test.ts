/**
 * #7634 on PostgreSQL: a refused `writer git-durability --enable --pat-file` apply (no approval, the wrong
 * intent, or a stale reviewed state) changes no file in the checkout, its .git config or the credential store,
 * and leaves the parked push and the binding as they were. The PGLite arm is in
 * test/persistence-admin-git-durability.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { gitAsync } from '../helpers/git-publication.ts';
import { withEnv } from '../helpers/with-env.ts';
import { reviewedWriterIntent } from '../helpers/writer-admin-intent.ts';

const run = process.env.DATABASE_URL ? test : test.skip;
let engine: PostgresEngine;
let close: (() => Promise<void>) | undefined;
const roots: string[] = [];
const config = { engine: 'postgres' as const, embedding_disabled: true };
const page = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL));
}, 120_000);
afterAll(async () => {
  if (engine) await disposePersistenceConsumer(engine);
  await close?.();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function treeBytes(dir: string, files: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) treeBytes(path, files);
    else files[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  return files;
}

async function parkedSource(home: string) {
  const root = join(home, 'root'); mkdirSync(root);
  const remote = join(home, 'remote.git'); mkdirSync(remote);
  await gitAsync(remote, 'init', '-q', '--bare');
  await gitAsync(root, 'init', '-q', '-b', 'main');
  await gitAsync(root, 'config', 'user.name', 'Example Writer');
  await gitAsync(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, 'AGENTS.md'), '# Operator instructions\n');
  await gitAsync(root, 'add', 'AGENTS.md'); await gitAsync(root, 'commit', '-q', '-m', 'Instructions');
  await gitAsync(root, 'remote', 'add', 'origin', remote); await gitAsync(root, 'push', '-q', '-u', 'origin', 'main');
  const sourceId = `durability-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  const binding = await claimWorktree(engine, sourceId, root, localHostId());
  const slug = 'parked7634';
  await engine.putPage(slug, page('Before'), { sourceId });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const file = join(root, `${slug}.md`);
  writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
  const ctx: OperationContext = { engine, config, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', sourceId, binding.source_incarnation, slug);
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
    sourceIncarnation: binding.source_incarnation, slug, pageId: snapshot.page.id, requestId: randomUUID(),
    callerIntent: { content: 'After' }, intent: { content: 'After' }, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
  const row = (await claimNextWrite(engine, localHostId()))!;
  const result = await publishMutation(engine, row, { observedRevision: snapshot.revision, file: { path: file, root, content: 'After' },
    apply: async tx => { await tx.putPage(slug, page('After'), { sourceId }); return {}; } }, localHostId());
  expect(result.state).toBe('committed');
  await engine.executeRaw(`UPDATE persistence_effects SET state='failed',error_code='targets_parked',data=data || $2::text::jsonb
    WHERE request_id=$1::uuid AND kind='git'`, [row.id, JSON.stringify({ parked: [{ slug, error_code: 'git_push_unavailable' }], target_failures: 5 })]);
  return { sourceId, requestId: row.id };
}

const gitEffect = async (requestId: string) => (await engine.executeRaw<Record<string, unknown>>(
  "SELECT state,error_code,attempts,data,outcome FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [requestId]))[0];

describe('#7634 a refused git-durability apply has no side effects (PostgreSQL)', () => {
  for (const refusal of ['missing', 'wrong', 'stale'] as const) {
    run(`${refusal} approval`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-durability-7634-')); roots.push(home);
      await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
        GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
        await registerLocalWriter(engine, 'cli');
        try {
          const { sourceId, requestId } = await parkedSource(home);
          const token = join(home, 'synthetic-token');
          writeFileSync(token, 'synthetic-test-only-token\n', { mode: 0o600 });
          const reviewed = await reviewedWriterIntent(engine, 'writer_git_durability');
          if (refusal === 'stale') await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [`other-${randomUUID().slice(0, 8)}`]);
          const params = { source_id: sourceId, enable: true, pat_file: token,
            ...(refusal === 'missing' ? {} : refusal === 'wrong' ? { ...reviewed, admin_intent: 'writer_activate' } : reviewed) };
          const before = treeBytes(home);
          const effect = await gitEffect(requestId);
          const error = await runPersistenceAdministration(engine, 'writer_git_durability', params).catch(caught => caught);
          expect(error).toMatchObject({ code: refusal === 'stale' ? 'writer_admin_state_changed' : 'writer_admin_intent_required' });
          expect(treeBytes(home)).toEqual(before);
          expect(await gitEffect(requestId)).toEqual(effect);
          expect((await getWorktreeBinding(engine, sourceId, localHostId()))!.git_durability).toBeNull();
        } finally { await disposePersistenceConsumer(engine); }
      });
    }, 120_000);
  }
});
