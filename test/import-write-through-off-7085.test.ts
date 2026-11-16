/**
 * #7085: a managed `gbrain import --source <id>` on a brain with
 * `sync.write_through=false` admitted every file as a write request (spending
 * write capacity) that its publication then refused with `owner_unavailable`:
 * the admission records no worktree when write-through is off, and a managed
 * import publishes only through the source's canonical owner.
 *
 * Git is the parent, so import does not fall back to writing the database
 * first. Protects: the import refuses once, before its per-file loop, with a
 * typed refusal (`owner_unavailable`, `detail: disabled_by_config`, not
 * retryable) whose fix names the supported path (commit the files, then
 * `gbrain sync --source <id>`); it admits no write request and spends no write
 * capacity. With write-through on, the same import still lands.
 * Seams: none; PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { ImportAbortError, runImport } from '../src/commands/import.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-import-7085-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

async function fixture(engine: BrainEngine) {
  const sourceId = `source-a-${randomUUID().slice(0, 8)}`;
  const root = join(home, sourceId), input = join(home, `${sourceId}-input`);
  mkdirSync(root); mkdirSync(input);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  for (const name of ['alpha', 'beta', 'gamma']) writeFileSync(join(input, `${name}.md`), `# ${name}\n\nA synthetic note about acme-example.\n`);
  return { sourceId, input };
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; stderr: string }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    return { value: await fn(), stderr: lines.join('\n') };
  } catch (error) {
    return { error, stderr: lines.join('\n') };
  } finally {
    console.error = original;
  }
}

test('write_through=false: managed import refuses once before admitting any file, naming commit + sync', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await fixture(engine);
    await engine.setConfig('sync.write_through', 'false');
    try {
      const run = await captureStderr(() => runImport(engine, [f.input, '--no-embed', '--fresh'], { sourceId: f.sourceId }));
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.sourceId])).toHaveLength(0);
      expect(run.value).toBeUndefined();
      expect(run.error).toBeInstanceOf(ImportAbortError);
      const cause = (run.error as ImportAbortError).cause;
      expect(cause).toBeInstanceOf(OperationError);
      expect(cause).toMatchObject({ code: 'owner_unavailable', detail: 'disabled_by_config', retryable: false });
      expect((cause as OperationError).suggestion).toContain(`gbrain sync --source ${f.sourceId}`);
      expect((cause as OperationError).fix?.argv).toEqual(['gbrain', 'sync', '--source', f.sourceId]);
      expect(run.stderr.match(/owner_unavailable/g)).toHaveLength(1);
      expect(run.stderr).toContain(`gbrain sync --source ${f.sourceId}`);
    } finally {
      await engine.setConfig('sync.write_through', 'true');
    }
    expect(await runImport(engine, [f.input, '--no-embed', '--fresh'], { sourceId: f.sourceId })).toMatchObject({ imported: 3, errors: 0 });
  }
}), 120_000);
