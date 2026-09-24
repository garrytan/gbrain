import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { inspectLockHolder } from '../src/core/pglite-lock.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { acquireNativeLock, type NativeLockHandle } from '../src/core/persistence/native-lock.ts';
import { persistenceSocketPathForConfig, requestPersistenceCapabilities } from '../src/core/persistence/ipc.ts';
import { runCli, type CliResult } from './helpers/cli-spawn.ts';
import { keylessBrainEnv, PROVIDER_ENV_KEYS } from './helpers/provider-env.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

const slug = 'people/example';
const sourceId = 'workspace';
const body = 'A synthetic biography whose original bytes must stay out of the CLI summary.';
const fact = 'Prefers the example meeting room on Tuesdays';
const provenance = 'Synthetic operator conversation, reconciliation journey';

async function topology(engine: PGLiteEngine) {
  return {
    brain: await engine.executeRaw('SELECT brain_id,enabled FROM persistence_brain'),
    binding: await getWorktreeBinding(engine, sourceId),
    sources: await engine.executeRaw('SELECT id,incarnation,local_path,last_commit,last_sync_at,config FROM sources ORDER BY id'),
    checkpoints: await engine.executeRaw('SELECT * FROM op_checkpoints ORDER BY op,fingerprint'),
    checkpointPaths: await engine.executeRaw('SELECT * FROM op_checkpoint_paths ORDER BY op,fingerprint,path'),
    writers: await engine.executeRaw('SELECT id,lane,grant_ceiling,revoked_at FROM persistence_local_writers ORDER BY id'),
  };
}

