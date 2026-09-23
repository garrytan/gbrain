import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer, startPersistenceConsumer, waitForWrite } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { withEnv } from './helpers/with-env.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { createConnectorFixture, options, json, googleConfig, githubConfig, contact, issueFixture, githubFetch, sourceCheckpoint } from './helpers/connector-fixture.ts';

const { home, engines, env, source, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

test('public Google sync journals DB-only imports and repeat/restart checkpoints on both engines', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { kind: 'google', g_account: 'owner@example.invalid', g_services: 'contacts', g_access: 'env', g_token_env: 'CONNECTOR_TEST_TOKEN' };
    const f = await source(engine, config);
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      if (url.includes('/people/me/connections')) return json({ connections: [{ resourceName: 'people/fixture-1', names: [{ displayName: 'Example Contact' }], emailAddresses: [{ value: 'contact@example.invalid' }] }], nextSyncToken: 'contacts-1' });
      throw new Error('Unexpected external fixture route');
    };
    const cfg = parseGoogleSourceConfig(config, f.dir);
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).added).toBe(1);
    const pages = await engine.executeRaw<{ slug: string; source_path: string }>('SELECT slug,source_path FROM pages WHERE source_id=$1', [f.id]);
    expect(pages).toHaveLength(1);
    expect(existsSync(join(f.dir, pages[0].source_path))).toBe(false);
    const [receipt] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_connector_import' ORDER BY sequence LIMIT 1", [f.id]);
    expect(receipt.authority.databaseOnlyReason).toBe('connector_database');
    expect(receipt.outcome?.write_through).toEqual({ written: false, skipped: 'connector_database' });
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1 AND state<>\'committed\'', [f.id])).toHaveLength(0);
    await disposePersistenceConsumer(engine);
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).added).toBe(0);
    expect(calls.some(url => url.includes('syncToken=contacts-1'))).toBe(true);
  }
}), 120_000);

test('public GitHub sync imports real pages without a Git cursor or filesystem publication', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { kind: 'github', gh_scope: 'repos', gh_repos: 'acme-example/app', gh_token_env: 'CONNECTOR_TEST_TOKEN' };
    const f = await source(engine, config);
    const issue = { number: 1, title: 'Example issue', state: 'open', body: 'A useful synthetic issue body.', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z', labels: [], assignees: [], user: { login: 'example-user' }, html_url: 'https://github.com/acme-example/app/issues/1' };
    const fetcher = async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/issues')) return json([issue]);
      if (path.endsWith('/pulls') || path.endsWith('/comments')) return json([]);
      if (path.endsWith('/issues/1')) return json(issue);
      if (path === '/repos/acme-example/app') return json({ full_name: 'acme-example/app', private: true, default_branch: 'main' });
      throw new Error('Unexpected external fixture route');
    };
    const cfg = parseGitHubSourceConfig(config, f.dir);
    const result = await runGitHubSync(engine, f.id, cfg, options, fetcher);
    expect(result.status).not.toBe('partial');
    expect((await engine.getPage('gh/acme-example/app/1', { sourceId: f.id }))?.compiled_truth).toContain('synthetic issue');
    expect(existsSync(join(f.dir, 'gh/acme-example/app/1.md'))).toBe(false);
    expect(await engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync'")).toHaveLength(0);
  }
}), 120_000);

