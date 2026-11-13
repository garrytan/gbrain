/** The PostgreSQL facts CLI admits but never owns a reviewed relink. */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { hostIdFor, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { claimNextWrite } from '../../src/core/persistence/journal.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { waitFor } from '../helpers/wait-for.ts';
import { withEnv } from '../helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';

const cliFile = join(import.meta.dir, '../../src/cli.ts');

test('Postgres: a reviewed relink waits for Serve, survives a released claim, and replays its original receipt', async () => {
  const { engine, databaseUrl, close } = await isolatedPersistencePostgres(requirePostgresTestDatabase());
  const home = mkdtempSync(join(tmpdir(), 'gbr-fact-serve-'));
  const root = join(home, 'content');
  const slug = 'companies/fixture.example';
  const claim = 'The isolated restore is ready for its independent check.';
  const plan = join(home, 'plan.json');
  const env = {
    PATH: process.env.PATH!, HOME: home, GBRAIN_HOME: home,
    GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_RETRY_CONNECT: '1', GBRAIN_SELF_UPGRADE_MODE: 'off',
    GBRAIN_ADMIN_BOOTSTRAP_TOKEN: 'test-local-only-relink-bootstrap-token',
  };
  const start = (args: string[]) => Bun.spawn([process.execPath, '--no-env-file', cliFile, ...args],
    { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
  const exit = async (child: ReturnType<typeof start>) => {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  let client: ReturnType<typeof start> | undefined;
  let serve: ReturnType<typeof start> | undefined;
  const apply = ['facts', 'relink', '--source', 'default', '--apply-plan', plan];
  try {
    mkdirSync(join(home, '.gbrain')); mkdirSync(join(root, 'companies'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: databaseUrl, embedding_disabled: true }), { mode: 0o600 });
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host' }, async () => {
      await importFromContent(engine, slug, '---\ntitle: Fixture Example\ntype: company\n---\n\nIndependent fixture.\n', { sourceId: 'default', noEmbed: true });
      const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      writeFileSync(join(root, slug + '.md'), serializePageToMarkdown(snapshot!.page, snapshot!.tags));
      await engine.setConfig('sync.repo_path', root);
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
      await claimWorktree(engine, 'default', root);
      await registerLocalWriter(engine, 'cli');
      await activatePersistence(engine, { confirmQuiesced: true });
      const chunksBefore = (await engine.getChunks(slug, { sourceId: 'default' })).map(chunk => chunk.chunk_text);
      const fact = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
        tx.insertFact({ fact: claim, kind: 'fact', visibility: 'private', source: 'fixture', valid_from: new Date('2026-01-01T12:08:23.885Z') }, { source_id: 'default' }), TEST_WRITE_ATTRIBUTION));
      const preview = await exit(start(['facts', 'relink', '--source', 'default', '--fact-id', String(fact.id), '--entity', slug, '--evidence', 'synthetic source evidence', '--dry-run', '--plan-out', plan]));
      expect(preview.code, preview.stderr).toBe(0);
      const absent = await exit(start(apply));
      expect(absent.code).not.toBe(0);
      expect(absent.stderr).toContain('compatible running Serve');
      expect(await engine.executeRaw("SELECT state FROM persistence_requests WHERE operation='relink_fact_by_id'")).toEqual([]);

      // An advertised owner can disappear after admission. No worker is
      // running yet; the real CLI must not claim the request while it waits.
      const hostId = hostIdFor(engine);
      const fakePid = 2 ** 31 - 1;
      await engine.executeRaw(`INSERT INTO persistence_consumers
        (host_id,pid,nonce,kind,mode,started_at,renewed_at,host_json_path,persistence_home,version,capabilities)
        VALUES($1,$2,'fixture-serve','serve','full',now(),now(),$3,$3,'fixture',ARRAY['explicit_fact_relink_1'])`, [hostId, fakePid, home]);
      client = start(apply);
      const response = exit(client);
      const receipts = () => engine.executeRaw<{ id: string; state: string; claim_phase: { owner: { pid: number; kind: string } } | null; request_id: string }>(
        "SELECT id,state,claim_phase,request_id FROM persistence_requests WHERE operation='relink_fact_by_id'");
      await waitFor(async () => (await receipts())[0]?.state === 'deferred', { timeoutMs: 12_000, intervalMs: 100, label: 'CLI admits a held relink' });
      const [accepted] = await receipts();
      expect(await engine.executeRaw("SELECT kind FROM persistence_consumers WHERE kind='cli'")).toEqual([]);
      expect(await claimNextWrite(engine, hostId)).toBeNull();
      const downgrade = await exit(start(['upgrade', '--check-downgrade', '--json']));
      expect(downgrade.code).toBe(3);
      expect(downgrade.stdout + downgrade.stderr).toContain('downgrade_blocked_deferred_writes');
      // Simulate a previous successful Serve claim being released after it
      // crashes, using the same UPDATE that old recovery paths use.
      const token = '10100000-0000-4000-8000-000000000001';
      const claimSQL = "UPDATE persistence_requests SET state='running',execution_token=$2,claim_phase=$3::text::jsonb WHERE id=$1";
      const stamp = JSON.stringify({ owner: { kind: 'serve', pid: fakePid, nonce: 'fixture-serve' } });
      await expect(engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw("SELECT set_config('gbrain.refresh_barrier','1',true)");
        return tx.executeRaw(claimSQL, [accepted!.id, token, stamp]);
      })).rejects.toThrow('writer_upgrade_required');
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw("SELECT set_config('gbrain.explicit_relink_serve','1',true)");
        await tx.executeRaw(claimSQL, [accepted!.id, token, stamp]);
      }).catch(error => { throw new Error('Compatible claim refused', { cause: error }); });
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw("UPDATE persistence_requests SET state='queued',execution_token=NULL,claim_phase=NULL WHERE id=$1", [accepted!.id]);
      }).catch(error => { throw new Error('Compatibility release refused', { cause: error }); });
      expect((await receipts())[0]).toMatchObject({ id: accepted!.id, state: 'deferred', claim_phase: null });
      expect(await claimNextWrite(engine, hostId)).toBeNull();
      await engine.executeRaw("DELETE FROM persistence_consumers WHERE nonce='fixture-serve'");

      const port = await new Promise<number>((resolve, reject) => {
        const socket = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
          const address = socket.address() as { port: number };
          socket.close(() => resolve(address.port));
        });
      });
      serve = start(['--brain', 'host', 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port), '--suppress-bootstrap-token']);
      const servePid = serve.pid;
      void new Response(serve.stdout).text(); void new Response(serve.stderr).text();
      const applied = await response;
      expect(applied.code, applied.stderr).toBe(0);
      const result = JSON.parse(applied.stdout);
      expect(result).toMatchObject({ ok: true, requestId: accepted!.request_id, outcome: { linked: [{ id: fact.id, row_num: 1 }] } });
      expect(await receipts()).toMatchObject([{ id: accepted!.id, state: 'committed', claim_phase: { owner: { pid: servePid, kind: 'serve' } } }]);
      expect(await engine.executeRaw("SELECT kind FROM persistence_consumers WHERE kind IN ('cli','serve')")).toEqual([{ kind: 'serve' }]);
      const text = readFileSync(join(root, slug + '.md'), 'utf8');
      expect(text).toContain(claim);
      expect(text).not.toContain('synthetic source evidence');
      const chunksAfter = (await engine.getChunks(slug, { sourceId: 'default' })).map(chunk => chunk.chunk_text);
      expect(chunksAfter).toEqual(chunksBefore);
      expect(chunksAfter.every(text => !text.includes(claim))).toBe(true);
      expect(await engine.executeRaw("SELECT kind FROM persistence_effects WHERE request_id=$1 AND kind IN ('git','embedding')", [accepted!.id])).toEqual([]);
      serve.kill('SIGTERM');
      await serve.exited;
      const replay = await exit(start(apply));
      expect(replay.code, replay.stderr).toBe(0);
      expect(JSON.parse(replay.stdout)).toEqual(result);
    });
  } finally {
    for (const child of [client, serve]) if (child?.exitCode === null) { child.kill('SIGKILL'); await child.exited; }
    await close();
    rmSync(home, { recursive: true, force: true });
  }
}, 100_000);
