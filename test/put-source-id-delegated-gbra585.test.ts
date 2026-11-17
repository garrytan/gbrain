/**
 * GBRA-585: `gbrain put <slug> --source-id <id>` on a PGLite brain whose `gbrain serve` is running.
 *
 * 1. Protects: the CLI delegates the write to the resident serve with the routing source set to the --source-id it was
 *    given, so the owner builds the write's grant on that source, as the direct (no serve) path writes there.
 * 2. Fails when: the delegated write is routed to the ambient source while its source_id names another, which the owner
 *    refused with "permission_denied: The source is outside this writer grant" (walk step 12), or a read's source_id
 *    starts redirecting its routing.
 * 3. Real seams: maybeDelegateLocalOperation against a real persistence IPC socket and a serve lock holder.
 */
import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock } from '../src/core/pglite-lock.ts';
import { maybeDelegateLocalOperation } from '../src/core/persistence/local-client.ts';
import { startPersistenceIpcServer, persistenceSocketPathForConfig, type PersistenceIpcRequest } from '../src/core/persistence/ipc.ts';
import { withEnv } from './helpers/with-env.ts';

const BRAIN = '10000000-0000-4000-8000-000000000585';

describe('put --source-id delegated to a resident serve (GBRA-585)', () => {
  test('a write routes to its source_id; a read keeps the ambient routing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-put-source-id-'));
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
      await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined }, async () => {
        const put = await maybeDelegateLocalOperation('put_page', { slug: 'notes/board-prep', content: '# Board prep\n', source_id: 'source-a' }, config, { brain: 'host', cwd: dir });
        expect(put.handled).toBe(true);
        expect([calls.at(-1)!.params.source_id, calls.at(-1)!.routing.source]).toEqual(['source-a', 'source-a']);
        const get = await maybeDelegateLocalOperation('get_page', { slug: 'notes/board-prep', source_id: 'source-a' }, config, { brain: 'host', cwd: dir });
        expect(get.handled).toBe(true);
        expect([calls.at(-1)!.params.source_id, calls.at(-1)!.routing.source]).toEqual(['source-a', null]);
      });
    } finally {
      if (binding) { const closed = once(binding.server, 'close'); binding.close(); await closed; }
      await releaseLock(lock);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