test('Google pagination failure never advances a checkpoint; tombstones delete only the selected source', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    let fail = true;
    let deleted = false;
    const fetcher = async (url: string) => {
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      const u = new URL(url);
      if (u.searchParams.has('syncToken')) return json({ connections: deleted ? [{ resourceName: 'people/first', metadata: { deleted: true } }] : [], nextSyncToken: 'contacts-next' });
      if (!u.searchParams.has('pageToken')) return json({ connections: [contact('first', 'First Example')], nextPageToken: 'second' });
      if (fail) return json({ error: { message: 'fixture pagination failure' } }, 400);
      return json({ connections: [contact('second', 'Second Example')], nextSyncToken: 'contacts-complete' });
    };
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).status).toBe('partial');
    expect(await sourceCheckpoint(engine, f.id)).toHaveLength(0);
    expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1', [f.id])).toHaveLength(0);
    fail = false;
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).added).toBe(2);
    const other = await source(engine, googleConfig);
    expect((await runGoogleSync(engine, other.id, parseGoogleSourceConfig(googleConfig, other.dir), options, fetcher)).added).toBe(2);
    deleted = true;
    const checkpoint = await sourceCheckpoint(engine, f.id);
    const executeRaw = engine.executeRaw;
    engine.executeRaw = async function (sql: string, params?: unknown[]) {
      if (sql.includes("frontmatter->>'google_contact_id'")) throw new Error('Synthetic identity lookup unavailable');
      return executeRaw.call(engine, sql, params);
    } as BrainEngine['executeRaw'];
    try {
      expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).status).toBe('partial');
      expect(await sourceCheckpoint(engine, f.id)).toEqual(checkpoint);
    } finally { engine.executeRaw = executeRaw; }
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).deleted).toBe(1);
    expect(await engine.getPage('people/first-example', { sourceId: f.id })).toBeNull();
    expect(await engine.getPage('people/first-example', { sourceId: other.id })).not.toBeNull();
  }
}), 120_000);

test('GitHub partial detail and pagination do not advance freshness or delete successfully imported pages', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, githubConfig);
    const cfg = parseGitHubSourceConfig(githubConfig, f.dir);
    expect((await runGitHubSync(engine, f.id, cfg, options, githubFetch({ failDetail: true }))).status).toBe('partial');
    expect((await engine.getPage('gh/acme-example/app/1', { sourceId: f.id }))?.frontmatter.detail_fetched).toBe(false);
    expect(await sourceCheckpoint(engine, f.id)).toHaveLength(0);
    expect((await engine.executeRaw<{ last_sync_at: unknown }>('SELECT last_sync_at FROM sources WHERE id=$1', [f.id]))[0].last_sync_at).toBeNull();
    await disposePersistenceConsumer(engine);
    expect((await runGitHubSync(engine, f.id, cfg, options, githubFetch())).status).not.toBe('partial');
    const checkpoint = await sourceCheckpoint(engine, f.id);
    expect((await runGitHubSync(engine, f.id, cfg, { ...options, full: true }, githubFetch({ failSecondPage: true }))).status).toBe('partial');
    expect(await sourceCheckpoint(engine, f.id)).toEqual(checkpoint);
    expect(await engine.getPage('gh/acme-example/app/1', { sourceId: f.id })).not.toBeNull();
    expect((await runGitHubSync(engine, f.id, cfg, { ...options, githubItem: { repo: 'acme-example/app', number: 1, kind: 'issue', deleted: true } }, githubFetch())).deleted).toBe(1);
    expect(await engine.getPage('gh/acme-example/app/1', { sourceId: f.id })).toBeNull();
  }
}), 120_000);

test('remote, narrowed, and mismatched connector authority is refused before external requests', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, githubConfig);
    const cfg = parseGitHubSourceConfig(githubConfig, f.dir);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await importFromContent(engine, 'gh/acme-example/app/1', '---\ntitle: Private fixture\nvisibility: private\n---\nPrivate fixture content must remain untouched.\n', { sourceId: f.id, noEmbed: true });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const calls: string[] = [];
    const run = () => runGitHubSync(engine, f.id, cfg, options, githubFetch({ calls }));
    const stdio = await registerLocalWriter(engine, 'stdio');
    await expect(withVerifiedLocalRegistration(engine, stdio, run)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(withSubmissionAuthority({ version: 1, kind: 'remote_agent', principal: { kind: 'oauth_client', id: 'fixture-client' }, grant: { scopes: ['admin'], sourceId: f.id, sourceCreatedAt: new Date().toISOString(), allowedTools: ['submit_job'], allowedSlugPrefixes: ['*'] }, payloadHash: 'fixture' }, run)).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(runGitHubSync(engine, f.id, { ...cfg, repos: ['foreign-example/app'] }, options, githubFetch({ calls }))).rejects.toMatchObject({ code: 'source_changed' });
    const cli = await registerLocalWriter(engine, 'cli');
    const [saved] = await engine.executeRaw<{ grant_ceiling: unknown }>('SELECT grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid', [cli.id]);
    try {
      await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=jsonb_set(grant_ceiling,'{sourceIds}','[]'::jsonb) WHERE id=$1::uuid", [cli.id]);
      await expect(run()).rejects.toMatchObject({ code: 'permission_denied' });
    } finally { await engine.executeRaw('UPDATE persistence_local_writers SET grant_ceiling=$2::text::jsonb WHERE id=$1::uuid', [cli.id, JSON.stringify(saved.grant_ceiling)]); }
    expect(calls).toHaveLength(0);
    expect((await engine.getPage('gh/acme-example/app/1', { sourceId: f.id }))?.frontmatter.visibility).toBe('private');
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(0);
    await run();
    expect((await engine.getPage('gh/acme-example/app/1', { sourceId: f.id }))?.frontmatter.visibility).toBe('private');
  }
}), 120_000);

