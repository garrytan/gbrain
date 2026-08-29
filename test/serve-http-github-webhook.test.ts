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
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { githubKindCoversRepo, selectGitHubItemSources } from '../src/commands/serve-http.ts';

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
    const src = readFileSync(new URL('../src/commands/serve-http.ts', import.meta.url), 'utf8');
    const guard = src.indexOf('verified.length === 0 && legacyMatched');
    const enqueue = src.indexOf('github_item:', guard);
    expect(guard).toBeGreaterThan(0);
    expect(enqueue).toBeGreaterThan(guard);
    const ackSlice = src.slice(guard, enqueue);
    expect(ackSlice).toContain("res.status(202).json({ status: 'ignored'");
  });
});
