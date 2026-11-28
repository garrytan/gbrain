/**
 * #10578: a GitHub sweep that keeps stopping short (a job deadline, a run budget) still finishes. The source cursor stays
 * put until a sweep completes, so a run under the same cursor resumes from the sweep ledger instead of re-reading every
 * page the last run already handled.
 * Fails when: repeated budget-bounded runs never finish, a resumed run reads or fetches an item the last run finished,
 * a changed or failed item is skipped on the strength of an old entry, a damaged ledger is trusted, a stop counts as an
 * item failure, a completed sweep keeps its ledger, or a managed deadline stop advances the cursor or loses the ledger.
 * Classic runs on PGLite; the managed case runs on PGLite, and on Postgres too when DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { parseGitHubSourceConfig, runGitHubSync, type GitHubSourceConfig } from '../src/core/github-source.ts';
import { createConnectorFixture, githubConfig, issueFixture, json, options, sourceCheckpoint } from './helpers/connector-fixture.ts';

type Issue = typeof issueFixture;
const issues = (count: number, repo: string): Issue[] => Array.from({ length: count }, (_, index) => ({
  ...issueFixture, number: index + 1, title: `Synthetic issue ${index + 1}`, body: `Synthetic body ${index + 1}.`,
  updated_at: `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00Z`, html_url: `https://github.com/${repo}/issues/${index + 1}`,
}));

/** A GitHub API over `items`; `calls` records each path, `block` holds an item's detail fetch until its signal aborts. */
function api(repo: string, items: Issue[], calls: string[], block?: { number: number; fired?: boolean }) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const u = new URL(url);
    calls.push(u.pathname);
    if (u.pathname === `/repos/${repo}/issues`) {
      const since = u.searchParams.get('since');
      return json(items.filter(item => !since || item.updated_at > since));
    }
    if (u.pathname === `/repos/${repo}/pulls` || u.pathname.endsWith('/comments')) return json([]);
    if (u.pathname === `/repos/${repo}`) return json({ full_name: repo, private: true, archived: false, default_branch: 'main', description: null });
    const detail = u.pathname.match(/\/issues\/(\d+)$/);
    if (detail) {
      const number = Number(detail[1]);
      if (block?.number === number && init?.signal) {
        const signal = init.signal;
        return new Promise<Response>((_, reject) => {
          const stop = () => { block.fired = true; reject(signal.reason); };
          if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
        });
      }
      const item = items.find(entry => entry.number === number);
      return item ? json(item) : json({ message: 'not found' }, 404);
    }
    return json({ message: `unexpected ${u.pathname}` }, 404);
  };
}

