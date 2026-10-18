/**
 * GBRA-130 A-18: the legacy sync failure ledger (src/core/sync-failure-ledger.ts)
 * classified a per-file failure by running embedding-infra regexes over the
 * whole error text, path included: `EACCES: permission denied, open
 * '…/billing/q3.md'` became EMBEDDING_QUOTA (bare /billing/), and a file named
 * `http-429.md` or `rate-limit.md` became EMBEDDING_RATE_LIMIT. Infra codes
 * are never chronic, so the gate blocked the source forever (the blocked run
 * keeps its pin, so later commits never imported) and the blocked message said
 * not to use --skip-failed.
 *
 * Authoring gate: (1) protects "a deterministic per-file failure goes chronic
 * and auto-skips; only a recognized provider error is infra": the import path
 * carries a structured code (errno -> PERMISSION_DENIED / FILE_UNREADABLE), the
 * text classifier never reads errno-led messages or path tokens as provider
 * errors, and an infra code on one file while other files import fine goes
 * chronic as EMBEDDING_INFRA_ISOLATED, also when resumed runs re-attempt it
 * alone (the files an earlier run of the drain banked count). A run-scoped error during an import
 * stops the sync and records nothing; a run where most files fail counts no
 * attempt and points at --skip-failed. (2) Reverting the classifier or the
 * structured code makes the item case red (4 blocked runs, new.md never
 * imported). (3) test/sync-embedding-infra-gate.test.ts covers the infra codes
 * with provider-shaped messages only, never a path that looks like one. (4)
 * No production seam: the file is made unreadable with chmod; run-scoped
 * errors are injected by wrapping the engine.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { applySyncFailureGate, classifyErrorCode, loadSyncFailures } from '../../src/core/sync-failure-ledger.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { permsEnforced } from '../helpers/fs-perms.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const md = (title: string) => `---\ntitle: ${title}\ntype: note\n---\nThe ${title} note.\n`;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const perms = permsEnforced();

interface Repo { engine: BrainEngine; root: string; sourceId: string; commit(files: Record<string, string>, msg: string): void;
  sync(opts?: { skipFailed?: boolean; engine?: BrainEngine }): ReturnType<typeof performSync>; lastCommit(): Promise<string | null> }

/** A legacy (unmanaged) source on a temp git repo whose first sync imported seed.md; the ledger lives under the temp home.
 *  concurrency 1: Postgres import workers connect to the configured database_url, not the isolated test database. */
