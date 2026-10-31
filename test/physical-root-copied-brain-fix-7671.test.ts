/**
 * #7671: on a brain copied as a directory (baked into an image, restored from
 * a file-level backup) every source root is a new directory at its recorded
 * path, so every managed write refuses `recovery_required` (detail
 * `physical_root_directory_changed`). The refusal named the relocated-root
 * self-transfer only in prose; `fix` pointed at the write receipt, so an agent
 * following `fix.next` read the receipt and never reached the exit.
 *
 * Protects: the refusal's `fix` is the relocated-root self-transfer for
 * that source (`transfer prepare <source> --self-transfer --confirm-relocated-root`,
 * a host-admin step, then the accept), both on the worktree lock (root and
 * epoch filled in) and on a put_page receipt rendered for the agent; the refusal
 * itself stays (nothing is re-stamped), and the named command restores writes.
 * Seams: the 6501 fixture: a managed source whose directory is replaced by a
 * copy at the same path (new inode and birth time, same device). PGLite always,
 * Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { PHYSICAL_ROOT_MARKER } from '../src/core/persistence/physical-root-record.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const PREPARE = (source: string) => ['gbrain', 'sources', 'writer', 'transfer', 'prepare', source, '--self-transfer', '--confirm-relocated-root'];

for (const kind of testBackends()) describe(`copied brain names the relocated-root self-transfer in fix (${kind})`, () => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-copied-root-')));
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => {
    await withEnv({ GBRAIN_HOME: directory }, () => disposePersistenceConsumer(engine));
    if (close) await close(); else await engine.disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

  test('the worktree lock and a put_page receipt carry the filled self-transfer as fix; running it restores writes', async () => {
    const home = join(directory, randomUUID()), root = join(home, 'root'); mkdirSync(root, { recursive: true });
    const source = `copied-${randomUUID().slice(0, 8)}`;
    await withEnv({ GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
      await claimWorktree(engine, source, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const registration = await registerLocalWriter(engine, 'cli');
      const ctx: OperationContext = { engine, remote: false, sourceId: source, config: { engine: engine.kind, embedding_disabled: true } as never,
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      const put = (slug: string) => withVerifiedLocalRegistration(engine, registration, () =>
        operationsByName.put_page!.handler(ctx, { source_id: source, slug, request_id: randomUUID(),
          content: '---\ntype: note\ntitle: Example\n---\nA managed observation.\n' }));
      expect(await put('notes/before-copy')).toMatchObject({ state: 'committed' });
      const binding = (await getWorktreeBinding(engine, source))!;
      await disposePersistenceConsumer(engine);
      const previous = `${root}.previous`;
      renameSync(root, previous); mkdirSync(root); cpSync(previous, root, { recursive: true }); rmSync(previous, { recursive: true, force: true });
      expect(statSync(root, { bigint: true }).ino.toString()).not.toBe(readJson(join(root, PHYSICAL_ROOT_MARKER)).inode);

      const locked = await acquireWorktree(binding, 5000, undefined, engine).then(lock => lock?.release().then(() => null) ?? null,
        (error: unknown) => error as { code: string; detail?: string; fix?: { argv?: string[]; actor?: string; then?: { argv?: string[] } } });
      expect(locked).toMatchObject({ code: 'recovery_required', detail: 'physical_root_directory_changed' });
      expect(locked!.fix?.argv?.slice(0, 8)).toEqual(PREPARE(source));
      expect(locked!.fix?.actor).toBe('host_admin');
      expect(locked!.fix?.then?.argv).toEqual(expect.arrayContaining(['accept', source, '--path', root, '--expected-epoch', String(binding.owner_epoch), '--confirm-relocated-root']));

      const refused = await put('notes/while-copied').then(() => null, (error: unknown) => error);
      expect(refused).not.toBeNull();
      const envelope = JSON.parse(renderCliError(refused, { json: true, command: 'put', tty: false }).stdout ?? '') as { code: string; fix?: { argv?: string[]; command?: string; next?: string } };
      expect(envelope.code).toBe('recovery_required');
      expect(envelope.fix?.argv?.slice(0, 8)).toEqual(PREPARE(source));
      expect(envelope.fix?.command).toContain(`transfer prepare ${source} --self-transfer --confirm-relocated-root`);
      expect(envelope.fix?.next).toBe('tell_user_to_run');

      const administer = async (operation: 'writer_transfer_prepare' | 'writer_transfer_accept', params: Record<string, unknown>) =>
        runPersistenceAdministration(engine, operation, { ...params, ...await reviewedWriterIntent(engine, operation) });
      const prepared = await administer('writer_transfer_prepare', { source_id: source, self_transfer: true, confirm_relocated_root: true }) as { owner_epoch: string; manifest: { digest: string } };
      expect(prepared.owner_epoch).toBe(String(binding.owner_epoch));
      await administer('writer_transfer_accept', { source_id: source, path: root, expected_epoch: prepared.owner_epoch, manifest: prepared.manifest.digest, self_transfer: true, confirm_relocated_root: true });
      expect(await put('notes/after-self-transfer')).toMatchObject({ state: 'committed' });
    });
  }, 90_000);
});
