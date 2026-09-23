import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, chownSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { beginConnectorSync } from '../src/core/persistence/connector-sync.ts';
import { compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, githubConfig, contact, issueFixture, githubFetch, sourceCheckpoint } from './helpers/connector-fixture.ts';

const { engines, env, source, boundSource, standaloneConnector, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

test('explicit connector retry replaces a real storage failure without changing ordinary replay or the cursor', async () => {
  if (process.env.GBRAIN_TEST_CONNECTOR_UNPRIVILEGED === '1') {
    expect(process.getuid?.()).toBe(65534);
    process.stdout.write('CONNECTOR_PERMISSION_UID=65534\n');
  }
  if (process.getuid?.() === 0) {
    const childHome = mkdtempSync(join(tmpdir(), 'gbrain-connector-unprivileged-'));
    chownSync(childHome, 65534, 65534);
    try {
      const child = Bun.spawn(['setpriv', '--reuid=65534', '--regid=65534', '--clear-groups', process.execPath,
        'test', import.meta.path, '--test-name-pattern', '^explicit connector retry replaces a real storage failure without changing ordinary replay or the cursor$'], {
        env: { PATH: process.env.PATH, HOME: childHome, GBRAIN_HOME: childHome, TMPDIR: childHome,
          DATABASE_URL: process.env.DATABASE_URL, GBRAIN_TEST_ALLOW_DATABASE_URL: '1', GBRAIN_CI_DISABLE_TEST_ENV_FILE: '1',
          GBRAIN_PGLITE_SNAPSHOT: process.env.GBRAIN_PGLITE_SNAPSHOT, GBRAIN_TEST_CONNECTOR_UNPRIVILEGED: '1' },
        stdout: 'pipe', stderr: 'pipe',
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect({ stdout, stderr, exitCode }).toMatchObject({ exitCode: 0 });
        expect(stdout).toContain('CONNECTOR_PERMISSION_UID=65534');
        expect(stderr).toContain('1 pass');
        expect(stderr).toContain('0 fail');
        process.stdout.write('CONNECTOR_PERMISSION_UID=65534 child passed the complete EACCES case\n');
      } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; }
    } finally { rmSync(childHome, { recursive: true, force: true }); }
    return;
  }
  await withEnv(env, async () => {
    for (const engine of engines) for (const compact of [false, true]) {
      const f = await boundSource(engine, githubConfig);
      let body = 'Initial retry fixture';
      const run = (retryFailed = false) => runGitHubSync(engine, f.id, parseGitHubSourceConfig(githubConfig, f.dir),
        { ...options, retryFailed, githubItem: { repo: 'acme-example/app', number: 1, kind: 'issue' } },
        async url => new URL(url).pathname.endsWith('/issues/1') ? json({ ...issueFixture, body }) : githubFetch()(url));
      await run();
      await disposePersistenceConsumer(engine);
      const checkpoint = await sourceCheckpoint(engine, f.id);
      const path = join(f.dir, 'gh/acme-example/app/1.md');
      const initial = readFileSync(path, 'utf8');
      body = 'Updated organization retry fixture';
      chmodSync(dirname(path), 0o555);
      try { await expect(run()).rejects.toMatchObject({ code: 'storage_error' }); }
      finally { await disposePersistenceConsumer(engine); chmodSync(dirname(path), 0o755); }
      const [failed] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='failed'", [f.id]);
      expect(failed).toMatchObject({ error_code: 'storage_error', recovery: null });
      expect(readFileSync(path, 'utf8')).toBe(initial);
      expect(await sourceCheckpoint(engine, f.id)).toEqual(checkpoint);
      if (compact) {
        await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '31 days' WHERE id=$1::uuid", [failed.id]);
        expect(await compactWriteReceipts(engine)).toBeGreaterThanOrEqual(1);
        expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [failed.id]))[0]).toMatchObject({ compacted: true, intent: null });
      }
      const [immutable] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [failed.id]);
      await expect(run()).rejects.toMatchObject({ code: 'storage_error', writeRequest: { request_id: failed.request_id } });
      expect((await run(true)).modified).toBe(1);
      expect(readFileSync(path, 'utf8')).toContain(body);
      expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [failed.id]))[0]).toEqual(immutable);
      const retries = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'retryOf'=$2", [f.id, failed.request_id]);
      expect(retries).toHaveLength(1);
      expect(retries[0].state).toBe('committed');
      expect(retries[0].request_id).not.toBe(failed.request_id);
      const effects = await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1 ORDER BY id', [f.id]);
      expect((await run(true)).modified).toBe(0);
      expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1 ORDER BY id', [f.id])).toEqual(effects);
    }
  });
}, 120_000);

