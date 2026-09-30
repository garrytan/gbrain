import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer, startPersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { withEnv } from './helpers/with-env.ts';

// #5601: an atom batch the owner accepted but has not published yet is
// progress. extract_atoms reports it as pending, counts no failure and no
// halt, and the next run resumes the same batch without paying again.

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-atoms-pending-'));
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); resetGateway(); rmSync(home, { recursive: true, force: true }); });

test('#5601: extract_atoms with a slow owner reports accepted-pending, not failed, and resumes without a second model call', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const sourceId = 'atoms-pending';
  const root = join(home, 'repo'); mkdirSync(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await engine.putPage('notes/2026-01-01-example', { type: 'source', title: 'Example', compiled_truth: 'A durable project record. '.repeat(40) }, { sourceId });
  const page = (await engine.getPage('notes/2026-01-01-example', { sourceId }))!;
  await registerLocalWriter(engine, 'cli');
  const binding = await claimWorktree(engine, sourceId, root);
  await engine.setConfig('sync.write_through', 'true');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  let calls = 0;
  const chat = async (): Promise<ChatResult> => {
    calls++;
    // The owner stalls after admission: the batch is accepted and stays queued.
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding.worktree_id]);
    return { text: '[{"title":"Measured progress","atom_type":"insight","body":"Measure progress against clear exit criteria."}]',
      blocks: [], stopReason: 'end', usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  const run = () => runPhaseExtractAtoms(engine, { sourceId, _chat: chat, _transcripts: [], _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }] });
  const first = await run();
  expect(first.status).toBe('ok');
  expect(first.details).toMatchObject({ write_pending: 1, failures: [] });
  const [rollup] = await engine.executeRaw<{ halts: number }>("SELECT COALESCE(sum(halt_count),0)::int AS halts FROM extract_rollup_7d WHERE kind='atoms' AND source_id=$1", [sourceId]);
  expect(rollup.halts).toBe(0);
  const queued = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='queued'", [sourceId]);
  expect(queued.length).toBeGreaterThan(0);
  await disposePersistenceConsumer(engine);
  await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [binding.worktree_id]);
  startPersistenceConsumer(engine, { engine: engine.kind });
  for (const row of queued) expect((await waitForWrite(engine, row, { engine: engine.kind }, 20_000)).state).toBe('committed');
  const second = await run();
  expect(second.details).toMatchObject({ duplicates_skipped: 1, failures: [] });
  expect(calls).toBe(1);
}), 90_000);