function success(result: CliResult): Record<string, any> {
  if (result.exitCode !== 0) throw new Error(`CLI exited ${result.exitCode}\n${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function privateSummary(result: CliResult) {
  expect(result.stdout).not.toContain(body);
  expect(result.stdout).not.toContain('database-only-private-value');
  expect(result.stdout).not.toContain('file-only-private-value');
  expect(result.stdout).not.toContain('file_base64');
  expect(result.stdout).not.toContain('preimages');
  expect(result.stdout).not.toContain('compiled_truth');
}

for (const transport of ['stdio', 'http'] as const) {
  for (const enabled of [false, true]) {
    test(`${transport} resident owner: preview, resolve, pending/restart/replay, and independent remember readback with activation ${enabled ? 'on' : 'off'}`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-owner-'));
      const root = join(home, 'workspace');
      const file = join(root, 'people/example.md');
      const config = { engine: 'pglite' as const, database_path: join(home, 'db') };
      const env = keylessBrainEnv(process.env, home, {
        DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_DIRECT_DATABASE_URL: undefined,
        GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: sourceId,
        GBRAIN_HOOKS: undefined, GBRAIN_SWEEP: '0', GBRAIN_BACKUP_CHECK: '0', GBRAIN_NO_BANNER: '1',
        GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS: '120',
      });
      const isolatedEnv: Record<string, string | undefined> = { ...env,
        ...Object.fromEntries([...PROVIDER_ENV_KEYS, 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_DIRECT_DATABASE_URL',
          'GBRAIN_REMOTE_CLIENT_SECRET', 'GBRAIN_HOOKS'].map(key => [key, undefined])) };
      let owner: ReturnType<typeof Bun.spawn> | undefined;
      let ownerStdout = '', ownerStderr = '';
      let readers: Promise<void>[] = [];
      const held: { lock: NativeLockHandle | null } = { lock: null };
      const engine = new PGLiteEngine();
      const cli = (args: string[]) => runCli(args, { home, cwd: home, env: isolatedEnv, timeoutMs: 60_000 });
      const call = (operation: string, params: Record<string, unknown>) => cli([
        '--brain', 'host', 'call', '--source', sourceId, operation, JSON.stringify({ source_id: sourceId, ...params }),
      ]);
      const reconcile = (args: string[]) => cli(['sources', 'reconcile', sourceId, slug, '--brain', 'host', '--json', ...args]);
      async function drain(stream: ReadableStream<Uint8Array>, append: (value: string) => void) {
        const reader = stream.getReader(), decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            append(decoder.decode(value, { stream: true }));
          }
        } finally { reader.releaseLock(); }
      }
      async function stop() {
        if (owner?.exitCode === null) {
          owner.kill('SIGTERM');
          const timer = setTimeout(() => owner?.kill('SIGKILL'), 15_000);
          try { await owner.exited; } finally { clearTimeout(timer); }
        }
        await Promise.allSettled(readers);
      }
      async function start() {
        ownerStdout = ''; ownerStderr = '';
        const reservation = transport === 'http' ? Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }) : undefined;
        const port = reservation?.port;
        await reservation?.stop(true);
        const args = transport === 'stdio'
          ? [join(import.meta.dir, 'fixtures/persistence-stdio-owner.ts')]
          : [join(import.meta.dir, '../src/cli.ts'), 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port)];
        owner = Bun.spawn([process.execPath, '--no-env-file', ...args], {
          cwd: home, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        });
        readers = [drain(owner.stdout as ReadableStream<Uint8Array>, text => { ownerStdout += text; }),
          drain(owner.stderr as ReadableStream<Uint8Array>, text => { ownerStderr += text; })];
        await waitFor(async () => {
          if (owner!.exitCode !== null) throw new Error(`Owner exited before readiness: ${ownerStderr}`);
          try {
            await requestPersistenceCapabilities(persistenceSocketPathForConfig(config)!, 500);
            return transport === 'stdio' || (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok;
          } catch { return false; }
        }, { timeoutMs: 90_000, intervalMs: 50, label: `${transport} owner ready` });
        if (transport === 'stdio') {
          (owner.stdin as { write: (value: string) => unknown }).write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'reconcile-example-test', version: '1' } } }) + '\n');
          await waitFor(() => ownerStdout.split('\n').some(line => {
            try { return JSON.parse(line).id === 1; } catch { return false; }
          }), { timeoutMs: 15_000, label: 'stdio initialize response' });
        }
        expect(inspectLockHolder(config.database_path).pid).toBe(owner.pid);
      }

      try {
        await withEnv(isolatedEnv, async () => {
          mkdirSync(join(home, '.gbrain'), { recursive: true });
          mkdirSync(join(root, 'people'), { recursive: true });
          writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify(config));
          await engine.connect(config); await engine.initSchema();
          await engine.setConfig('search.mcp_keyword_only', 'true');
          await engine.executeRaw("INSERT INTO sources(id,name,local_path,last_commit,last_sync_at,config) VALUES($1,$1,$2,'example-checkpoint',now(),'{\"fixture\":true}')", [sourceId, root]);
          await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('reconcile-owner-example','fixture','[\"already-completed\"]')");
          await engine.executeRaw("INSERT INTO op_checkpoint_paths(op,fingerprint,path) VALUES('reconcile-owner-example','fixture','already-completed.md')");
          await importFromContent(engine, slug, `---\ntype: person\ntitle: Example\nprofile:\n  role: database-role\n  database_field: database-only-private-value\ncustom_database: retained\nobsolete_note: remove-after-review\n---\n${body}\n`,
            { sourceId, sourcePath: 'people/example.md', noEmbed: true });
          await importFromContent(engine, slug, '---\ntype: person\ntitle: Other Example\n---\nAn unrelated source must remain unchanged.\n',
            { sourceId: 'default', sourcePath: 'people/example.md', noEmbed: true });
          const original = (await engine.readPageSnapshot(slug, { sourceId }))!;
          const otherSource = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
          await engine.executeRaw("UPDATE pages SET frontmatter=frontmatter || $3::text::jsonb WHERE source_id=$1 AND slug=$2",
            [sourceId, slug, JSON.stringify({ atoms_scan_hash: original.page.content_hash!.slice(0, 16) })]);
          const databaseBefore = (await engine.readPageSnapshot(slug, { sourceId }))!;
          writeFileSync(file, serializePageToMarkdown({ ...original.page, frontmatter: {
            profile: { role: 'file-role', file_field: 'file-only-private-value' }, custom_file: 'retained',
          } }, original.tags));
          const originalBytes = readFileSync(file);
          const binding = await claimWorktree(engine, sourceId, root);
          await registerLocalWriter(engine, 'cli'); await registerLocalWriter(engine, 'stdio');
          await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [enabled]);
          const beforeTopology = await topology(engine);
          await engine.disconnect();
          await start();

          const blockedId = randomUUID();
          const memoryParams = { fact, provenance, entity: slug, visibility: 'private' };
          const blocked = await call('remember', { ...memoryParams, request_id: blockedId });
          expect(blocked.exitCode).toBe(1);
          const blockedError = JSON.parse(blocked.stdout);
          expect(blockedError).toMatchObject({ error: 'scope_denied', write_error: 'source_changed', write_request: { request_id: blockedId } });
          expect(readFileSync(file)).toEqual(originalBytes);

          const previewPath = join(home, 'preview.json');
          const previewResult = await reconcile(['--preview', '--out', previewPath]);
          expect(success(previewResult)).toMatchObject({ source_id: sourceId, slug, status: 'needs_resolution',
            conflict_paths: ['/frontmatter/profile/role'], relative_path: 'people/example.md' });
          privateSummary(previewResult);
          expect(statSync(previewPath).mode & 0o777).toBe(0o600);
          const preview = JSON.parse(readFileSync(previewPath, 'utf8'));
          expect(preview.preimages.file_base64).toBe(originalBytes.toString('base64'));
          expect(readFileSync(file)).toEqual(originalBytes);
          expect(success(await call('get_page', { slug })).revision).toBe(databaseBefore.revision);

          const decisionsPath = join(home, 'decisions.json'), resolvedPath = join(home, 'resolved.json');
          writeFileSync(decisionsPath, JSON.stringify([
            { path: '/frontmatter/profile/role', action: 'take_file' },
            { path: '/frontmatter/obsolete_note', action: 'delete' },
          ]));
          const resolvedResult = await reconcile(['--preview', '--from', previewPath, '--decisions', decisionsPath, '--out', resolvedPath]);
          expect(success(resolvedResult)).toMatchObject({ source_id: sourceId, slug, status: 'ready', conflict_paths: [] });
          privateSummary(resolvedResult);
          const resolved = JSON.parse(readFileSync(resolvedPath, 'utf8'));
          expect(resolved.result.frontmatter).toMatchObject({ custom_database: 'retained', custom_file: 'retained',
            profile: { role: 'file-role', database_field: 'database-only-private-value', file_field: 'file-only-private-value' } });
          expect(resolved.result.frontmatter.obsolete_note).toBeUndefined();
          expect(resolved.result.frontmatter.atoms_scan_hash).toBeUndefined();

          const reconcileId = randomUUID();
          const applyArgs = ['--apply', resolvedPath, '--request-id', reconcileId];
          held.lock = await acquireNativeLock(binding.coordination_path!, { timeoutMs: 1000 });
          expect(held.lock).not.toBeNull();
          const pending = await reconcile(applyArgs);
          expect(pending.exitCode).toBe(1);
          expect(JSON.parse(pending.stdout)).toMatchObject({ error: 'write_pending', write_request: { request_id: reconcileId } });
          expect(JSON.parse(pending.stdout).write_request.state).not.toBe('committed');
          privateSummary(pending);
          expect(readFileSync(file)).toEqual(originalBytes);
          const pendingReceipt = success(await call('get_write_request', { request_id: reconcileId }));
          expect(pendingReceipt.request_id).toBe(reconcileId);
          expect(pendingReceipt.state).not.toBe('committed');
          const pendingReplay = await reconcile(applyArgs);
          expect(pendingReplay.exitCode).toBe(1);
          expect(JSON.parse(pendingReplay.stdout)).toMatchObject({ error: 'write_pending', write_request: {
            request_id: reconcileId, created_at: pendingReceipt.created_at,
          } });
          expect(readFileSync(file)).toEqual(originalBytes);
          await stop();
          await held.lock!.release(); held.lock = null;
          await start();

          const appliedResult = await reconcile(applyArgs), applied = success(appliedResult);
          expect(applied).toMatchObject({ request_id: reconcileId, state: 'committed', outcome: { status: 'reconciled',
            database_changed: true, file_changed: true, scan_state_transferred: false } });
          privateSummary(appliedResult);
          const page = success(await call('get_page', { slug }));
          expect(page.source_id).toBe(sourceId);
          expect(page.frontmatter).toEqual(resolved.result.frontmatter);
          expect(parseMarkdown(readFileSync(file, 'utf8'), slug).frontmatter).toEqual(page.frontmatter);
          const backupDir = join(home, '.gbrain/reconciliation-previews');
          const backupPath = join(backupDir, applied.outcome.backup_reference);
          const backupBytes = readFileSync(backupPath);
          const backup = JSON.parse(backupBytes.toString());
          expect(backup.preview.preimages.file_base64).toBe(originalBytes.toString('base64'));
          expect(backup.preview.preimages.database.page.frontmatter).toEqual(databaseBefore.page.frontmatter);
          expect(statSync(backupPath).mode & 0o777).toBe(0o600);
          expect(statSync(backupDir).mode & 0o777).toBe(0o700);
          const backupFiles = readdirSync(backupDir);
          expect(backupFiles.filter(name => name.endsWith('.json'))).toEqual([applied.outcome.backup_reference]);

          const memoryId = randomUUID();
          expect(new Set([blockedId, reconcileId, memoryId]).size).toBe(3);
          const remembered = success(await call('remember', { ...memoryParams, request_id: memoryId }));
          expect(remembered).toMatchObject({ status: 'inserted', state: 'committed', request_id: memoryId,
            entity_slug: slug, protocol_version: 1 });
          const readback = success(await call('get_page', { slug }));
          expect(readback.source_id).toBe(sourceId);
          expect(parseFactsFence(readback.compiled_truth).facts).toEqual(expect.arrayContaining([
            expect.objectContaining({ claim: fact, visibility: 'private', source: provenance }),
          ]));
          const rememberedBytes = readFileSync(file);
          expect(parseMarkdown(rememberedBytes.toString(), slug).compiled_truth).toBe(readback.compiled_truth);
          const replay = success(await reconcile(applyArgs));
          expect(replay).toEqual(applied);
          expect(readFileSync(file)).toEqual(rememberedBytes);
          expect(readFileSync(backupPath)).toEqual(backupBytes);
          expect(readdirSync(backupDir)).toEqual(backupFiles);
          expect(success(await call('get_write_request', { request_id: reconcileId }))).toMatchObject({
            request_id: reconcileId, state: 'committed', outcome: applied.outcome,
          });
          expect(inspectLockHolder(config.database_path).pid).toBe(owner!.pid);
          await stop();

          await engine.connect(config);
          expect(await topology(engine)).toEqual(beforeTopology);
          expect(await engine.readPageSnapshot(slug, { sourceId: 'default' })).toEqual(otherSource);
          const durable = (await engine.readPageSnapshot(slug, { sourceId }))!;
          const parsedFile = parseMarkdown(readFileSync(file, 'utf8'), slug);
          expect(durable.page.frontmatter).toEqual(resolved.result.frontmatter);
          expect(parsedFile.frontmatter).toEqual(durable.page.frontmatter);
          expect(parsedFile.compiled_truth).toBe(durable.page.compiled_truth);
          expect(await engine.executeRaw('SELECT fact,source_id,source,visibility,entity_slug,source_markdown_slug FROM facts WHERE id=$1', [Number(remembered.id)]))
            .toEqual([{ fact, source_id: sourceId, source: provenance, visibility: 'private', entity_slug: slug, source_markdown_slug: slug }]);
          expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND fact=$2', [sourceId, fact])).toHaveLength(1);
          expect(await engine.executeRaw('SELECT request_id,state,error_code FROM persistence_requests WHERE request_id=$1::uuid', [blockedId]))
            .toEqual([{ request_id: blockedId, state: blockedError.write_request.state, error_code: 'source_changed' }]);
          expect(await engine.executeRaw('SELECT request_id,operation,source_id,slug,state FROM persistence_requests WHERE request_id IN ($1::uuid,$2::uuid) ORDER BY operation',
            [reconcileId, memoryId])).toEqual([
            { request_id: reconcileId, operation: 'put_page', source_id: sourceId, slug, state: 'committed' },
            { request_id: memoryId, operation: 'remember', source_id: sourceId, slug, state: 'committed' },
          ]);
          expect(await engine.executeRaw('SELECT tombstoned FROM extract_atoms_page_state WHERE page_id=$1', [durable.page.id])).toEqual([]);
          await engine.disconnect();
        });
      } finally {
        await held.lock?.release();
        await stop();
        await engine.disconnect();
        rmSync(home, { recursive: true, force: true });
      }
    }, 240_000);
  }
}
