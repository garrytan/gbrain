/**
 * /webhooks/github item-event routing primitives.
 *
 * The Express handler lives inside runServeHttp's closure (see
 * test/sources-webhook.test.ts for the HMAC primitives); these tests pin the
 * module-scope decision helpers it delegates to:
 *
 *   1. githubKindCoversRepo — case-insensitive repo coverage (config list +
 *      auto-scope state file; GitHub repo names are case-insensitive).
 *   2. selectGitHubItemSources — only github-kind sources may service a
 *      github_item refresh; a legacy github_repo push source that verifies
 *      the signature is flagged for ACK-and-ignore, never enqueued (the sync
 *      core rejects github_item on non-github kinds, so the job would die).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { githubKindCoversRepo, selectGitHubItemSources } from '../src/commands/serve-http.ts';
import { submitGitHubItemRefresh } from '../src/commands/serve-http-webhooks.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { surfaceFileSource } from './helpers/source-surface.ts';

describe('githubKindCoversRepo', () => {
  test('scope=repos matches the configured list case-insensitively', () => {
    const cfg = { kind: 'github', gh_scope: 'repos', gh_repos: 'Acme/App, other/repo' };
    expect(githubKindCoversRepo(cfg, null, 'acme/app')).toBe(true);
    expect(githubKindCoversRepo(cfg, null, 'ACME/APP')).toBe(true);
    expect(githubKindCoversRepo(cfg, null, 'other/repo')).toBe(true);
    expect(githubKindCoversRepo(cfg, null, 'acme/nope')).toBe(false);
  });

  test('auto scope matches the state file case-insensitively', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-webhook-state-'));
    try {
      writeFileSync(
        join(dir, '.github-source.json'),
        JSON.stringify({ last_sweep_at: null, repos: ['Acme/App'] }),
        'utf-8',
      );
      expect(githubKindCoversRepo({ kind: 'github' }, dir, 'acme/app')).toBe(true);
      expect(githubKindCoversRepo({ kind: 'github' }, dir, 'AcMe/ApP')).toBe(true);
      expect(githubKindCoversRepo({ kind: 'github' }, dir, 'x/y')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('auto scope without a state file accepts (sync re-checks scope)', () => {
    expect(githubKindCoversRepo({ kind: 'github' }, null, 'a/b')).toBe(true);
    expect(githubKindCoversRepo({ kind: 'github' }, '/nonexistent/path', 'a/b')).toBe(true);
  });
});

describe('selectGitHubItemSources', () => {
  const ghRow = (id: string, secret: string) => ({
    id,
    local_path: null,
    config: { kind: 'github', gh_scope: 'repos', gh_repos: 'acme/app', webhook_secret: secret },
  });
  const legacyRow = (id: string, secret: string) => ({
    id,
    local_path: null,
    config: { github_repo: 'acme/app', webhook_secret: secret },
  });
  const verify = (cfg: Record<string, unknown>): boolean => cfg.webhook_secret === 'good';

  test('legacy-only verified match is flagged, never selected', () => {
    const { verified, legacyMatched } = selectGitHubItemSources([legacyRow('old', 'good')], 'acme/app', verify);
    expect(verified).toEqual([]);
    expect(legacyMatched).toBe(true);
  });

  test('a verifying github-kind source is selected over a non-verifying legacy one', () => {
    const { verified, legacyMatched } = selectGitHubItemSources(
      [legacyRow('old', 'bad'), ghRow('gh', 'good')],
      'acme/app',
      verify,
    );
    expect(verified.map((r) => r.id)).toEqual(['gh']);
    expect(legacyMatched).toBe(false);
  });

  test('two verifying github-kind sources stay ambiguous (both returned)', () => {
    const { verified } = selectGitHubItemSources([ghRow('a', 'good'), ghRow('b', 'good')], 'acme/app', verify);
    expect(verified.map((r) => r.id)).toEqual(['a', 'b']);
  });

  test('mixed-case config entries and string-typed config rows both match', () => {
    const row = {
      id: 'gh',
      local_path: null,
      config: JSON.stringify({ kind: 'github', gh_scope: 'repos', gh_repos: 'Acme/App', webhook_secret: 'good' }),
    };
    const { verified } = selectGitHubItemSources([row], 'acme/app', verify);
    expect(verified.map((r) => r.id)).toEqual(['gh']);
  });

  test('out-of-scope github-kind source neither verifies nor flags legacy', () => {
    const { verified, legacyMatched } = selectGitHubItemSources([ghRow('gh', 'good')], 'other/repo', verify);
    expect(verified).toEqual([]);
    expect(legacyMatched).toBe(false);
  });
});

describe('handler wiring (source pin)', () => {
  test('legacy-only match ACKs 202 ignored before any job submission', () => {
    const src = surfaceFileSource('serve-http', 'src/commands/serve-http-webhooks.ts');
    const guard = src.indexOf('verified.length === 0 && legacyMatched');
    const enqueue = src.indexOf('github_item:', guard);
    expect(guard).toBeGreaterThan(0);
    expect(enqueue).toBeGreaterThan(guard);
    const ackSlice = src.slice(guard, enqueue);
    expect(ackSlice).toContain("res.status(202).json({ status: 'ignored'");
  });
});

describe('submitGitHubItemRefresh (item-event job coalescing)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  }, 60_000);

  beforeEach(async () => {
    await engine.executeRaw(`DELETE FROM minion_jobs`, []);
  });

  const item = (number: number) => ({ repo: 'acme-example/app', number, kind: 'issue' as const });
  const queuedItems = async () =>
    (await engine.executeRaw<{ n: string; status: string }>(
      `SELECT data->'github_item'->>'number' AS n, status FROM minion_jobs ORDER BY id`, [],
    )).map((r) => `${r.n}:${r.status}`);

  test('events for different items of one source each get their own job', async () => {
    const a = await submitGitHubItemRefresh(engine, 'gh-example', item(1));
    const b = await submitGitHubItemRefresh(engine, 'gh-example', item(2));
    expect(b.id).not.toBe(a.id);
    expect(b.coalesced).not.toBe(true);
    expect(await queuedItems()).toEqual(['1:waiting', '2:waiting']);
  });

  test('a repeat event for the same item folds into its waiting job', async () => {
    const a = await submitGitHubItemRefresh(engine, 'gh-example', item(1));
    const again = await submitGitHubItemRefresh(engine, 'gh-example', item(1));
    expect(again.id).toBe(a.id);
    expect(again.coalesced).toBe(true);
    expect(await queuedItems()).toEqual(['1:waiting']);
  });

  test('an event after the item job started or finished queues a fresh refresh', async () => {
    for (const status of ['active', 'completed']) {
      await engine.executeRaw(`DELETE FROM minion_jobs`, []);
      const first = await submitGitHubItemRefresh(engine, 'gh-example', item(1));
      const queue = new MinionQueue(engine);
      expect((await queue.claim('worker-1', 300_000, 'default', ['sync']))?.id).toBe(first.id);
      if (status === 'completed') await queue.completeJob(first.id, 'worker-1');
      const later = await submitGitHubItemRefresh(engine, 'gh-example', item(1));
      expect(later.id).not.toBe(first.id);
      expect(later.coalesced).not.toBe(true);
      expect(await queuedItems()).toEqual([`1:${status}`, '1:waiting']);
    }
  });
});
