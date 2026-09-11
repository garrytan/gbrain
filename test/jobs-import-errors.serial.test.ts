// Serial: the real import command reads a temporary GBRAIN_HOME per test.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-job-import-errors-'));
const root = join(home, 'source');
let engine: PGLiteEngine;
let handler: (job: MinionJobContext) => Promise<unknown>;
const isolated = (fn: () => Promise<void>) => withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined }, fn);

beforeAll(async () => isolated(async () => {
  mkdirSync(root);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
  const worker = new MinionWorker(engine, { concurrency: 1 });
  await registerBuiltinHandlers(worker, engine, { quiet: true });
  const registered = (worker as unknown as { handlers: Map<string, typeof handler> }).handlers.get('import');
  if (!registered) throw new Error('import handler not registered');
  handler = registered;
}), 60_000);

afterAll(async () => {
  await engine?.disconnect();
  rmSync(home, { recursive: true, force: true });
});

test('queued import rejects malformed frontmatter, preserves progress, and succeeds after repair', () => isolated(async () => {
  writeFileSync(join(root, 'valid.md'), '---\ntype: note\ntitle: Valid fixture\n---\n\nA valid fixture body.\n');
  writeFileSync(join(root, 'rejected.md'), '---\ntitle: [\n---\n\nA rejected fixture body.\n');
  const job: MinionJobContext = {
    id: 1,
    name: 'import',
    data: { dir: root, sourceId: 'default', noEmbed: true },
    attempts_made: 0,
    signal: new AbortController().signal,
    deadlineAtMs: null,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };

  await expect(handler(job)).rejects.toThrow('Import failed for 1 file(s); fix rejected documents and retry the job.');
  expect(await engine.getPage('valid', { sourceId: 'default' })).not.toBeNull();
  expect(await engine.getPage('rejected', { sourceId: 'default' })).toBeNull();
  const checkpoint = JSON.parse(readFileSync(join(home, '.gbrain', 'import-checkpoint.json'), 'utf8'));
  expect(checkpoint.completedPaths).toContain('valid.md');
  expect(checkpoint.completedPaths).not.toContain('rejected.md');

  writeFileSync(join(root, 'rejected.md'), '---\ntype: note\ntitle: Repaired fixture\n---\n\nA repaired fixture body.\n');
  await expect(handler(job)).resolves.toEqual({ imported: true });
  expect(await engine.getPage('rejected', { sourceId: 'default' })).not.toBeNull();
}));