const faultEngines = new WeakSet<BrainEngine>();
async function retryFixture(engine: BrainEngine, connector: 'google' | 'github', bound: boolean) {
  if (!faultEngines.has(engine)) {
    await engine.executeRaw('CREATE TABLE connector_retry_faults(source_id text PRIMARY KEY, checkpoint_key text, pages boolean DEFAULT false, checkpoints boolean DEFAULT false, retries boolean DEFAULT false)');
    await engine.executeRaw(`CREATE FUNCTION connector_retry_storage_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF TG_TABLE_NAME='pages' THEN
        IF EXISTS(SELECT 1 FROM connector_retry_faults f WHERE f.source_id=NEW.source_id AND f.pages) THEN
          RAISE EXCEPTION 'Synthetic connector page storage failure' USING ERRCODE='58030';
        END IF;
      ELSIF NEW.op='managed-connector' AND EXISTS(SELECT 1 FROM connector_retry_faults f WHERE f.checkpoint_key=NEW.fingerprint AND f.checkpoints) THEN
        RAISE EXCEPTION 'Synthetic connector checkpoint storage failure' USING ERRCODE='58030';
      ELSIF NEW.op='managed-connector-retry' AND EXISTS(SELECT 1 FROM connector_retry_faults f WHERE f.checkpoint_key=NEW.completed_keys->0->>'checkpointKey' AND f.retries) THEN
        RAISE EXCEPTION 'Synthetic connector approval storage failure' USING ERRCODE='58030';
      END IF;
      RETURN NEW;
    END $$`);
    await engine.executeRaw('CREATE TRIGGER connector_retry_page_fault BEFORE INSERT OR UPDATE ON pages FOR EACH ROW EXECUTE FUNCTION connector_retry_storage_fault()');
    await engine.executeRaw('CREATE TRIGGER connector_retry_checkpoint_fault BEFORE INSERT OR UPDATE ON op_checkpoints FOR EACH ROW EXECUTE FUNCTION connector_retry_storage_fault()');
    faultEngines.add(engine);
  }
  const config = connector === 'google' ? googleConfig : githubConfig;
  const f = bound ? await boundSource(engine, config) : await source(engine, config);
  let updated = false;
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    calls.push(url);
    if (connector === 'google') return json(url.includes('/settings/sendAs') ? { sendAs: [] } : {
      connections: [{ ...contact('first', 'First Example'), organizations: [{ name: updated ? 'Updated retry organization' : 'Initial retry organization' }] }],
      nextSyncToken: updated ? 'contacts-after-retry' : 'contacts-before-retry',
    });
    const path = new URL(url).pathname;
    const issue = { ...issueFixture, body: updated ? 'Updated retry organization' : 'Initial retry organization',
      updated_at: updated ? '2026-01-03T00:00:00Z' : issueFixture.updated_at };
    if (path.endsWith('/issues')) return json([issue]);
    if (path.endsWith('/issues/1')) return json(issue);
    return githubFetch()(url);
  };
  const cfg = connector === 'google' ? parseGoogleSourceConfig(config, f.dir) : parseGitHubSourceConfig(config, f.dir);
  const run = (retryFailed = false) => connector === 'google'
    ? runGoogleSync(engine, f.id, cfg as ReturnType<typeof parseGoogleSourceConfig>, { ...options, retryFailed }, fetcher)
    : runGitHubSync(engine, f.id, cfg as ReturnType<typeof parseGitHubSourceConfig>, { ...options, retryFailed }, fetcher);
  await run();
  await disposePersistenceConsumer(engine);
  const checkpoint = await sourceCheckpoint(engine, f.id);
  const session = (await beginConnectorSync(engine, f.id, connector, cfg, options))!;
  await engine.executeRaw('INSERT INTO connector_retry_faults(source_id,checkpoint_key) VALUES($1,$2)', [f.id, session.checkpointKey]);
  updated = true;
  return { ...f, config, cfg, run, calls, checkpoint, checkpointKey: session.checkpointKey };
}

