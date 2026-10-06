/**
 * #5864: the trusted local CLI reaches the four localOnly skill-administration
 * operations, and `gbrain takes remove` (#5167), while a serve owns the PGLite
 * brain. Authoring gate: (1) protects
 * the delegated route for get_skill_retention, prune_skill_revisions,
 * retain_skill_revision and import_skill_proposal, and keeps remote callers
 * refused; (2) fails when the resident owner answers `unknown_tool` to the
 * local CLI, or when another localOnly op joins the IPC allow-list unnoticed;
 * (3) existing persistence IPC tests cover only non-localOnly operations (the
 * transcript read is served by the provider before dispatch);
 * (4) no production seam (the CLI runs as a real subprocess against the real
 * provider).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { PERSISTENCE_IPC_OPERATIONS, startPersistenceIpcServer, persistenceSocketPathForConfig } from '../src/core/persistence/ipc.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';

const LOCAL_ONLY_IPC = ['get_skill_retention', 'import_skill_proposal', 'prune_skill_revisions', 'retain_skill_revision'];

test('the localOnly operations on persistence IPC are the four skill-admin ops, takes_remove and the provider-served transcript read', () => {
  const ipc = new Set<string>(PERSISTENCE_IPC_OPERATIONS);
  expect(operations.filter(op => op.localOnly && ipc.has(op.name)).map(op => op.name).sort()).toEqual([...LOCAL_ONLY_IPC, 'takes_remove', 'get_recent_transcripts'].sort());
});

describe('localOnly skill administration through a resident owner', () => {
  let dir: string;
  let engine: PGLiteEngine;
  let config: { engine: 'pglite'; database_path: string };
  let binding: Awaited<ReturnType<typeof startPersistenceIpcServer>>;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-local-only-ipc-'));
    config = { engine: 'pglite', database_path: join(dir, 'db') };
    await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      engine = new PGLiteEngine();
      await engine.connect(config);
      await engine.initSchema();
      mkdirSync(join(dir, '.gbrain'), { recursive: true });
      writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(config));
      const provider = await createPersistenceIpcProvider(engine, config);
      await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') });
      binding = await startPersistenceIpcServer(persistenceSocketPathForConfig(config)!, provider);
    });
  }, 120_000);
  afterAll(async () => {
    if (binding) { const closed = once(binding.server, 'close'); binding.close(); await closed; }
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  const call = async (operation: string, params: Record<string, unknown>) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'call', operation, JSON.stringify(params)], {
      cwd: dir,
      env: { ...process.env, GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host', GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SKIP_UPGRADE_CHECK: '1',
        GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      stdout: 'pipe', stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code, output: stdout + stderr };
    } finally { clearTimeout(timeout); }
  };

  test('get_skill_retention returns the retention report', async () => {
    const result = await call('get_skill_retention', {});
    expect(result.output).not.toContain('unknown_tool');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ source_id: 'default' });
  }, 60_000);

  for (const [operation, params] of [
    ['prune_skill_revisions', {}],
    ['retain_skill_revision', { name: 'example-skill', revision: '00000000-0000-4000-8000-000000000000', reason: 'example' }],
    ['import_skill_proposal', { name: 'example-skill', files: { 'SKILL.md': '---\nname: example-skill\n---\nBody.\n' }, expected_hashes: { 'SKILL.md': 'f'.repeat(64) } }],
  ] as const) {
    test(`${operation} reaches its handler instead of unknown_tool`, async () => {
      const result = await call(operation, params);
      expect(result.output).not.toContain('unknown_tool');
      expect(result.output).not.toContain('Unknown tool');
    }, 60_000);
  }

  const cli = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], {
      cwd: dir,
      env: { ...process.env, GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host', GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SKIP_UPGRADE_CHECK: '1',
        GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined },
      stdout: 'pipe', stderr: 'pipe',
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code, output: stdout + stderr };
    } finally { clearTimeout(timeout); }
  };

  test('gbrain takes remove (#5167) removes a row through the resident owner', async () => {
    const slug = 'notes/ipc-takes-remove';
    expect((await call('put_page', { slug, content: '---\ntitle: IPC takes remove\ntype: note\n---\nAbout the remove path.\n' })).code).toBe(0);
    for (const claim of ['Keep one', 'Drop two']) {
      expect((await call('takes_add', { slug, claim, kind: 'take', holder: 'world' })).code).toBe(0);
    }
    const removed = await cli(['takes', 'remove', slug, '--row', '2', '--json']);
    expect(removed.output).not.toContain('unknown_tool');
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.stdout)).toMatchObject({ row_num: 2, removed: true });
    const indexed = await engine.executeRaw<{ row_num: number; claim: string }>(
      'SELECT t.row_num, t.claim FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1 ORDER BY t.row_num', [slug]);
    expect(indexed.map(row => [row.row_num, row.claim])).toEqual([[1, 'Keep one']]);
  }, 120_000);

  test('remote callers are still refused', async () => {
    for (const operation of [...LOCAL_ONLY_IPC, 'takes_remove']) {
      const http = await dispatchToolCall(engine, operation, {}, { remote: true, transport: 'http' });
      expect(http.isError).toBe(true);
      expect(http.content[0]!.text).toContain('unknown_tool');
      const stdio = await dispatchToolCall(engine, operation, {}, { remote: true, transport: 'stdio' });
      expect(stdio.isError).toBe(true);
      expect(stdio.content[0]!.text).not.toContain('"error":"unknown_tool"');
    }
  });
});
