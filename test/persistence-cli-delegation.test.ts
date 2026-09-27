import { afterEach, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPersistenceIpcServer, persistenceSocketPathForConfig, type PersistenceIpcRequest } from '../src/core/persistence/ipc.ts';
import { runDeferredPersistenceCommand } from '../src/commands/persistence-delegate.ts';
import { withEnv } from './helpers/with-env.ts';
import { __testing as capture } from '../src/commands/capture.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { acquireLock, releaseLock } from '../src/core/pglite-lock.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { parseTakesMutation } from '../src/commands/takes-mutation.ts';

const BRAIN = '10000000-0000-4000-8000-000000000001';
const ID = '20000000-0000-4000-8000-000000000001';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function withOwner(run: (dir: string, calls: PersistenceIpcRequest[], connect: () => Promise<BrainEngine>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gb-cli-ipc-'));
  dirs.push(dir);
  const databasePath = join(dir, 'db');
  const config = { engine: 'pglite' as const, database_path: databasePath };
  mkdirSync(join(dir, '.gbrain', 'persistence'), { recursive: true });
  mkdirSync(databasePath, { recursive: true });
  const lock = await acquireLock(databasePath);
  // Real ownership, with the same diagnostic command label a serve writes.
  const metadataPath = lock.lockPath ?? join(databasePath, '.gbrain-lock', 'lock');
  writeFileSync(metadataPath, JSON.stringify({ ...JSON.parse(readFileSync(metadataPath, 'utf8')), subcommand: 'serve' }));
  writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(config));
  writeFileSync(join(dir, '.gbrain', 'persistence', `${BRAIN}.cli.json`), JSON.stringify({
    id: BRAIN, credential: 'a'.repeat(64), lane: 'cli',
  }), { mode: 0o600 });
  const calls: PersistenceIpcRequest[] = [];
  const binding = await startPersistenceIpcServer(persistenceSocketPathForConfig(config)!, {
    brainId: BRAIN,
    dispatch: async request => {
      calls.push(request);
      if (request.params.slug === 'test/pending') {
        const error = new OperationError('write_pending', 'Accepted; waiting for owner.');
        error.writeRequest = { request_id: request.params.request_id as string, state: 'queued', retry_after_ms: 100 };
        throw error;
      }
      return request.operation === 'forget' ? { id: request.params.id, expired: true, protocol_version: 1 }
        : { slug: request.params.slug ?? 'inbox/from-owner', status: 'created', revision: ID,
          write_request: { request_id: request.params.request_id, state: 'committed', retry_after_ms: null } };
    },
  });
  let connects = 0;
  try {
    await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: 'client-source',
      GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, async () => {
      await run(dir, calls, async () => { connects++; throw new Error('A delegated CLI must not connect an engine.'); });
    });
    expect(connects).toBe(0);
  } finally {
    if (binding) { const closed = once(binding.server, 'close'); binding.close(); await closed; }
    await releaseLock(lock);
  }
}