test('explicit retries survive compaction for bound and database-only Google and GitHub imports without resetting API state', async () => withEnv(env, async () => {
  for (const engine of engines) for (const connector of ['google', 'github'] as const) for (const bound of [false, true]) {
    const f = await retryFixture(engine, connector, bound);
    await engine.executeRaw('UPDATE connector_retry_faults SET pages=true WHERE source_id=$1', [f.id]);
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_error' });
    await disposePersistenceConsumer(engine);
    const [failed] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='failed'", [f.id]);
    expect(failed.recovery).toBeNull();
    expect(await sourceCheckpoint(engine, f.id)).toEqual(f.checkpoint);
    await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '31 days' WHERE id=$1::uuid", [failed.id]);
    await compactWriteReceipts(engine);
    const [immutable] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [failed.id]);
    expect(immutable).toMatchObject({ compacted: true, intent: null });
    await engine.executeRaw('UPDATE connector_retry_faults SET pages=false WHERE source_id=$1', [f.id]);
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_error', writeRequest: { request_id: failed.request_id } });
    f.calls.length = 0;
    expect((await f.run(true)).status).not.toBe('partial');
    expect(f.calls.some(url => connector === 'google' ? url.includes('syncToken=contacts-before-retry')
      : new URL(url).pathname.endsWith('/issues') && new URL(url).searchParams.has('since'))).toBe(true);
    expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [failed.id]))[0]).toEqual(immutable);
    const retries = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'retryOf'=$2", [f.id, failed.request_id]);
    expect(retries).toHaveLength(1);
    expect(retries[0].state).toBe('committed');
    const before = await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1 ORDER BY id', [f.id]);
    expect((await f.run(true)).modified).toBe(0);
    expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1 ORDER BY id', [f.id])).toEqual(before);
  }
}), 120_000);

test('checkpoint storage failures require explicit retry after pages have already committed', async () => withEnv(env, async () => {
  for (const engine of engines) for (const connector of ['google', 'github'] as const) for (const bound of [false, true]) {
    const f = await retryFixture(engine, connector, bound);
    await engine.executeRaw('UPDATE connector_retry_faults SET checkpoints=true WHERE source_id=$1', [f.id]);
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_error' });
    await disposePersistenceConsumer(engine);
    const [failed] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='failed'", [f.id]);
    expect(failed.intent?.kind).toBe('managed_connector_checkpoint');
    expect(await sourceCheckpoint(engine, f.id)).toEqual(f.checkpoint);
    await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '31 days' WHERE id=$1::uuid", [failed.id]);
    await compactWriteReceipts(engine);
    const [immutable] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [failed.id]);
    expect(immutable).toMatchObject({ compacted: true, intent: null });
    await engine.executeRaw('UPDATE connector_retry_faults SET checkpoints=false WHERE source_id=$1', [f.id]);
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_error', writeRequest: { request_id: failed.request_id, compacted: true } });
    const effects = await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1 ORDER BY id', [f.id]);
    expect((await f.run(true)).status).not.toBe('partial');
    expect(await sourceCheckpoint(engine, f.id)).not.toEqual(f.checkpoint);
    expect(await engine.executeRaw('SELECT id FROM persistence_effects WHERE source_id=$1 ORDER BY id', [f.id])).toEqual(effects);
    expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [failed.id]))[0]).toEqual(immutable);
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state='committed' AND intent->>'retryOf'=$2", [f.id, failed.request_id])).toHaveLength(1);
  }
}), 120_000);