describe('classic GitHub sweep ledger', () => {
  const repo = 'acme/app';
  let engine: PGLiteEngine;
  let dir: string;
  let cfg: GitHubSourceConfig;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => {
    await resetPgliteState(engine);
    // Database-only pages: every freshness check is a page read, the cost a large managed source pays per item.
    await engine.setConfig('sync.write_through', 'false');
    dir = mkdtempSync(join(tmpdir(), 'ghsrc-ledger-'));
    cfg = { tokenEnv: 'GH_TOKEN', app: null, scope: 'repos', repos: [repo], dir };
    await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)',
      ['ghsrc', dir, JSON.stringify({ kind: 'github', gh_token_env: 'GH_TOKEN', gh_scope: 'repos', gh_repos: repo })]);
  });

  const state = () => JSON.parse(readFileSync(join(dir, '.github-source.json'), 'utf-8')) as { last_sweep_at: string | null; sweep_progress?: Record<string, unknown> };
  const detailed = async (count: number) => (await engine.executeRaw<{ n: number }>(
    "SELECT count(*)::int AS n FROM pages WHERE source_id='ghsrc' AND slug ~ '^gh/acme/app/[0-9]+$' AND frontmatter->>'detail_fetched' IS DISTINCT FROM 'false'"))[0]!.n === count;

  /** One run that stops once it has read `budget` pages, the way a job deadline stops a run that spent its time on reads. */
  async function budgetRun(fetchImpl: ReturnType<typeof api>, budget: number) {
    const stop = new AbortController();
    let reads = 0;
    const getPage = engine.getPage;
    engine.getPage = (async function (this: BrainEngine, ...args: Parameters<BrainEngine['getPage']>) {
      if (args[1]?.sourceId === 'ghsrc' && ++reads >= budget) stop.abort();
      return getPage.apply(this, args);
    }) as BrainEngine['getPage'];
    try {
      return await runGitHubSync(engine, 'ghsrc', cfg, { sourceId: 'ghsrc', noExtract: true, noEmbed: true, signal: stop.signal }, fetchImpl);
    } finally { engine.getPage = getPage; }
  }

  test('a sweep whose every run stops after a fixed number of page reads still finishes', () => withEnv({ GH_TOKEN: 'test-token' }, async () => {
    const items = issues(12, repo);
    const calls: string[] = [];
    const fetchImpl = api(repo, items, calls);
    const statuses: string[] = [];
    for (let run = 0; run < 12 && statuses.at(-1) !== 'synced'; run++) statuses.push((await budgetRun(fetchImpl, 24)).status);
    expect(statuses.at(-1)).toBe('synced');
    expect(await detailed(12)).toBe(true);
    expect(state().last_sweep_at).toBe(items.at(-1)!.updated_at);
    expect(state().sweep_progress).toBeUndefined();
    // Each item's detail was fetched once across all the runs.
    for (const item of items) expect(calls.filter(path => path === `/repos/${repo}/issues/${item.number}`)).toHaveLength(1);
  }), 180_000);

  test('a changed item is checked again, a failed item keeps no entry, and a stop is not an item failure', () => withEnv({ GH_TOKEN: 'test-token' }, async () => {
    const items = issues(3, repo);
    const calls: string[] = [];
    const block = { number: 3 } as { number: number; fired?: boolean };
    const stop = new AbortController();
    const fetchImpl = api(repo, items, calls, block);
    const stopping = async (url: string, init?: RequestInit) => {
      if (url.endsWith('/issues/3')) queueMicrotask(() => stop.abort());
      return fetchImpl(url, init);
    };
    const first = await runGitHubSync(engine, 'ghsrc', cfg, { sourceId: 'ghsrc', noExtract: true, noEmbed: true, signal: stop.signal }, stopping);
    expect(first.status).toBe('partial');
    expect(block.fired).toBe(true);
    expect(state().sweep_progress).toMatchObject({ since: null, full: false,
      done: { 'acme/app#1': `issue:open:${items[0]!.updated_at}`, 'acme/app#2': `issue:open:${items[1]!.updated_at}` },
      listed: { 'acme/app#3': `issue:open:${items[2]!.updated_at}` } });
    // The stopped fetch of #3 is not a failure: nothing is held or failing.
    expect(JSON.stringify(state())).not.toContain('failing');

    items[0] = { ...items[0]!, updated_at: '2026-03-01T00:00:00Z', body: 'Changed upstream.' };
    calls.length = 0;
    const second = await runGitHubSync(engine, 'ghsrc', cfg, { sourceId: 'ghsrc', noExtract: true, noEmbed: true }, api(repo, items, calls));
    expect(second.status).toBe('synced');
    expect(calls).toContain('/repos/acme/app/issues/1');
    expect(calls).toContain('/repos/acme/app/issues/3');
    expect(calls).not.toContain('/repos/acme/app/issues/2');
    expect((await engine.getPage('gh/acme/app/1', { sourceId: 'ghsrc' }))?.compiled_truth).toContain('Changed upstream.');
    expect(state().sweep_progress).toBeUndefined();
  }), 120_000);

  test('a newly added repo with a failed item is not marked bootstrapped, so the next run lists its history again', () => withEnv({ GH_TOKEN: 'test-token' }, async () => {
    const items = issues(2, repo);
    writeFileSync(join(dir, '.github-source.json'), JSON.stringify({ last_sweep_at: '2026-03-01T00:00:00Z', repos: [] }));
    const calls: string[] = [];
    const fetchImpl = api(repo, items, calls);
    const failing = async (url: string, init?: RequestInit) => url.endsWith('/issues/2') ? json({ message: 'synthetic failure' }, 500) : fetchImpl(url, init);
    expect((await runGitHubSync(engine, 'ghsrc', cfg, { sourceId: 'ghsrc', noExtract: true, noEmbed: true }, failing)).status).toBe('partial');
    expect((JSON.parse(readFileSync(join(dir, '.github-source.json'), 'utf-8')) as { repos: string[] }).repos).toEqual([]);
    calls.length = 0;
    await runGitHubSync(engine, 'ghsrc', cfg, { sourceId: 'ghsrc', noExtract: true, noEmbed: true }, fetchImpl);
    expect(calls).toContain('/repos/acme/app/issues/2');
    expect(await detailed(2)).toBe(true);
  }), 120_000);

  test('an unreadable state file reads as no state instead of stopping the sweep', () => withEnv({ GH_TOKEN: 'test-token' }, async () => {
    writeFileSync(join(dir, '.github-source.json'), '{}');
    chmodSync(join(dir, '.github-source.json'), 0o000);
    const calls: string[] = [];
    expect(['synced', 'first_sync']).toContain((await runGitHubSync(engine, 'ghsrc', cfg, { sourceId: 'ghsrc', noExtract: true, noEmbed: true }, api(repo, issues(1, repo), calls))).status);
    expect(calls).toContain('/repos/acme/app/issues/1');
  }), 120_000);

  test('a damaged ledger is ignored and every item is checked again', () => withEnv({ GH_TOKEN: 'test-token' }, async () => {
    const items = issues(2, repo);
    for (const damaged of [
      { since: null, full: false, done: { '../../etc#1': 'issue:open:x' }, listed: {} },
      { since: null, full: false, done: { 'acme/app#1': 7 }, listed: {} },
      { since: null, full: 'no', done: {}, listed: {} },
      { since: null, full: false, done: ['acme/app#1'] },
      'not an object',
    ]) {
      await resetPgliteState(engine);
      await engine.setConfig('sync.write_through', 'false');
      await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)',
        ['ghsrc', dir, JSON.stringify({ kind: 'github', gh_token_env: 'GH_TOKEN', gh_scope: 'repos', gh_repos: repo })]);
      writeFileSync(join(dir, '.github-source.json'), JSON.stringify({ last_sweep_at: null, repos: [], sweep_progress: damaged }));
      const calls: string[] = [];
      expect(['synced', 'first_sync']).toContain((await runGitHubSync(engine, 'ghsrc', cfg, { sourceId: 'ghsrc', noExtract: true, noEmbed: true }, api(repo, items, calls))).status);
      expect(calls).toContain('/repos/acme/app/issues/1');
      expect(calls).toContain('/repos/acme/app/issues/2');
      expect(await detailed(2)).toBe(true);
    }
    rmSync(dir, { recursive: true, force: true });
  }), 120_000);
});

