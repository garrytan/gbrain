import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { startPersistenceIpcServer, persistenceSocketPathForConfig } from '../src/core/persistence/ipc.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';
import { runSourceLifecycleCli } from '../src/commands/sources-lifecycle.ts';
import { withEnv } from './helpers/with-env.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';

let diskEngine: PGLiteEngine;
beforeAll(() => { diskEngine = new PGLiteEngine(); });
afterAll(async () => { await disposePersistenceConsumer(diskEngine); await diskEngine.disconnect(); });

describe('source lifecycle CLI', () => {
  test('strict parsing retains IDs and incarnations without granting force over ownership', () => {
    const id = randomUUID(), incarnation = randomUUID();
    const parsed = parseSourceLifecycleArgs(['set-path', 'example', '.', '--force', '--request-id', id, '--expected-incarnation', incarnation]);
    expect(parsed.params).toEqual({ action: 'rebind', source_id: 'example', path: process.cwd(), request_id: id, expected_incarnation: incarnation });
    expect(parseSourceLifecycleArgs(['restore', 'example', '--no-federate'], id).params).toMatchObject({ request_id: id, refederate: false });
    expect(() => parseSourceLifecycleArgs(['add', 'example', '--path', '.', '--url', 'https://example.invalid/repo.git'])).toThrow('mutually exclusive');
    expect(() => parseSourceLifecycleArgs(['archive', 'example', '--force'])).toThrow('does not apply');
    expect(() => parseSourceLifecycleArgs(['archive', 'example', '--request-id', 'bad'])).toThrow('UUID');
  });

  test('typed connector options contain credential references and allocate identity before transport', () => {
    const id = randomUUID();
    const google = parseSourceLifecycleArgs(['add', 'example', '--kind', 'google', '--account', 'account@example.invalid',
      '--access', 'env', '--token-env', 'EXAMPLE_TOKEN', '--services', 'calendar', '--dir', '.'], id);
    expect(google.params).toMatchObject({ request_id: id, options: { id: 'example', requestId: id,
      google: { tokenEnv: 'EXAMPLE_TOKEN', access: 'env', services: ['calendar'], dir: process.cwd() } } });
    expect(() => parseSourceLifecycleArgs(['add', 'example', '--kind', 'github', '--scope', 'repos'])).toThrow('valid owner/name');
    expect(() => parseSourceLifecycleArgs(['add', 'example', '--kind', 'google', '--account', 'account@example.invalid', '--access', 'command'])).toThrow('access');
  });

  test('actual CLI source writes use the resident owner, replay after deletion, and share page request identity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-source-cli-'));
    await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const config = { engine: 'pglite' as const, database_path: join(dir, 'db') };
      const engine = diskEngine;
      let binding: Awaited<ReturnType<typeof startPersistenceIpcServer>>;
      try {
        await engine.connect(config); await engine.initSchema();
        mkdirSync(join(dir, '.gbrain'), { recursive: true });
        writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(config));
        const provider = await createPersistenceIpcProvider(engine, config);
        await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true });
        binding = await startPersistenceIpcServer(persistenceSocketPathForConfig(config)!, provider);
        const cli = async (args: string[]) => {
          const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'sources', ...args, '--json'], {
            cwd: dir, env: { ...process.env, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' }, stdout: 'pipe', stderr: 'pipe',
          });
          const timeout = setTimeout(() => child.kill('SIGKILL'), 25_000);
          try {
            const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
            expect({ code, stderr }).toMatchObject({ code: 0 });
            return JSON.parse(stdout);
          } finally { clearTimeout(timeout); }
        };
        const createId = randomUUID(), create = ['add', 'example', '--request-id', createId];
        const first = await cli(create);
        expect(first).toMatchObject({ state: 'committed', source_id: 'example', request_id: createId });
        const context = { engine, config, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        // A retained administrative ID conflicts before page lookup, capture processing or entity resolution.
        await expect(submitPageMutation(context, { operation: 'capture', params: { content: '\0', request_id: createId } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
        await expect(submitRememberMutation(context, { entity: 'never-resolve-example', fact: 'unused', request_id: createId })).rejects.toMatchObject({ code: 'idempotency_conflict' });
        const archive = await cli(['archive', 'example', '--request-id', randomUUID(), '--expected-incarnation', first.source_incarnation]);
        expect(archive.state).toBe('committed');
        const purge = await cli(['purge', 'example', '--confirm-destructive', '--request-id', randomUUID()]);
        expect(purge).toMatchObject({ state: 'committed', storage_retained: true });
        expect(await cli(create)).toEqual(first);
        expect(await engine.executeRaw("SELECT id FROM sources WHERE id='example'")).toEqual([]);
        const replacement = await cli(['add', 'example', '--request-id', randomUUID()]);
        expect(replacement.source_incarnation).not.toBe(first.source_incarnation);
        let connects = 0;
        await runSourceLifecycleCli(['archive', 'example', '--request-id', randomUUID()], async () => { connects++; throw new Error('Competing PGLite open'); });
        expect(connects).toBe(0);
      } finally {
        if (binding!) { const closed = once(binding.server, 'close'); binding.close(); await closed; }
        await disposePersistenceConsumer(engine); await engine.disconnect();
      }
    });
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