test('checkpoint replay keeps its originally admitted page dependencies when another sweep has different receipts', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, githubConfig);
    const cfg = parseGitHubSourceConfig(githubConfig, f.dir);
    const first = (await beginConnectorSync(engine, f.id, 'github', cfg, options))!;
    const second = (await beginConnectorSync(engine, f.id, 'github', cfg, options))!;
    await first.importMarkdown('notes/first.md', '---\ntitle: First fixture\n---\nFirst frozen dependency.\n');
    await second.importMarkdown('notes/second.md', '---\ntitle: Second fixture\n---\nSecond frozen dependency.\n');
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [f.binding.worktree_id]);
    const state = { cursor: 'same-logical-checkpoint' };
    await expect(first.saveState(state, true)).rejects.toMatchObject({ code: 'write_pending' });
    const [accepted] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_connector_checkpoint'", [f.id]);
    const [dependency] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND slug='notes/first'", [f.id]);
    expect(accepted.intent?.receipts).toEqual([dependency.id]);
    await expect(second.saveState(state, true)).rejects.toMatchObject({ code: 'write_pending', writeRequest: { request_id: accepted.request_id } });
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_connector_checkpoint'", [f.id])).toHaveLength(1);
    expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [accepted.id]))[0].intent?.receipts).toEqual([dependency.id]);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [f.binding.worktree_id]);
    expect((await waitForWrite(engine, accepted, { engine: engine.kind })).state).toBe('committed');
    await second.saveState(state, true);
    expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [accepted.id]))[0].intent?.receipts).toEqual([dependency.id]);
    expect((await beginConnectorSync(engine, f.id, 'github', cfg, options))!.state({})).toEqual(state);
  }
}), 120_000);

test('a retry pointer survives real purge and compaction without silently renewing another failed attempt', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await retryFixture(engine, 'google', false);
    await engine.executeRaw('UPDATE connector_retry_faults SET pages=true WHERE source_id=$1', [f.id]);
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_error' });
    await disposePersistenceConsumer(engine);
    const [original] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='failed'", [f.id]);
    await expect(f.run(true)).rejects.toMatchObject({ code: 'storage_error' });
    await disposePersistenceConsumer(engine);
    const failures = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='failed' ORDER BY sequence", [f.id]);
    expect(failures).toHaveLength(2);
    expect(failures[1].intent?.retryOf).toBe(original.request_id);
    await engine.executeRaw("UPDATE persistence_requests SET completed_at=now()-interval '31 days' WHERE source_id=$1 AND state='failed'", [f.id]);
    await compactWriteReceipts(engine);
    const immutable = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='failed' ORDER BY sequence", [f.id]);
    expect(immutable.every(row => row.compacted && row.intent === null)).toBe(true);
    const pointers = await engine.executeRaw("SELECT * FROM op_checkpoints WHERE op='managed-connector-retry' AND completed_keys->0->>'checkpointKey'=$1", [f.checkpointKey]);
    expect(pointers).toHaveLength(1);
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '8 days' WHERE op='managed-connector-retry'");
    await purgeStaleCheckpoints(engine);
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_error', writeRequest: { request_id: failures[1].request_id, compacted: true } });
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state='failed'", [f.id])).toHaveLength(2);
    await engine.executeRaw('UPDATE connector_retry_faults SET pages=false WHERE source_id=$1', [f.id]);
    expect((await f.run(true)).modified).toBe(1);
    expect(await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='failed' ORDER BY sequence", [f.id])).toEqual(immutable);
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state='committed' AND intent->>'retryOf'=$2", [f.id, failures[1].request_id])).toHaveLength(1);
  }
}), 120_000);