describe('managed GitHub sweep ledger', () => {
  const repo = 'acme-example/app';
  const { engines, env, source, setup, teardown } = createConnectorFixture();
  beforeAll(setup, 120_000);
  afterAll(teardown);

  test('a deadline stop saves what it finished without moving the cursor, and the next run resumes without re-reading it', () => withEnv(env, async () => {
    for (const engine of engines) {
      const f = await source(engine, githubConfig);
      const cfg = parseGitHubSourceConfig(githubConfig, f.dir);
      const items = issues(4, repo);
      const calls: string[] = [];
      const block = { number: 3 } as { number: number; fired?: boolean };
      const stopped = await runGitHubSync(engine, f.id, cfg, { ...options, deadlineAtMs: Date.now() + 3_000 }, api(repo, items, calls, block));
      expect(block.fired).toBe(true);
      expect(stopped).toMatchObject({ status: 'partial', reason: 'timeout' });
      const [row] = await sourceCheckpoint(engine, f.id) as Array<{ completed_keys: Array<{ state: Record<string, unknown> }> }>;
      const saved = row!.completed_keys[0]!.state;
      expect(saved.last_sweep_at ?? null).toBeNull();
      expect(saved.sweep_progress).toMatchObject({ since: null, full: false,
        done: { [`${repo}#1`]: `issue:open:${items[0]!.updated_at}`, [`${repo}#2`]: `issue:open:${items[1]!.updated_at}` } });
      expect((await engine.executeRaw<{ last_sync_at: unknown }>('SELECT last_sync_at FROM sources WHERE id=$1', [f.id]))[0]!.last_sync_at).toBeNull();

      const reads: string[] = [];
      const readPageSnapshot = engine.readPageSnapshot;
      engine.readPageSnapshot = (async function (this: BrainEngine, slug, opts) {
        if (opts?.sourceId === f.id) reads.push(slug);
        return readPageSnapshot.call(this, slug, opts);
      }) as BrainEngine['readPageSnapshot'];
      calls.length = 0;
      let resumed;
      try { resumed = await runGitHubSync(engine, f.id, cfg, options, api(repo, items, calls)); }
      finally { engine.readPageSnapshot = readPageSnapshot; }
      expect(resumed.status).not.toBe('partial');
      for (const number of [1, 2]) {
        expect(reads).not.toContain(`gh/${repo}/${number}`);
        expect(calls).not.toContain(`/repos/${repo}/issues/${number}`);
      }
      for (const number of [3, 4]) {
        expect(calls).toContain(`/repos/${repo}/issues/${number}`);
        expect((await engine.getPage(`gh/${repo}/${number}`, { sourceId: f.id }))?.compiled_truth).toContain(`Synthetic body ${number}.`);
      }
      const [done] = await sourceCheckpoint(engine, f.id) as Array<{ completed_keys: Array<{ state: Record<string, unknown> }> }>;
      expect(done!.completed_keys[0]!.state.last_sweep_at).toBe(items.at(-1)!.updated_at);
      expect(done!.completed_keys[0]!.state.sweep_progress).toBeUndefined();
    }
  }), 180_000);
});