test('managed connectors refuse unsupported dry runs and Git filters before credentials or external work', async () => withEnv(env, async () => {
  for (const engine of engines) for (const connector of ['google', 'github'] as const) {
    const config = connector === 'google' ? googleConfig : githubConfig;
    const f = await source(engine, config);
    let calls = 0;
    const fetcher = async () => { calls++; throw new Error('Unexpected external request'); };
    for (const mode of [{ dryRun: true }, { skipFailed: true }, { srcSubpath: 'scoped' },
      { exclude: ['private/**'] }, { includeHidden: ['.notes/**'] }, { includeGitignored: true }, { workingTree: true }, { strategy: 'code' as const }]) {
      const run = connector === 'google'
        ? runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), { ...options, ...mode }, fetcher)
        : runGitHubSync(engine, f.id, parseGitHubSourceConfig(config, f.dir), { ...options, ...mode }, fetcher);
      await expect(run).rejects.toMatchObject({ code: 'invalid_params' });
    }
    expect(calls).toBe(0);
    expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(0);
  }
}), 120_000);

test('source replacement after connector preflight cannot receive the old sweep on either engine', async () => withEnv(env, async () => {
  for (const engine of engines) for (const connector of ['google', 'github'] as const) {
    const config = connector === 'google' ? googleConfig : githubConfig;
    const f = await source(engine, config);
    let replaced = false;
    const fetcher = async (url: string) => {
      if (!replaced) {
        replaced = true;
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('DELETE FROM sources WHERE id=$1', [f.id]);
        await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [f.id, f.dir, JSON.stringify(config)]);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
      if (connector === 'github') return githubFetch()(url);
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      return json({ connections: [contact('first', 'First Example')], nextSyncToken: 'stale-source-token' });
    };
    const run = connector === 'google'
      ? runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), options, fetcher)
      : runGitHubSync(engine, f.id, parseGitHubSourceConfig(config, f.dir), options, fetcher);
    await expect(run).rejects.toMatchObject({ code: 'source_changed' });
    expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1', [f.id])).toHaveLength(0);
    expect((await engine.executeRaw<{ last_sync_at: unknown }>('SELECT last_sync_at FROM sources WHERE id=$1', [f.id]))[0].last_sync_at).toBeNull();
  }
}), 120_000);