test('concurrent connector approvals and a restarted paused owner retain one pending replacement receipt', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await retryFixture(engine, 'github', true);
    await engine.executeRaw('UPDATE connector_retry_faults SET pages=true WHERE source_id=$1', [f.id]);
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_error' });
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE connector_retry_faults SET pages=false WHERE source_id=$1', [f.id]);
    const [original] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='failed'", [f.id]);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [original.worktree_id]);
    const sessions = await Promise.all([1, 2].map(() => beginConnectorSync(engine, f.id, 'github', f.cfg, { ...options, retryFailed: true })));
    const results = await Promise.allSettled(sessions.map(session => session!.importMarkdown(original.intent!.sourcePath as string, original.intent!.content as string)));
    const [retry] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'retryOf'=$2", [f.id, original.request_id]);
    expect(retry).toMatchObject({ state: 'queued' });
    for (const result of results) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toMatchObject({ code: 'write_pending', writeRequest: { request_id: retry.request_id } });
    }
    await disposePersistenceConsumer(engine);
    expect(await sourceCheckpoint(engine, f.id)).toEqual(f.checkpoint);
    const restarted = await standaloneConnector(engine, f, githubConfig, false, true);
    expect(restarted.exitCode).toBe(1);
    expect(restarted.stdout).not.toContain('CONNECTOR_FIXTURE_FETCH');
    expect(JSON.parse(restarted.stdout.split('CONNECTOR_ERROR ')[1].trim())).toMatchObject({ code: 'write_pending', receipt: { request_id: retry.request_id } });
    const count = await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
    await expect(f.run()).rejects.toMatchObject({ code: 'write_pending', writeRequest: { request_id: retry.request_id } });
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id])).toEqual(count);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [original.worktree_id]);
    expect((await f.run(true)).status).not.toBe('partial');
    expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [retry.id]))[0].state).toBe('committed');
    expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [original.id]))[0]).toEqual(original);
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND intent->>'retryOf'=$2", [f.id, original.request_id])).toHaveLength(1);
  }
}), 120_000);

test('concurrent database-only connector retry approvals admit one replacement on both engines', async () => withEnv(env, async () => {
  for (const engine of engines) for (const connector of ['google', 'github'] as const) {
    const f = await retryFixture(engine, connector, false);
    await engine.executeRaw('UPDATE connector_retry_faults SET pages=true WHERE source_id=$1', [f.id]);
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_error' });
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE connector_retry_faults SET pages=false WHERE source_id=$1', [f.id]);
    const [original] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='failed'", [f.id]);
    const sessions = await Promise.all([1, 2].map(() => beginConnectorSync(engine, f.id, connector, f.cfg, { ...options, retryFailed: true })));
    await Promise.all(sessions.map(session => session!.importMarkdown(original.intent!.sourcePath as string, original.intent!.content as string)));
    const retries = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'retryOf'=$2", [f.id, original.request_id]);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ state: 'committed', worktree_id: null });
    expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [original.id]))[0]).toEqual(original);
    expect(await sourceCheckpoint(engine, f.id)).toEqual(f.checkpoint);
    expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-connector-retry' AND completed_keys->0->>'checkpointKey'=$1", [f.checkpointKey])).toHaveLength(1);
  }
}), 120_000);

