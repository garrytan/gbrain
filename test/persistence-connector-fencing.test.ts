import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performSync } from '../src/commands/sync.ts';
import { syncLockId } from '../src/core/db-lock.ts';
import { parseGitHubSourceConfig, runGitHubSync } from '../src/core/github-source.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { acquireWorktree } from '../src/core/persistence/ownership.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, githubConfig, contact, issueFixture, githubFetch, sourceCheckpoint } from './helpers/connector-fixture.ts';

const { engines, env, source, boundSource, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

for (const bound of [false, true]) {
  test(`normalized GitHub identities preserve physical paths through first/repeat/delete (${bound ? 'bound' : 'database'})`, async () => withEnv(env, async () => {
    for (const engine of engines) {
      const config = { ...githubConfig, gh_repos: 'Acme-Example/Tools--Archive' };
      const f = await (bound ? boundSource : source)(engine, config);
      const cfg = parseGitHubSourceConfig(config, f.dir);
      const calls: string[] = [];
      const fetcher = async (url: string) => {
        calls.push(url);
        return githubFetch()(url.replaceAll('tools--archive', 'app'));
      };
      expect((await runGitHubSync(engine, f.id, cfg, options, fetcher)).added).toBe(2);
      const slug = 'gh/acme-example/tools-archive/1';
      const path = 'gh/acme-example/tools--archive/1.md';
      expect((await engine.getPage(slug, { sourceId: f.id }))?.source_path).toBe(path);
      expect(existsSync(join(f.dir, path))).toBe(bound);
      expect(existsSync(join(f.dir, `${slug}.md`))).toBe(false);
      if (bound) expect(readFileSync(join(f.dir, path), 'utf8')).toContain('synthetic issue');
      await disposePersistenceConsumer(engine);
      calls.length = 0;
      const repeat = await runGitHubSync(engine, f.id, cfg, options, fetcher);
      expect(repeat.added).toBe(0);
      expect(repeat.modified).toBe(0);
      expect(calls.some(url => new URL(url).pathname.endsWith('/issues/1'))).toBe(false);
      expect(await engine.executeRaw('SELECT slug FROM pages WHERE source_id=$1', [f.id])).toHaveLength(2);
      const deleted = await runGitHubSync(engine, f.id, cfg, { ...options,
        githubItem: { repo: 'Acme-Example/Tools--Archive', number: 1, kind: 'issue', deleted: true } }, fetcher);
      expect(deleted.deleted).toBe(1);
      expect(await engine.getPage(slug, { sourceId: f.id })).toBeNull();
      expect(existsSync(join(f.dir, path))).toBe(false);
    }
  }), 120_000);
}

for (const connector of ['github', 'google'] as const) {
  test(`${connector} rejects overlapping direct and command sweeps before provider work, even with skipLock`, async () => withEnv(env, async () => {
    for (const engine of engines) {
      const config = connector === 'github' ? githubConfig : googleConfig;
      const f = await boundSource(engine, config);
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      let calls = 0;
      const fetcher = async (url: string) => {
        calls++;
        if (new URL(url).pathname.endsWith('/issues/1') || url.includes('/people/me/connections')) {
          entered.resolve();
          await released.promise;
          if (connector === 'google') return json({ connections: [contact('first', 'First Example')], nextSyncToken: 'first' });
        }
        if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
        return githubFetch()(url);
      };
      const run = () => connector === 'github'
        ? runGitHubSync(engine, f.id, parseGitHubSourceConfig(config, f.dir), { ...options, skipLock: true,
          githubItem: { repo: 'acme-example/app', number: 1, kind: 'issue' } }, fetcher)
        : runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), { ...options, skipLock: true }, fetcher);
      const first = run();
      first.catch(() => {});
      await entered.promise;
      try {
        const canonical = await acquireWorktree(f.binding, 100);
        expect(canonical).not.toBeNull();
        await canonical?.release();
        const before = calls;
        const second = run();
        second.catch(() => {});
        const result = await Promise.race([second.then(() => 'published', error => error.name), Bun.sleep(1000).then(() => 'fetching')]);
        const after = calls;
        released.resolve();
        await Promise.allSettled([first, second]);
        expect(result).toBe('LockUnavailableError');
        expect(after).toBe(before);
      } finally { released.resolve(); await first.catch(() => {}); }
      const originalFetch = globalThis.fetch;
      const delayed = Promise.withResolvers<void>();
      const again = Promise.withResolvers<void>();
      globalThis.fetch = (async (url: string | URL | Request) => {
        again.resolve();
        await delayed.promise;
        return fetcher(String(url));
      }) as typeof fetch;
      const command = performSync(engine, { ...options, sourceId: f.id, full: true, skipLock: true, lockId: 'caller-cannot-bypass-source-lease' });
      command.catch(() => {});
      try {
        await again.promise;
        await expect(run()).rejects.toMatchObject({ name: 'LockUnavailableError', lockId: syncLockId(f.id) });
      } finally {
        delayed.resolve();
        try { await command; } finally { globalThis.fetch = originalFetch; }
      }
      expect(await engine.executeRaw('SELECT id FROM gbrain_cycle_locks WHERE id=$1', [syncLockId(f.id)])).toHaveLength(0);
    }
  }), 120_000);

  test(`${connector} discards delayed old responses after lease loss and restarts from the surviving checkpoint`, async () => withEnv(env, async () => {
    for (const engine of engines) for (const bound of [false, true]) {
      const config = connector === 'github' ? githubConfig : googleConfig;
      const f = await (bound ? boundSource : source)(engine, config);
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const run = (old: boolean) => {
        const fetcher = async (url: string) => {
          if (url.includes('/settings/sendAs')) return json({ sendAs: [] });
          if (new URL(url).pathname.endsWith('/issues/1') || url.includes('/people/me/connections')) {
            if (old) { entered.resolve(); await released.promise; }
            return connector === 'github' ? json({ ...issueFixture, body: old ? 'Old response' : 'Newest response' })
              : json({ connections: [{ ...contact('first', 'First Example'), organizations: [{ name: old ? 'Old response' : 'Newest response' }] }], nextSyncToken: old ? 'old' : 'new' });
          }
          return githubFetch()(url);
        };
        return connector === 'github'
          ? runGitHubSync(engine, f.id, parseGitHubSourceConfig(config, f.dir), { ...options,
            githubItem: { repo: 'acme-example/app', number: 1, kind: 'issue' } }, fetcher)
          : runGoogleSync(engine, f.id, parseGoogleSourceConfig(config, f.dir), options, fetcher);
      };
      const old = run(true);
      old.catch(() => {});
      await entered.promise;
      try {
        await engine.executeRaw('DELETE FROM gbrain_cycle_locks WHERE id=$1', [syncLockId(f.id)]);
        await run(false);
        const checkpoint = await sourceCheckpoint(engine, f.id);
        const receipts = await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id]);
        released.resolve();
        const [result] = await Promise.allSettled([old]);
        const slug = connector === 'github' ? 'gh/acme-example/app/1' : 'people/first-example';
        expect((await engine.getPage(slug, { sourceId: f.id }))?.compiled_truth).toContain('Newest response');
        if (bound) expect(readFileSync(join(f.dir, `${slug}.md`), 'utf8')).toContain('Newest response');
        expect(result).toMatchObject({ status: 'rejected', reason: { name: 'LockStolenError' } });
        expect(await sourceCheckpoint(engine, f.id)).toEqual(checkpoint);
        expect(await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [f.id])).toEqual(receipts);
        await disposePersistenceConsumer(engine);
        expect((await run(false)).status).not.toBe('partial');
      } finally { released.resolve(); await old.catch(() => {}); }
    }
  }), 120_000);
}
