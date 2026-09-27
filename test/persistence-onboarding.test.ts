import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { performSync } from '../src/commands/sync.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { persistenceHome } from '../src/core/persistence/identity.ts';
import { PHYSICAL_ROOT_MARKER } from '../src/core/persistence/physical-root-record.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';

for (const kind of testBackends()) describe(`deliberate onboarding (${kind})`, () => {
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  const home = mkdtempSync(join(tmpdir(), 'gbrain-onboarding-')), root = join(home, 'canonical');
  beforeAll(async () => {
    mkdirSync(root);
    await makeGitFixture(root);
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
  test('read-only preflight identifies both blocked states and explicit onboarding restores writes and sync', () => withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined }, async () => {
    await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
    const status = await runPersistenceAdministration(engine, 'writer_status', {}) as any;
    expect(status.onboarding.sources).toContainEqual(expect.objectContaining({ source_id: 'default', state: 'claim_required' }));
    expect(existsSync(join(persistenceHome(), 'host.json'))).toBe(false);
    expect(existsSync(join(root, PHYSICAL_ROOT_MARKER))).toBe(false);
    const write = () => dispatchToolCall(engine, 'put_page', { slug: 'onboarding-note', content: '---\ntitle: Onboarding example\ntype: note\n---\nA durable example.\n', request_id: randomUUID() }, { remote: false, sourceId: 'default', config: { engine: kind, embedding_disabled: true } });
    if (kind === 'postgres') {
      const refused = await write(); expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.content[0].text)).toMatchObject({ error: 'owner_unavailable' });
      expect(await engine.getPage('onboarding-note', { sourceId: 'default' })).toBeNull();
      expect(existsSync(join(root, PHYSICAL_ROOT_MARKER))).toBe(false);
    }
    await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'default', path: root, ...await reviewedWriterIntent(engine, 'writer_claim') });
    const claimed = await runPersistenceAdministration(engine, 'writer_status', {}) as any;
    expect(claimed.onboarding.sources).toContainEqual(expect.objectContaining({ source_id: 'default', state: 'activation_required' }));
    await expect(performSync(engine, { sourceId: 'default', noEmbed: true, noPull: true })).rejects.toThrow();
    const activate = async (params: Record<string, unknown> = {}) => runPersistenceAdministration(engine, 'writer_activate', {
      confirm_quiesced: true, ...params, ...await reviewedWriterIntent(engine, 'writer_activate'),
    });
    const dead = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], { stdout: 'ignore', stderr: 'ignore' }); await dead.exited;
    for (const [name, pid, host, age] of [
      ['live', process.pid, hostname(), '1 hour'], ['foreign', dead.pid, 'foreign-example', '1 hour'], ['young', dead.pid, hostname(), '1 second'],
    ] as const) {
      await engine.executeRaw(`INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,acquired_at,ttl_expires_at,acquisition_token)
        VALUES($1,$2,$3,now()-$4::interval,now()-interval '1 hour',$5::uuid)`, [name, pid, host, age, randomUUID()]);
      await expect(activate({ cleanup_dead_local_locks: true })).rejects.toMatchObject({ code: 'writer_not_quiesced' });
      expect((await engine.executeRaw('SELECT id FROM gbrain_cycle_locks WHERE id=$1', [name])).length).toBe(1);
      await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [name]);
    }
    const token = randomUUID();
    await engine.executeRaw(`INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,acquired_at,ttl_expires_at,acquisition_token)
      VALUES('dead-local',$1,$2,now()-interval '1 hour',now()+interval '1 hour',$3::uuid)`, [dead.pid, hostname(), token]);
    await expect(activate()).rejects.toMatchObject({ code: 'writer_not_quiesced' });
    const preview = await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, cleanup_dead_local_locks: true, dry_run: true }) as any;
    expect(preview.legacy_locks).toContainEqual(expect.objectContaining({ id: 'dead-local', acquisition_token: token, liveness: 'dead_eligible' }));
    expect((await engine.executeRaw('SELECT id FROM gbrain_cycle_locks')).length).toBe(1);
    const stale = await reviewedWriterIntent(engine, 'writer_activate');
    await engine.executeRaw('UPDATE gbrain_cycle_locks SET acquisition_token=$1::uuid', [randomUUID()]);
    await expect(runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, cleanup_dead_local_locks: true, ...stale })).rejects.toMatchObject({ code: 'writer_admin_state_changed' });
    expect(await activate({ cleanup_dead_local_locks: true })).toMatchObject({ activated: true });
    expect(await engine.executeRaw('SELECT id FROM gbrain_cycle_locks')).toEqual([]);
    const ready = await runPersistenceAdministration(engine, 'writer_status', {}) as any;
    expect(ready.onboarding.sources).toContainEqual(expect.objectContaining({ source_id: 'default', state: 'ready' }));
    expect((await write()).isError).not.toBe(true);
    expect(readFileSync(join(root, 'onboarding-note.md'), 'utf8')).toContain('A durable example.');
    writeFileSync(join(root, 'imported-example.md'), '---\ntitle: Imported example\ntype: note\n---\nDeliberate sync example.\n');
    execFileSync('git', ['-C', root, 'add', 'imported-example.md']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'Add isolated import fixture']);
    expect(await performSync(engine, { sourceId: 'default', noEmbed: true, noPull: true })).toMatchObject({ added: 1 });
    expect((await engine.getPage('imported-example', { sourceId: 'default' }))?.compiled_truth).toContain('Deliberate sync example.');
  }), 120_000);
});