test('connector retry approval revalidates current and accepted grants plus source and owner changes', async () => withEnv(env, async () => {
  for (const engine of engines) for (const change of ['current-grant', 'accepted-grant', 'config', 'source', 'owner', 'file'] as const) {
    const f = await retryFixture(engine, 'github', true);
    await engine.executeRaw('UPDATE connector_retry_faults SET pages=true WHERE source_id=$1', [f.id]);
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_error' });
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE connector_retry_faults SET pages=false WHERE source_id=$1', [f.id]);
    const [original] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='failed'", [f.id]);
    const [writer] = await engine.executeRaw<{ grant_ceiling: unknown }>('SELECT grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid', [original.principal_id]);
    const session = (await beginConnectorSync(engine, f.id, 'github', f.cfg, { ...options, retryFailed: true }))!;
    const requests = await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    if (change === 'current-grant') await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=jsonb_set(grant_ceiling,'{scopes}','[]'::jsonb) WHERE id=$1::uuid", [original.principal_id]);
    else if (change === 'accepted-grant') await engine.executeRaw("UPDATE persistence_requests SET authority=jsonb_set(authority,'{scopes}','[]'::jsonb) WHERE id=$1::uuid", [original.id]);
    else if (change === 'config') await engine.executeRaw('UPDATE sources SET config=$2::text::jsonb WHERE id=$1', [f.id, JSON.stringify({ ...githubConfig, gh_repos: 'foreign-example/app' })]);
    else if (change === 'source') {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [f.id]);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [f.id, f.dir, JSON.stringify(githubConfig)]);
    } else if (change === 'owner') await engine.executeRaw('UPDATE persistence_worktrees SET owner_epoch=owner_epoch+1 WHERE id=$1::uuid', [original.worktree_id]);
    else {
      const path = join(f.dir, original.intent!.sourcePath as string);
      writeFileSync(path, `${readFileSync(path, 'utf8')}\nOperator edit must not be overwritten by retry.\n`);
    }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    try {
      await expect(session.importMarkdown(original.intent!.sourcePath as string, original.intent!.content as string)).rejects.toMatchObject({
        code: change.endsWith('grant') ? 'permission_denied' : 'source_changed',
      });
      if (change === 'current-grant' || change === 'config') {
        f.calls.length = 0;
        await expect(f.run(true)).rejects.toBeInstanceOf(Error);
        expect(f.calls).toHaveLength(0);
      }
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id])).toEqual(requests);
      expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-connector-retry' AND completed_keys->0->>'checkpointKey'=$1", [f.checkpointKey])).toHaveLength(0);
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_local_writers SET grant_ceiling=$2::text::jsonb WHERE id=$1::uuid', [original.principal_id, JSON.stringify(writer.grant_ceiling)]);
      if (change === 'accepted-grant') await engine.executeRaw('UPDATE persistence_requests SET authority=$2::text::jsonb WHERE id=$1::uuid', [original.id, JSON.stringify(original.authority)]);
    }
  }
}), 120_000);

test('connector retry approval is atomic and a lost acknowledgement reuses the committed pointer', async () => withEnv(env, async () => {
  for (const engine of engines) for (const bound of [false, true]) {
    const f = await retryFixture(engine, 'google', bound);
    await engine.executeRaw('UPDATE connector_retry_faults SET pages=true WHERE source_id=$1', [f.id]);
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_error' });
    await disposePersistenceConsumer(engine);
    const [original] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='failed'", [f.id]);
    const requests = await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id]);
    await engine.executeRaw('UPDATE connector_retry_faults SET pages=false,retries=true WHERE source_id=$1', [f.id]);
    await expect(f.run(true)).rejects.toBeInstanceOf(Error);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [f.id])).toEqual(requests);
    expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-connector-retry' AND completed_keys->0->>'checkpointKey'=$1", [f.checkpointKey])).toHaveLength(0);
    await expect(f.run()).rejects.toMatchObject({ code: 'storage_error', writeRequest: { request_id: original.request_id } });
    await engine.executeRaw('UPDATE connector_retry_faults SET retries=false WHERE source_id=$1', [f.id]);
    const transaction = engine.transaction;
    let lostAck = false;
    engine.transaction = async function <T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
      const result = await transaction.call(this, run) as T;
      const row = result as Partial<WriteRequest> | undefined;
      if (!lostAck && row?.intent?.retryOf === original.request_id && row.state === 'queued') {
        lostAck = true;
        throw new Error('Synthetic lost connector approval acknowledgement');
      }
      return result;
    };
    try { await expect(f.run(true)).rejects.toMatchObject({ code: 'storage_error' }); }
    finally { engine.transaction = transaction; }
    expect(lostAck).toBe(true);
    const [retry] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'retryOf'=$2", [f.id, original.request_id]);
    expect(retry.state).toBe('queued');
    expect(await sourceCheckpoint(engine, f.id)).toEqual(f.checkpoint);
    expect((await f.run(true)).status).not.toBe('partial');
    expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [retry.id]))[0].state).toBe('committed');
    expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND intent->>'retryOf'=$2", [f.id, original.request_id])).toHaveLength(1);
    expect((await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [original.id]))[0]).toEqual(original);
  }
}), 120_000);
