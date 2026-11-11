import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { publishMutation } from '../src/core/persistence/coordinator.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';

let engine: PGLiteEngine;
const roots: string[] = [];
const hostId = localHostId();
const page = (body: string) => ({ type: 'note', title: 'Example', compiled_truth: body, timeline: '', frontmatter: {} });
const config = { engine: 'pglite' as const, embedding_disabled: true };

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); await registerLocalWriter(engine, 'cli');
}, 120_000);
afterAll(async () => {
  installFaultHook(undefined);
  await engine.disconnect();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test('a Git target failure keeps its target and classified cause until it parks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-effect-8606-')); roots.push(root);
  const sourceId = `effect-${randomUUID()}`;
  const slug = 'notes/page';
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  const binding = await claimWorktree(engine, sourceId, root, hostId);
  await engine.putPage(slug, page('Before'), { sourceId });
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
  const file = join(root, `${slug}.md`); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'Before');
  const ctx: OperationContext = { engine, config, remote: false, dryRun: false, sourceId, logger: { info() {}, warn() {}, error() {} } };
  const authority = await submissionAuthority(ctx, 'put_page', sourceId, binding.source_incarnation, slug);
  const request = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId,
    sourceIncarnation: binding.source_incarnation, slug, pageId: snapshot.page.id, requestId: randomUUID(),
    callerIntent: { content: 'After' }, intent: { content: 'After' }, worktreeId: binding.worktree_id,
    topologyGeneration: binding.topology_generation });
  const claimed = (await claimNextWrite(engine, hostId))!;
  await publishMutation(engine, claimed, { observedRevision: snapshot.revision, file: { path: file, root, content: 'After' },
    apply: async tx => { await tx.putPage(slug, page('After'), { sourceId }); return {}; } }, hostId);
  await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour' WHERE request_id=$1::uuid AND kind<>'git'", [request.id]);
  installFaultHook(point => {
    if (point === 'effect:git:mid') throw Object.assign(new Error('target is not readable'), { code: 'EACCES' });
  });

  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE request_id=$1::uuid AND kind='git'", [request.id]);
      await runPersistenceEffects(engine, config, { hostId, limit: 1 });
    }
  } finally { installFaultHook(undefined); }

  const [effect] = await engine.executeRaw<{ state: string; error_code: string | null; data: Record<string, unknown> }>(
    "SELECT state,error_code,data FROM persistence_effects WHERE request_id=$1::uuid AND kind='git'", [request.id]);
  expect(effect).toMatchObject({ state: 'failed', error_code: 'targets_parked', data: {
    parked: [{ slug, error_code: 'unreadable_item' }],
  } });
});