test('Google Gmail and Calendar ingest, fail without advancing, restart, and delete via the public entry', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const config = { ...googleConfig, g_services: 'gmail,calendar' };
    const f = await source(engine, config);
    const cfg = parseGoogleSourceConfig(config, f.dir);
    const at = Math.floor(Date.now() / 1000) * 1000 - 60_000;
    const threadId = '17aa00000000a001';
    let delta = false;
    let fail = false;
    let removed = false;
    const fetcher = async (url: string) => {
      const u = new URL(url);
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      if (url.includes('/profile')) return json({ emailAddress: config.g_account, historyId: '100' });
      if (url.includes('/calendar/')) return json({ items: removed ? [{ id: 'example-event', status: 'cancelled' }] : [{ id: 'example-event', summary: 'Example planning', status: 'confirmed', start: { dateTime: new Date(at).toISOString() }, end: { dateTime: new Date(at + 3600_000).toISOString() } }], nextSyncToken: removed ? 'calendar-2' : 'calendar-1' });
      if (url.includes('/messages?')) {
        const q = u.searchParams.get('q') ?? '';
        const before = q.match(/before:(\d+)/)?.[1];
        return json({ messages: removed || before && Number(before) * 1000 <= at ? [] : [{ id: '17bb00000000a001', threadId }] });
      }
      if (url.includes('/history?')) return json({ historyId: delta ? '200' : '100', history: delta && !removed ? [{ messagesAdded: [{ message: { id: '17bb00000000a001', threadId } }] }] : [] });
      if (url.includes('/threads/')) {
        if (fail) return json({ error: { message: 'fixture unavailable' } }, 400);
        return json({ id: threadId, messages: [{ id: '17bb00000000a001', threadId, internalDate: String(at), labelIds: ['INBOX'], payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'sender@example.invalid' }, { name: 'To', value: config.g_account }, { name: 'Subject', value: 'Example question' }], body: { data: Buffer.from('Could you review the example plan?').toString('base64url') } } }] });
      }
      throw new Error('Unexpected external fixture route');
    };
    const first = await runGoogleSync(engine, f.id, cfg, options, fetcher);
    expect(first.status).not.toBe('partial');
    expect(first.added).toBe(2);
    const checkpoint = await sourceCheckpoint(engine, f.id);
    delta = true;
    fail = true;
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).status).toBe('partial');
    expect(await sourceCheckpoint(engine, f.id)).toEqual(checkpoint);
    fail = false;
    await disposePersistenceConsumer(engine);
    expect((await runGoogleSync(engine, f.id, cfg, options, fetcher)).status).not.toBe('partial');
    removed = true;
    expect((await runGoogleSync(engine, f.id, cfg, { ...options, full: true }, fetcher)).deleted).toBe(2);
    expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [f.id])).toHaveLength(0);
  }
}), 120_000);

test('paused connector owner returns one stable receipt and resident restart consumes its frozen import', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, githubConfig);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const binding = await claimWorktree(engine, f.id, f.dir);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding.worktree_id]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const cfg = parseGitHubSourceConfig(githubConfig, f.dir);
    const run = () => runGitHubSync(engine, f.id, cfg, options, githubFetch());
    let requestId = '';
    try { await run(); throw new Error('Expected pending receipt'); }
    catch (error) {
      expect(error).toMatchObject({ code: 'write_pending' });
      requestId = (error as { writeRequest: { request_id: string } }).writeRequest.request_id;
    }
    await expect(run()).rejects.toMatchObject({ code: 'write_pending', writeRequest: { request_id: requestId } });
    const rows = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1', [f.id]);
    expect(rows).toHaveLength(1);
    expect(await sourceCheckpoint(engine, f.id)).toHaveLength(0);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [binding.worktree_id]);
    startPersistenceConsumer(engine, { engine: engine.kind });
    expect((await waitForWrite(engine, rows[0], { engine: engine.kind })).state).toBe('committed');
    expect(await engine.getPage('gh/acme-example/app/1', { sourceId: f.id })).not.toBeNull();
    expect(readFileSync(join(f.dir, 'gh/acme-example/app/1.md'), 'utf8')).toContain('synthetic issue');
  }
}), 120_000);

