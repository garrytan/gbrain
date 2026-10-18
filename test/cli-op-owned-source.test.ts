/**
 * #5087: an op that owns a `source` param (timeline-add) takes `--source`
 * as provenance on every CLI route, never as the write's source scope.
 * Authoring gate: (1) protects the direct local route, the route delegated
 * to a resident serve, and the thin-client route; (2) fails when a
 * provenance URL is refused as an invalid source id, when a provenance
 * value that is also a source id redirects the write to that source, or
 * when the delegated route drops the provenance from the wire; (3) existing
 * source-scope tests cover only ops without their own `source` param;
 * (4) no production seam (the CLI runs as a real subprocess).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireLock, releaseLock } from '../src/core/pglite-lock.ts';
import { maybeDelegateLocalOperation } from '../src/core/persistence/local-client.ts';
import { startPersistenceIpcServer, persistenceSocketPathForConfig, type PersistenceIpcRequest } from '../src/core/persistence/ipc.ts';
import { operations } from '../src/core/operations.ts';
import { applyThinClientSourceScope } from '../src/cli/main.ts';
import { withEnv } from './helpers/with-env.ts';

const CLI = join(import.meta.dir, '../src/cli.ts');
const BRAIN = '10000000-0000-4000-8000-000000000001';
const addTimelineEntry = operations.find(op => op.name === 'add_timeline_entry')!;

describe('timeline-add --source on the direct local route', () => {
  let dir: string;
  let config: { engine: 'pglite'; database_path: string };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-op-source-'));
    config = { engine: 'pglite', database_path: join(dir, 'db') };
    const engine = new PGLiteEngine();
    await engine.connect(config);
    await engine.initSchema();
    await engine.putPage('concepts/probe', { type: 'concept', title: 'Probe', compiled_truth: 'Probe body.' });
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('meetings', 'meetings') ON CONFLICT DO NOTHING");
    await engine.disconnect();
    mkdirSync(join(dir, '.gbrain'), { recursive: true });
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({ ...config, embedding: { disabled: true } }));
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const cli = async (args: string[]) => {
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: dir, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0',
      GBRAIN_SKIP_UPGRADE_CHECK: '1', GBRAIN_SOURCE: undefined, GBRAIN_BRAIN_ID: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined };
    const child = Bun.spawn([process.execPath, CLI, ...args], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  const entries = async () => {
    const engine = new PGLiteEngine();
    await engine.connect(config);
    try {
      return await engine.executeRaw<{ source_id: string; source: string; summary: string }>(
        `SELECT p.source_id, t.source, t.summary FROM timeline_entries t JOIN pages p ON p.id = t.page_id
          WHERE p.slug = 'concepts/probe' ORDER BY t.summary`);
    } finally { await engine.disconnect(); }
  };

  test('a provenance URL is written as provenance on the ambient source', async () => {
    const run = await cli(['timeline-add', 'concepts/probe', '2026-09-14', 'probe url', '--source', 'https://example.com/notes/x', '--json']);
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(run.stdout)).toMatchObject({ source_id: 'default', entry: { source: 'https://example.com/notes/x' } });
    expect(await entries()).toContainEqual({ source_id: 'default', source: 'https://example.com/notes/x', summary: 'probe url' });
  }, 60_000);

  test('a provenance value that is also a source id does not redirect the write', async () => {
    const run = await cli(['timeline-add', 'concepts/probe', '2026-09-15', 'probe id', '--source', 'meetings', '--json']);
    expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 });
    expect(JSON.parse(run.stdout)).toMatchObject({ source_id: 'default', entry: { source: 'meetings' } });
    expect(await entries()).toContainEqual({ source_id: 'default', source: 'meetings', summary: 'probe id' });
  }, 60_000);
});

describe('timeline-add --source delegated to a resident serve', () => {
  test('the provenance stays on the wire and the ambient source routes the write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-op-source-ipc-'));
    const config = { engine: 'pglite' as const, database_path: join(dir, 'db') };
    mkdirSync(join(dir, '.gbrain', 'persistence'), { recursive: true });
    mkdirSync(config.database_path, { recursive: true });
    const lock = await acquireLock(config.database_path);
    const metadataPath = lock.lockPath ?? join(config.database_path, '.gbrain-lock', 'lock');
    writeFileSync(metadataPath, JSON.stringify({ ...JSON.parse(readFileSync(metadataPath, 'utf8')), subcommand: 'serve' }));
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(config));
    writeFileSync(join(dir, '.gbrain', 'persistence', `${BRAIN}.cli.json`), JSON.stringify({ id: BRAIN, credential: 'a'.repeat(64), lane: 'cli' }), { mode: 0o600 });
    const calls: PersistenceIpcRequest[] = [];
    const binding = await startPersistenceIpcServer(persistenceSocketPathForConfig(config)!, {
      brainId: BRAIN,
      dispatch: async request => {
        calls.push(request);
        return { slug: request.params.slug, status: 'ok', write_request: { request_id: request.params.request_id, state: 'committed', retry_after_ms: null } };
      },
    });
    try {
      await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: 'client-source', GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, async () => {
        for (const provenance of ['https://example.com/notes/x', 'meetings']) {
          const delegated = await maybeDelegateLocalOperation('add_timeline_entry',
            { slug: 'concepts/probe', date: '2026-09-14', summary: 'probe', source: provenance }, config, { brain: 'host', cwd: dir });
          expect(delegated.handled).toBe(true);
          const call = calls.at(-1)!;
          expect(call.params.source).toBe(provenance);
          expect(call.routing.source).toBe('client-source');
        }
      });
    } finally {
      if (binding) { const closed = once(binding.server, 'close'); binding.close(); await closed; }
      await releaseLock(lock);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('timeline-add --source on the thin-client route', () => {
  test('the provenance is sent as the op param and never becomes a scope', () => {
    const params: Record<string, unknown> = { slug: 'concepts/probe', date: '2026-09-14', summary: 'probe', source: 'meetings' };
    expect(applyThinClientSourceScope(addTimelineEntry, params)).toBeNull();
    expect(params).toEqual({ slug: 'concepts/probe', date: '2026-09-14', summary: 'probe', source: 'meetings' });
  });
});
