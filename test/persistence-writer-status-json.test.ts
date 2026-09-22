import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';

// `gbrain sources writer status [--json]` prints its result with
// JSON.stringify. persistence_worktrees.owner_epoch and
// persistence_source_bindings.topology_generation are BIGINT; the Postgres
// driver returns those as BigInt, which JSON.stringify refuses ("cannot
// serialize BigInt"). PGLite returns numbers, so the crash only showed on
// Postgres brains. The bindings query must cast them to text on every engine,
// exactly as the worktree diagnostics query already does.
let engine: PGLiteEngine;
let home: string;
const sourceId = 'writer-status-json';
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-writer-status-json-')));
  const root = join(home, 'source'); mkdirSync(root);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await claimWorktree(engine, sourceId, root);
});
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('writer_status is JSON-serializable and reports epoch/generation as text', async () => {
  const status = await runPersistenceAdministration(engine, 'writer_status', { source_id: sourceId }) as {
    bindings: Array<{ source_id: string; owner_epoch: unknown; topology_generation: unknown }>;
  };
  expect(() => JSON.stringify(status)).not.toThrow();
  const binding = status.bindings.find(b => b.source_id === sourceId)!;
  expect(binding).toBeDefined();
  expect(typeof binding.owner_epoch).toBe('string');
  expect(typeof binding.topology_generation).toBe('string');
  expect(binding.owner_epoch).toBe('1');
});