test('bound connector directories publish import, update, unchanged replay, and delete with their DB receipts', async () => withEnv(env, async () => {
  for (const engine of engines) for (const connector of ['google', 'github'] as const) {
    const config = connector === 'google' ? googleConfig : githubConfig;
    const f = await boundSource(engine, config);
    let body = 'Initial organization';
    let deleted = false;
    const fetcher = async (url: string) => {
      if (connector === 'github') {
        if (new URL(url).pathname.endsWith('/issues/1')) return json({ ...issueFixture, body });
        return githubFetch()(url);
      }
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      return json({ connections: deleted ? [{ resourceName: 'people/first', metadata: { deleted: true } }]
        : [{ ...contact('first', 'First Example'), organizations: [{ name: body }] }], nextSyncToken: 'contacts-bound' });
    };
    const run = () => connector === 'google'
      ? runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), options, fetcher)
      : runGitHubSync(engine, f.id, parseGitHubSourceConfig(config, f.dir), { ...options, githubItem: { repo: 'acme-example/app', number: 1, kind: 'issue', deleted } }, fetcher);
    const slug = connector === 'google' ? 'people/first-example' : 'gh/acme-example/app/1';
    const path = join(f.dir, `${slug}.md`);
    expect((await run()).added).toBe(1);
    expect(readFileSync(path, 'utf8')).toContain(body);
    const [receipt] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_connector_import' ORDER BY sequence LIMIT 1", [f.id]);
    expect(receipt.outcome?.persistence).toEqual({ mode: 'filesystem', file_written: true, git_state: 'queued' });
    expect(receipt.authority.databaseOnlyReason).toBeUndefined();
    const first = readFileSync(path, 'utf8');
    await disposePersistenceConsumer(engine);
    expect((await run()).modified).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(first);
    body = 'Updated organization';
    expect((await run()).modified).toBe(1);
    const page = await engine.getPage(slug, { sourceId: f.id });
    expect(page).not.toBeNull();
    expect(parseMarkdown(readFileSync(path, 'utf8'), slug).compiled_truth).toBe(page!.compiled_truth);
    expect(readFileSync(path, 'utf8')).toContain(body);
    deleted = true;
    expect((await run()).deleted).toBe(1);
    expect(existsSync(path)).toBe(false);
    expect(await engine.getPage(slug, { sourceId: f.id })).toBeNull();
    expect((await run()).deleted).toBe(0);
  }
}), 120_000);

test('invalid bound connector roots refuse before any external request', async () => withEnv(env, async () => {
  for (const engine of engines) for (const invalid of ['source-root', 'physical-root', 'foreign-owner', 'lock-file'] as const) {
    const f = await boundSource(engine, githubConfig);
    const alternate = join(home, `alternate-${randomUUID()}`);
    mkdirSync(alternate);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    if (invalid === 'source-root') await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [f.id, alternate]);
    else if (invalid === 'foreign-owner') await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [f.binding.worktree_id, randomUUID()]);
    else if (invalid === 'lock-file') { renameSync(f.binding.coordination_path!, `${f.binding.coordination_path}-old`); mkdirSync(f.binding.coordination_path!); }
    else { renameSync(f.dir, `${f.dir}-old`); mkdirSync(f.dir); }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const calls: string[] = [];
    const cfg = parseGitHubSourceConfig(githubConfig, invalid === 'source-root' ? alternate : f.dir);
    try {
      await expect(runGitHubSync(engine, f.id, cfg, options, githubFetch({ calls }))).rejects.toBeInstanceOf(Error);
      expect(calls).toHaveLength(0);
      expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toHaveLength(0);
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      if (invalid === 'source-root') await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [f.id, f.dir]);
      else if (invalid === 'foreign-owner') await engine.executeRaw('UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [f.binding.worktree_id, f.binding.owner_host_id]);
      else if (invalid === 'lock-file') { rmSync(f.binding.coordination_path!, { recursive: true }); renameSync(`${f.binding.coordination_path}-old`, f.binding.coordination_path!); }
      else { rmSync(f.dir, { recursive: true }); renameSync(`${f.dir}-old`, f.dir); }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }
}), 120_000);