describe('CLI-only persistence delegation before engine connection', () => {
  test('capture retries preserve raw content, ID, event fields, and source without generated time or slug', async () => {
    await withOwner(async (dir, calls, connect) => {
      const file = join(dir, 'input.md');
      const raw = '# An example event\r\n\r\nOriginal input.\r\n';
      writeFileSync(file, raw);
      const args = ['--file', file, '--type', 'event', '--who', 'example-person', '--what', 'met', '--request-id', ID, '--json'];
      await runDeferredPersistenceCommand('capture', args, connect);
      await runDeferredPersistenceCommand('capture', args, connect);
      expect(calls).toHaveLength(2);
      expect(calls[0].params).toEqual(calls[1].params);
      expect(calls[0].operation).toBe('capture');
      expect(calls[0].params).toMatchObject({ content: raw, request_id: ID, who: 'example-person', what: 'met', type: 'event',
        source_kind: 'capture-cli', source_uri: `file://${file}` });
      expect(calls[0].params).not.toHaveProperty('slug');
      expect(calls[0].params.content).not.toContain('captured_at:');
      expect(calls[0].routing.source).toBe('client-source');
    });
  });

  test('generic call forwards exact revision and request ID before connecting', async () => {
    await withOwner(async (_dir, calls, connect) => {
      const params = { slug: 'test/page', content: 'replacement', expected_revision: BRAIN, request_id: ID };
      await runDeferredPersistenceCommand('call', ['--source', 'call-source', 'put_page', JSON.stringify(params)], connect);
      expect(calls).toHaveLength(1);
      expect(calls[0].params).toEqual(params);
      expect(calls[0].routing.source).toBe('call-source');
    });
  });

  test('forget uses the frozen verb with a stable opaque fact ID and request UUID', async () => {
    await withOwner(async (_dir, calls, connect) => {
      await runDeferredPersistenceCommand('forget', ['42', '--reason', 'correction', '--request-id', ID, '--json'], connect);
      expect(calls).toHaveLength(1);
      expect(calls[0].operation).toBe('forget');
      expect(calls[0].params).toEqual({ id: '42', reason: 'correction', request_id: ID });
    });
  });

  test('generic take mutation preserves provenance source independently of CLI source routing', async () => {
    await withOwner(async (_dir, calls, connect) => {
      await runDeferredPersistenceCommand('call', ['--source', 'call-source', 'takes_add', JSON.stringify({
        slug: 'test/page', claim: 'A claim', kind: 'fact', holder: 'world', source: 'meeting notes', request_id: ID,
      })], connect);
      expect(calls[0].operation).toBe('takes_add');
      expect(calls[0].params.source).toBe('meeting notes');
      expect(calls[0].routing.source).toBe('call-source');
      expect(calls[0].params.request_id).toBe(ID);
    });
  });

  test('capture parses both UUID flag forms and forwards preconditions', () => {
    expect(capture.parseArgs(['body', `--request-id=${ID}`, '--expected-revision', BRAIN])).toMatchObject({
      content: 'body', request_id: ID, expected_revision: BRAIN,
    });
    expect(() => capture.parseArgs(['body', '--request-id'])).toThrow('requires a UUID');
    expect(() => capture.parseArgs(['body', '--no-embed'])).toThrow('Unsupported capture option');
  });

  test('actual CLI capture, forget, and call reach the owner before competing for the engine', async () => {
    await withOwner(async (dir, calls) => {
      const file = join(dir, 'capture.md');
      writeFileSync(file, '# Example input\n');
      const invocations = [
        ['capture', '--file', file, '--request-id', ID, '--json'],
        ['forget', '42', `--request-id=${ID}`, '--reason', 'correction', '--json'],
        ['call', 'put_page', JSON.stringify({ slug: 'test/page', content: 'body', request_id: ID })],
      ];
      for (const args of invocations) {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), ...args], {
          cwd: dir, env: { ...process.env, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' },
          stdout: 'pipe', stderr: 'pipe',
        });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toMatchObject({ code: 0 });
        expect(() => JSON.parse(stdout)).not.toThrow();
      }
      expect(calls.map(call => call.operation)).toEqual(['capture', 'forget', 'put_page']);
      expect(calls.every(call => call.params.request_id === ID)).toBe(true);
    });
  });

  test('actual CLI take mutations preserve source, resolver, local directory, and replay IDs before opening PGLite', async () => {
    await withOwner(async (dir, calls) => {
      const invocations = [
        ['add', 'test/page', '--claim', 'Example claim', '--kind', 'fact', '--who', 'me', '--source', 'meeting notes', '--source-id', 'explicit-source'],
        ['update', 'test/page', '--row', '1', '--weight', '0.8', '--dir', dir],
        ['supersede', 'test/page', '--row', '1', '--claim', 'Corrected', '--source', 'correction notes', '--since', '2026-09'],
        ['resolve', 'test/page', '--row', '2', '--outcome', 'false', '--source', 'resolution evidence', '--by', 'people/owner-example'],
      ];
      for (const args of invocations) {
        const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'takes', ...args, `--request-id=${ID}`, '--json'], {
          cwd: dir, env: { ...process.env, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' }, stdout: 'pipe', stderr: 'pipe',
        });
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ code, stderr }).toMatchObject({ code: 0 });
        expect(JSON.parse(stdout).write_request.request_id).toBe(ID);
      }
      expect(calls.map(call => call.operation)).toEqual(['takes_add', 'takes_update', 'takes_supersede', 'takes_resolve']);
      expect(calls[0].params).toMatchObject({ holder: 'me', source: 'meeting notes' });
      expect(calls[0].routing.source).toBe('explicit-source');
      expect(calls[1].params.local_dir).toBe(dir);
      expect(calls[2].params).toMatchObject({ source: 'correction notes', since: '2026-09' });
      expect(calls[3].params).toMatchObject({ quality: 'incorrect', evidence: 'resolution evidence', resolved_by: 'people/owner-example' });
      expect(calls[3].params).not.toHaveProperty('source');
    });
  });

  test('pending CLI take returns its receipt and same-ID retry guidance without reporting a completed mutation', async () => {
    await withOwner(async (dir, calls) => {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'takes', 'update', 'test/pending',
        '--row', '1', '--weight', '0.8', '--request-id', ID, '--json'], {
        cwd: dir, env: { ...process.env, GBRAIN_NO_BANNER: '1', GBRAIN_BACKUP_CHECK: '0' }, stdout: 'pipe', stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(1);
      expect(JSON.parse(stdout).write_request).toMatchObject({ request_id: ID, state: 'queued' });
      expect(stderr).toContain(`--request-id ${ID}`);
      expect(stdout + stderr).not.toContain('Updated take');
      expect(calls).toHaveLength(1);
    });
  });

  test('take parser validates whole numeric values and preserves explicit revision/replay intent', () => {
    expect(parseTakesMutation(['update', 'test/page', '--row=2', '--weight', '0.3', `--request-id=${ID}`, '--expected-revision', BRAIN])).toMatchObject({
      params: { row_num: 2, weight: 0.3, request_id: ID, expected_revision: BRAIN },
    });
    expect(() => parseTakesMutation(['update', 'test/page', '--row', '2junk'])).toThrow('positive integer');
    expect(() => parseTakesMutation(['resolve', 'test/page', '--row', '1', '--quality', 'correct', '--outcome', 'false'])).toThrow('mutually exclusive');
    expect(() => parseTakesMutation(['resolve', 'test/page', '--row', '1', '--quality', 'correct', '--source', 'a', '--evidence', 'b'])).toThrow('different evidence');
    expect(() => parseTakesMutation(['update', 'test/page', '--row', '1', '--force', '--expected-revision', BRAIN])).toThrow('mutually exclusive');
  });
});