function legacyRepo(databaseUrl: string | undefined, run: (r: Repo) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-a18-'));
  const root = join(home, 'repo');
  mkdirSync(root);
  return withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SYNC_AUTOSKIP_AFTER: '3' }, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
      const commit = (files: Record<string, string>, msg: string) => {
        for (const [path, body] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
        git(root, 'add', '--', ...Object.keys(files)); git(root, 'commit', '-qm', msg);
      };
      commit({ 'seed.md': md('seed') }, 'seed');
      const sourceId = `a18${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [sourceId, root]);
      const sync = (opts: { skipFailed?: boolean; engine?: BrainEngine } = {}) =>
        performSync(opts.engine ?? engine, { repoPath: root, sourceId, noPull: true, noEmbed: true, noExtract: true, concurrency: 1, skipFailed: opts.skipFailed });
      expect((await sync()).status).toBe('first_sync');
      const lastCommit = async () => (await engine.executeRaw<{ c: string | null }>('SELECT last_commit AS c FROM sources WHERE id=$1', [sourceId]))[0]?.c ?? null;
      await run({ engine, root, sourceId, commit, sync, lastCommit });
    } finally {
      await close();
      try { execFileSync('chmod', ['-R', 'u+rwX', home]); } catch { /* best effort */ }
      rmSync(home, { recursive: true, force: true });
    }
  });
}

const row = (sourceId: string, path: string) => loadSyncFailures().find(f => f.source_id === sourceId && f.path === path);

describe('A-18 classifier: errno-led messages and path text are never provider errors', () => {
  test('an EACCES under billing/ and a file named after a status code keep their file codes', () => {
    expect(classifyErrorCode("EACCES: permission denied, open '/r/billing/q3.md'")).toBe('PERMISSION_DENIED');
    expect(classifyErrorCode("ENOENT: no such file or directory, open '/r/notes/rate-limit.md'")).toBe('FILE_UNREADABLE');
    expect(classifyErrorCode('Decode failed for /r/img/http-429.png', 'img/http-429.png')).toBe('UNKNOWN');
    expect(classifyErrorCode('embedMultimodal failed for /r/billing/scan.png: invalid image', 'billing/scan.png')).toBe('UNKNOWN');
  });

  test('provider-shaped messages still classify as infra', () => {
    expect(classifyErrorCode('[embed(openai:text-embedding-3-small)] 429 too many requests', 'notes/http-429.md')).toBe('EMBEDDING_RATE_LIMIT');
    expect(classifyErrorCode('[embed(openai:text-embedding-3-small)] You exceeded your current quota', 'billing/q3.md')).toBe('EMBEDDING_QUOTA');
  });
});

describe('A-18 gate: an infra code on one file while the others import goes chronic with its own code', () => {
  const gate = (sourceId: string, imported: number) => applySyncFailureGate({ sourceId, commit: 'c1', skipFailed: false, advance: () => {},
    failedFiles: [{ path: 'img/huge.png', error: '[embedMultimodal(voyage:voyage-multimodal-3)] The operation timed out.', code: 'EMBEDDING_TIMEOUT' }],
    succeededPaths: imported > 0 ? ['a.md', 'b.md'] : [], imported });

  test('three runs with other files importing auto-skip it as EMBEDDING_INFRA_ISOLATED', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-a18-gate-'));
    return withEnv({ GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SYNC_AUTOSKIP_AFTER: '3' }, async () => {
      try {
        const outcomes = [];
        for (let i = 0; i < 3; i++) outcomes.push(await gate('alpha-example', 2));
        expect(outcomes.map(o => o.advanced)).toEqual([false, false, true]);
        expect(outcomes[2]!.autoSkipped).toEqual(['img/huge.png']);
        expect({ state: row('alpha-example', 'img/huge.png')?.state, code: row('alpha-example', 'img/huge.png')?.code })
          .toEqual({ state: 'auto_skipped', code: 'EMBEDDING_INFRA_ISOLATED' });
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });

  test('runs where nothing else imports (the provider is down) never auto-skip it', () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-a18-gate-'));
    return withEnv({ GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SYNC_AUTOSKIP_AFTER: '3' }, async () => {
      try {
        for (let i = 0; i < 5; i++) expect((await gate('beta-example', 0)).advanced).toBe(false);
        expect(row('beta-example', 'img/huge.png')?.state).toBe('open');
      } finally { rmSync(home, { recursive: true, force: true }); }
    });
  });
});

/** The engine whose page reads inside a file's import (importOnePath) throw `error`, for every slug or the ones `only` picks. */
function failingImports(engine: BrainEngine, error: unknown, only: (slug: unknown) => boolean = () => true): BrainEngine {
  return new Proxy(engine, { get(target, prop) {
    const value = Reflect.get(target, prop);
    if (prop === 'getPage' && typeof value === 'function') {
      return (...args: unknown[]) => new Error().stack?.includes('importOnePath') && only(args[0]) ? Promise.reject(error) : (value as Function).apply(target, args);
    }
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`A-18 legacy sync: an unreadable file under billing/ goes chronic and auto-skips (${backend})`, () => {
    test.skipIf(!perms)('A-18 item: billing/q3.md (mode 000) is PERMISSION_DENIED, auto-skips on run 3, and a later commit imports on run 4', () => legacyRepo(databaseUrl, async r => {
      r.commit({ 'ok.md': md('ok'), 'billing/q3.md': md('q3') }, 'add');
      chmodSync(join(r.root, 'billing', 'q3.md'), 0o000);
      const first = await expectUnitNotAborted(() => r.sync());
      expect({ status: first.status, codes: first.failureCodes }).toEqual({ status: 'blocked_by_failures', codes: [{ code: 'PERMISSION_DENIED', count: 1 }] });
      const before = await snapshotItems(r.engine, r.sourceId);
      r.commit({ 'new.md': md('new') }, 'later');
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push(await expectUnitNotAborted(() => r.sync()));
      expect(runs.map(x => x.status)).toEqual(['blocked_by_failures', 'synced', 'synced']);
      expect(await r.engine.getPage('new', { sourceId: r.sourceId })).not.toBeNull();
      const failure = row(r.sourceId, 'billing/q3.md');
      expect(failure?.state).toBe('auto_skipped');
      expectItemFailure({ key: failure?.path, code: failure?.code }, { key: 'billing/q3.md', code: 'PERMISSION_DENIED' });
      expectOthersUnchanged(before, await snapshotItems(r.engine, r.sourceId));
    }), 180_000);

    test.skipIf(!perms)('A-18 item: five unreadable files among six readable ones still auto-skip on run 3 (a resumed run counts the banked files)', () => legacyRepo(databaseUrl, async r => {
      const locked = ['l1', 'l2', 'l3', 'l4', 'l5'].map(n => `locked/${n}.md`);
      r.commit(Object.fromEntries([...locked.map(p => [p, md(p)]), ...['o1', 'o2', 'o3', 'o4', 'o5', 'o6'].map(n => [`ok/${n}.md`, md(n)])]), 'mixed');
      for (const path of locked) chmodSync(join(r.root, path), 0o000);
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push(await expectUnitNotAborted(() => r.sync()));
      expect(runs.map(x => x.status)).toEqual(['blocked_by_failures', 'blocked_by_failures', 'synced']);
      expect(loadSyncFailures().filter(f => f.source_id === r.sourceId).map(f => [f.path, f.state]).sort()).toEqual(locked.map(p => [p, 'auto_skipped']));
    }), 180_000);

    test('A-18 item: an embedding timeout on one file among six that import goes chronic on resumed runs (the banked imports count) and drains on run 3', () => legacyRepo(databaseUrl, async r => {
      const healthy = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(n => `ok/${n}.md`);
      r.commit(Object.fromEntries([...healthy.map(p => [p, md(p)]), ['img/huge.md', md('huge')]]), 'mixed');
      const timeout = new Error('[embed(openai:text-embedding-3-small)] The operation timed out.');
      const engine = failingImports(r.engine, timeout, slug => slug === 'img/huge');
      const runs = [];
      for (let i = 0; i < 3; i++) {
        const result = await expectUnitNotAborted(() => r.sync({ engine }));
        const failure = row(r.sourceId, 'img/huge.md');
        runs.push({ status: result.status, codes: result.failureCodes, isolated: failure?.state === 'open' ? failure.infra_isolated_runs : failure?.state });
      }
      const timedOut = [{ code: 'EMBEDDING_TIMEOUT', count: 1 }];
      expect(runs).toEqual([{ status: 'blocked_by_failures', codes: timedOut, isolated: 1 }, { status: 'blocked_by_failures', codes: timedOut, isolated: 2 },
        { status: 'synced', codes: undefined, isolated: 'auto_skipped' }]);
      expect({ state: row(r.sourceId, 'img/huge.md')?.state, code: row(r.sourceId, 'img/huge.md')?.code })
        .toEqual({ state: 'auto_skipped', code: 'EMBEDDING_INFRA_ISOLATED' });
      expect(await r.lastCommit()).toBe(git(r.root, 'rev-parse', 'HEAD'));
      for (const path of healthy) expect(await r.engine.getPage(path.slice(0, -3), { sourceId: r.sourceId })).not.toBeNull();
    }), 180_000);

    test.skipIf(!perms)('A-18 recovery: once the file is readable and edited, the next sync imports it and clears its row', () => legacyRepo(databaseUrl, async r => {
      r.commit({ 'ok.md': md('ok'), 'billing/q3.md': md('q3') }, 'add');
      chmodSync(join(r.root, 'billing', 'q3.md'), 0o000);
      for (let i = 0; i < 3; i++) await r.sync();
      expect(row(r.sourceId, 'billing/q3.md')?.state).toBe('auto_skipped');
      chmodSync(join(r.root, 'billing', 'q3.md'), 0o644);
      r.commit({ 'billing/q3.md': md('q3 revised') }, 'fix');
      const before = await snapshotItems(r.engine, r.sourceId);
      expect((await expectUnitNotAborted(() => r.sync())).status).toBe('synced');
      expect(await r.engine.getPage('billing/q3', { sourceId: r.sourceId })).not.toBeNull();
      expect(row(r.sourceId, 'billing/q3.md')).toBeUndefined();
      expectOthersUnchanged(before, await snapshotItems(r.engine, r.sourceId));
    }), 180_000);

    for (const { name, error } of runScopedErrors()) {
      test(`A-18 run: a run-scoped ${name} while importing a file stops the sync and records no ledger row`, () => legacyRepo(databaseUrl, async r => {
        r.commit({ 'ok.md': md('ok'), 'other.md': md('other') }, 'add');
        const before = await snapshotItems(r.engine, r.sourceId);
        const pinned = await r.lastCommit();
        const injected = error();
        let thrown: unknown;
        const result = await r.sync({ engine: failingImports(r.engine, injected) }).catch(e => { thrown = e; return null; });
        expect({ result: result?.status ?? null, thrown: thrown === injected }).toEqual({ result: null, thrown: true });
        expect(loadSyncFailures().filter(f => f.source_id === r.sourceId)).toEqual([]);
        expect(await r.lastCommit()).toBe(pinned);
        expectOthersUnchanged(before, await snapshotItems(r.engine, r.sourceId));
      }), 180_000);
    }

    test.skipIf(!perms)('A-18 breaker: when most files fail the run counts no attempt, never auto-skips, and --skip-failed is the named exit', () => legacyRepo(databaseUrl, async r => {
      const files = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map(n => [`locked/${n}.md`, md(n)]));
      r.commit(files, 'locked');
      for (const path of Object.keys(files)) chmodSync(join(r.root, path), 0o000);
      const runs = [];
      for (let i = 0; i < 4; i++) runs.push(await expectUnitNotAborted(() => r.sync()));
      expect(runs.map(x => x.status)).toEqual(Array(4).fill('blocked_by_failures'));
      expect(loadSyncFailures().filter(f => f.source_id === r.sourceId).map(f => [f.path, f.state, f.attempts]).sort())
        .toEqual(Object.keys(files).map(path => [path, 'open', 1]));
      const acked = await expectUnitNotAborted(() => r.sync({ skipFailed: true }));
      expect(acked.status).toBe('synced');
    }), 240_000);
  });
}