test('previously materialized connector pages stay canonical-file backed with managed writer enforcement', async () => withEnv(env, async () => {
  for (const engine of engines) for (const connector of ['google', 'github'] as const) {
    const config = connector === 'google' ? googleConfig : githubConfig;
    const f = await source(engine, config);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    let body = 'Legacy organization';
    const fetcher = async (url: string) => {
      if (connector === 'github') return new URL(url).pathname.endsWith('/issues/1') ? json({ ...issueFixture, body }) : githubFetch()(url);
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      return json({ connections: [{ ...contact('first', 'First Example'), organizations: [{ name: body }] }], nextSyncToken: 'contacts-legacy' });
    };
    const run = () => connector === 'google'
      ? runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), options, fetcher)
      : runGitHubSync(engine, f.id, parseGitHubSourceConfig(config, f.dir), { ...options, githubItem: { repo: 'acme-example/app', number: 1, kind: 'issue' } }, fetcher);
    await run();
    const slug = connector === 'google' ? 'people/first-example' : 'gh/acme-example/app/1';
    const path = join(f.dir, `${slug}.md`);
    expect(readFileSync(path, 'utf8')).toContain('Legacy organization');
    await claimWorktree(engine, f.id, f.dir);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    body = 'Managed organization';
    expect((await run()).modified).toBe(1);
    expect(readFileSync(path, 'utf8')).toContain('Managed organization');
    const page = await engine.getPage(slug, { sourceId: f.id });
    expect(page).not.toBeNull();
    expect(parseMarkdown(readFileSync(path, 'utf8'), slug).compiled_truth).toBe(page!.compiled_truth);
    expect(page?.source_path).toBe(`${slug}.md`);
  }
}), 120_000);

test('a file edit after bound connector admission survives resident replay and prevents checkpoint advancement', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await boundSource(engine, githubConfig);
    let body = 'Original bound body';
    const fetcher = async (url: string) => new URL(url).pathname.endsWith('/issues/1') ? json({ ...issueFixture, body }) : githubFetch()(url);
    const run = () => runGitHubSync(engine, f.id, parseGitHubSourceConfig(githubConfig, f.dir), { ...options, githubItem: { repo: 'acme-example/app', number: 1, kind: 'issue' } }, fetcher);
    await run();
    await disposePersistenceConsumer(engine);
    const checkpoint = await sourceCheckpoint(engine, f.id);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [f.binding.worktree_id]);
    body = 'New API body';
    await expect(run()).rejects.toMatchObject({ code: 'write_pending' });
    const [accepted] = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND state='queued' ORDER BY sequence LIMIT 1", [f.id]);
    await disposePersistenceConsumer(engine);
    const path = join(f.dir, 'gh/acme-example/app/1.md');
    const edited = readFileSync(path, 'utf8') + '\n';
    writeFileSync(path, edited);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [f.binding.worktree_id]);
    const done = await waitForWrite(engine, accepted, { engine: engine.kind });
    expect(done).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
    expect(readFileSync(path, 'utf8')).toBe(edited);
    expect((await engine.getPage('gh/acme-example/app/1', { sourceId: f.id }))?.compiled_truth).toContain('Original bound body');
    expect(await sourceCheckpoint(engine, f.id)).toEqual(checkpoint);
  }
}), 120_000);

test('competing Google sweeps CAS their checkpoints instead of skipping each other', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const cfg = parseGoogleSourceConfig(googleConfig, f.dir);
    let arrived = 0;
    let release!: () => void;
    let entered!: () => void;
    const firstFetch = new Promise<void>(resolve => { entered = resolve; });
    const both = new Promise<void>(resolve => { release = resolve; });
    const run = (token: string) => runGoogleSync(engine, f.id, cfg, options, async url => {
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      arrived++;
      entered();
      await both;
      return json({ connections: [contact(token, `${token} Example`)], nextSyncToken: token });
    });
    const first = run('first');
    await firstFetch;
    const second = run('second');
    const settled = second.finally(release);
    settled.catch(() => {});
    const timer = setTimeout(release, 1000);
    const results = await Promise.allSettled([first, settled]).finally(() => clearTimeout(timer));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ name: 'LockUnavailableError' });
    expect(arrived).toBe(1);
    expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL', [f.id])).toHaveLength(1);
  }
}), 120_000);

test('resident publication revalidates accepted connector revisions, incarnations, roots, and writer grants', async () => withEnv(env, async () => {
  for (const engine of engines) for (const change of ['page', 'source', 'root', 'grant'] as const) {
    const f = await source(engine, githubConfig);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const binding = await claimWorktree(engine, f.id, f.dir);
    await engine.executeRaw("UPDATE persistence_worktrees SET state='draining' WHERE id=$1::uuid", [binding.worktree_id]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await expect(runGitHubSync(engine, f.id, parseGitHubSourceConfig(githubConfig, f.dir), options, githubFetch())).rejects.toMatchObject({ code: 'write_pending' });
    const [accepted] = await engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE source_id=$1', [f.id]);
    await disposePersistenceConsumer(engine);
    const [writer] = await engine.executeRaw<{ grant_ceiling: unknown }>('SELECT grant_ceiling FROM persistence_local_writers WHERE id=$1::uuid', [accepted.principal_id]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    if (change === 'page') {
      await importFromContent(engine, 'gh/acme-example/app/1', '---\ntitle: Newer private fixture\nvisibility: private\n---\nNewer local content must survive.\n', { sourceId: f.id, sourcePath: 'gh/acme-example/app/1.md', noEmbed: true });
    } else if (change === 'source') {
      await engine.executeRaw('DELETE FROM sources WHERE id=$1', [f.id]);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [f.id, f.dir, JSON.stringify(githubConfig)]);
    } else if (change === 'root') {
      const alternate = join(home, `changed-root-${randomUUID()}`);
      mkdirSync(alternate);
      await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', [f.id, alternate]);
    } else {
      await engine.executeRaw("UPDATE persistence_local_writers SET grant_ceiling=jsonb_set(grant_ceiling,'{scopes}','[]'::jsonb) WHERE id=$1::uuid", [accepted.principal_id]);
    }
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await engine.executeRaw("UPDATE persistence_worktrees SET state='active' WHERE id=$1::uuid", [binding.worktree_id]);
    try {
      const done = await waitForWrite(engine, accepted, { engine: engine.kind });
      expect(done.state).toBe(change === 'grant' ? 'failed' : 'conflict');
      expect(done.error_code).toBe(change === 'grant' ? 'permission_denied' : change === 'page' ? 'revision_conflict' : 'source_changed');
      expect(await sourceCheckpoint(engine, f.id)).toHaveLength(0);
      const page = await engine.getPage('gh/acme-example/app/1', { sourceId: f.id });
      if (change === 'page') {
        expect(page?.compiled_truth).toContain('Newer local content');
        expect(page?.frontmatter.visibility).toBe('private');
      } else expect(page).toBeNull();
    } finally {
      await engine.executeRaw('UPDATE persistence_local_writers SET grant_ceiling=$2::text::jsonb WHERE id=$1::uuid', [accepted.principal_id, JSON.stringify(writer.grant_ceiling)]);
    }
  }
}), 120_000);

test('aged live connector cursors survive actual checkpoint purge and normal incremental resume', async () => withEnv(env, async () => {
  for (const engine of engines) for (const connector of ['google', 'github'] as const) {
    const config = connector === 'google' ? googleConfig : githubConfig;
    const f = await source(engine, config);
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url);
      if (connector === 'github') return githubFetch()(url);
      if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
      return json({ connections: [contact('first', 'First Example')], nextSyncToken: 'retained-contacts-cursor' });
    };
    const run = () => connector === 'google'
      ? runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), options, fetcher)
      : runGitHubSync(engine, f.id, parseGitHubSourceConfig(config, f.dir), options, fetcher);
    await run();
    await disposePersistenceConsumer(engine);
    const checkpoint = await sourceCheckpoint(engine, f.id);
    expect(checkpoint).toHaveLength(1);
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '8 days' WHERE op='managed-connector'");
    const stale = randomUUID();
    await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES('embed',$1,'[]'::jsonb,now()-interval '8 days')", [stale]);
    expect(await purgeStaleCheckpoints(engine)).toBeGreaterThanOrEqual(1);
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='embed' AND fingerprint=$1", [stale])).toHaveLength(0);
    expect(await sourceCheckpoint(engine, f.id)).toEqual(checkpoint);
    calls.length = 0;
    expect((await run()).status).not.toBe('partial');
    expect(calls.some(url => connector === 'google' ? url.includes('syncToken=retained-contacts-cursor')
      : new URL(url).pathname.endsWith('/issues') && new URL(url).searchParams.has('since'))).toBe(true);
  }
}), 120_000);
