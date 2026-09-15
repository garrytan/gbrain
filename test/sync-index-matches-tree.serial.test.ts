/**
 * One invariant, four lifecycle stages (#4899, #4900):
 *
 *   after ANY sync that reports success, the set of pages for the source
 *   equals the set of syncable files in the working tree.
 *
 * The two failure signatures name which fix regressed:
 *
 *   missing: [...]  -> performSyncInner no longer resolves the source's
 *                      persisted `config.strategy`, so a caller that passes
 *                      no --strategy walks as 'markdown' and code files are
 *                      never imported (and modified ones are DELETED).
 *   ghosts:  [...]  -> importCodeFile no longer writes `source_path`, so the
 *                      full-sync delete-reconcile cannot see code pages and
 *                      deleted files are served forever.
 *
 * The `strategy precedence` block pins the other half of that resolution: an
 * explicit `strategy` option beats the persisted `config.strategy`, and a
 * persisted value outside markdown|code|auto is IGNORED (classifySync in
 * core/sync.ts then falls back to 'markdown'), never honored.
 *
 * HONEST LIMIT: drift() derives both sides from gbrain's own enumerator and
 * slug function, so it pins the sync WIRING, not the enumerator itself. The
 * literal slug list in S1 is the only assertion here that does not derive
 * from the code under test; keep it.
 *
 * Hermetic: in-memory PGLite + a throwaway git repo under $TMPDIR. No
 * network, no Neon, no fixtures on disk. ~7s.
 *
 * Setup is lazy (ensureSetup) rather than in beforeAll ON PURPOSE: bun caps
 * HOOKS at a hard 5s and bunfig.toml's `timeout = 60_000` does NOT govern
 * them (measured: an 8s beforeAll dies at 5002ms under a bare `bun test`,
 * and passes with --timeout=60000). PGLite connect+initSchema sits right at
 * that edge, so a beforeAll here would flake on the first cold run after a
 * rebase — the one run that matters.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync } from 'fs';
import { join, relative } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { collectSyncableFiles } from '../src/commands/import.ts';
import { resolveSlugForPath } from '../src/core/sync.ts';

const SID = 'default';
const STRATEGY = 'auto' as const;
// No `strategy` key: this is the caller shape used by the dream cycle
// (core/cycle.ts), the MCP sync op (core/operations.ts), the autopilot
// freshness lane and the single-source CLI path. Passing one here would
// make the guard blind to the strategy-resolution patch.
const OPTS = { noEmbed: true, noExtract: true, noPull: true, sourceId: SID } as const;

// GBRAIN_HOME at module top level, before any src/ import can read config.
const home = mkdtempSync(join(tmpdir(), 'gb-tw-home-'));
process.env.GBRAIN_HOME = home;

let engine: PGLiteEngine | null = null;
let repo = '';
let setupPromise: Promise<void> | null = null;
const extraRepos: string[] = [];

const commit = (m: string) =>
  execSync(`git add -A && git commit -qm ${JSON.stringify(m)}`, { cwd: repo, stdio: 'pipe' });

async function ensureSetup(): Promise<void> {
  setupPromise ??= (async () => {
    const e = new PGLiteEngine();
    await e.connect({});
    await e.initSchema();
    await e.executeRaw(
      `UPDATE sources SET config = coalesce(config,'{}'::jsonb) || '{"strategy":"auto"}'::jsonb WHERE id=$1`,
      [SID],
    );
    engine = e;
    repo = mkdtempSync(join(tmpdir(), 'gb-tw-repo-'));
    execSync('git init -q && git config user.email t@t && git config user.name T', { cwd: repo, stdio: 'pipe' });
    mkdirSync(join(repo, 'lib'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/a.md'), '---\ntype: note\ntitle: A\n---\n\nbody a\n');
    writeFileSync(join(repo, 'lib/a.dart'), 'class A {}\n');
    // Mixed case and non-ASCII on purpose: a source_path that is lowercased
    // or re-encoded on the way in still satisfies isSyncable, so the
    // reconcile would delete a LIVE page. That shows up here as `missing`.
    writeFileSync(join(repo, 'lib/MixedCase.dart'), 'class MixedCase {}\n');
    writeFileSync(join(repo, 'lib/été.dart'), 'class Ete {}\n');
    commit('init');
  })();
  await setupPromise;
}

async function drift(): Promise<{ missing: string[]; ghosts: string[] }> {
  const expected = new Set(
    collectSyncableFiles(repo, { strategy: STRATEGY })
      .map((abs) => relative(repo, abs))
      .map((rel) => resolveSlugForPath(rel)),
  );
  const rows = await engine!.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL`,
    [SID],
  );
  const actual = new Set(rows.map((r) => r.slug));
  return {
    missing: [...expected].filter((s) => !actual.has(s)).sort(),
    ghosts: [...actual].filter((s) => !expected.has(s)).sort(),
  };
}

/** Throwaway repo with one markdown + one code file, committed. */
function mkMixedRepo(): string {
  const r = mkdtempSync(join(tmpdir(), 'gb-tw-mixed-'));
  extraRepos.push(r);
  execSync('git init -q && git config user.email t@t && git config user.name T', { cwd: r, stdio: 'pipe' });
  mkdirSync(join(r, 'docs'));
  mkdirSync(join(r, 'lib'));
  writeFileSync(join(r, 'docs/x.md'), '---\ntype: note\ntitle: X\n---\n\nbody x\n');
  writeFileSync(join(r, 'lib/x.ts'), 'export const x = 1;\n');
  execSync('git add -A && git commit -qm init', { cwd: r, stdio: 'pipe' });
  return r;
}

/** Persist `config.strategy` on a fresh source row, the way ensureSetup does for SID. */
async function addSource(sid: string, strategy: string, localPath: string): Promise<void> {
  await engine!.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, jsonb_build_object('strategy', $3::text))`,
    [sid, localPath, strategy],
  );
}

async function slugsFor(sid: string): Promise<string[]> {
  const rows = await engine!.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL`,
    [sid],
  );
  return rows.map((r) => r.slug).sort();
}

afterAll(async () => {
  if (engine) await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
  if (repo) rmSync(repo, { recursive: true, force: true });
  for (const r of extraRepos) rmSync(r, { recursive: true, force: true });
});

describe('index matches tree at every lifecycle stage', () => {
  test('S1 first sync, caller passes no strategy', async () => {
    await ensureSetup();
    const { performSync } = await import('../src/commands/sync.ts');
    const r = await performSync(engine!, { repoPath: repo, ...OPTS });
    expect(r.status).toBe('first_sync');
    expect(await drift()).toEqual({ missing: [], ghosts: [] });
    const rows = await engine!.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL`,
      [SID],
    );
    expect(rows.map((r2) => r2.slug).sort()).toEqual(
      ['docs/a', 'lib-a-dart', 'lib-mixedcase-dart', 'lib-ete-dart'].sort(),
    );
  }, 120_000);

  test('S2 incremental ADD of one markdown + one code file', async () => {
    await ensureSetup();
    const { performSync } = await import('../src/commands/sync.ts');
    writeFileSync(join(repo, 'docs/b.md'), '---\ntype: note\ntitle: B\n---\n\nbody b\n');
    writeFileSync(join(repo, 'lib/b.dart'), 'class B {}\n');
    commit('add');
    await performSync(engine!, { repoPath: repo, ...OPTS });
    expect(await drift()).toEqual({ missing: [], ghosts: [] });
  }, 120_000);

  test('S3 incremental DELETE of one markdown + one code file', async () => {
    await ensureSetup();
    const { performSync } = await import('../src/commands/sync.ts');
    unlinkSync(join(repo, 'docs/b.md'));
    unlinkSync(join(repo, 'lib/b.dart'));
    commit('rm');
    await performSync(engine!, { repoPath: repo, ...OPTS });
    expect(await drift()).toEqual({ missing: [], ghosts: [] });
  }, 120_000);

  test('S4 FULL re-sync after a code file was removed', async () => {
    await ensureSetup();
    const { performSync } = await import('../src/commands/sync.ts');
    unlinkSync(join(repo, 'lib/a.dart'));
    commit('rm a.dart');
    await performSync(engine!, { repoPath: repo, ...OPTS, full: true });
    expect(await drift()).toEqual({ missing: [], ghosts: [] });
  }, 120_000);
});

describe('strategy precedence', () => {
  test('explicit strategy option wins over persisted config.strategy', async () => {
    await ensureSetup();
    const { performSync } = await import('../src/commands/sync.ts');
    const r = mkMixedRepo();
    await addSource('prec-explicit', 'auto', r);
    const res = await performSync(engine!, {
      repoPath: r, ...OPTS, sourceId: 'prec-explicit', strategy: 'markdown',
    });
    expect(res.status).toBe('first_sync');
    // Persisted 'auto' would have imported lib-x-ts too; only the markdown page lands.
    expect(await slugsFor('prec-explicit')).toEqual(['docs/x']);
  }, 120_000);

  test('bogus persisted config.strategy is ignored, not honored', async () => {
    await ensureSetup();
    const { performSync } = await import('../src/commands/sync.ts');
    const r = mkMixedRepo();
    await addSource('prec-bogus', 'bogus-strategy', r);
    // No strategy option: the out-of-set persisted value is skipped, classifySync
    // falls back to 'markdown', and the sync completes with the code file left out.
    const res = await performSync(engine!, { repoPath: r, ...OPTS, sourceId: 'prec-bogus' });
    expect(res.status).toBe('first_sync');
    expect(await slugsFor('prec-bogus')).toEqual(['docs/x']);
  }, 120_000);
});

describe('un-syncable sweep is reported (#4786)', () => {
  test('a run whose only effect is soft-deleting code pages reports deleted=N and status synced, never up_to_date', async () => {
    await ensureSetup();
    const { performSync } = await import('../src/commands/sync.ts');
    const r = mkMixedRepo();
    await addSource('sweep-count', 'auto', r);
    await performSync(engine!, { repoPath: r, ...OPTS, sourceId: 'sweep-count' });
    expect(await slugsFor('sweep-count')).toEqual(['docs/x', 'lib-x-ts']);

    // Edit ONLY the code file, then sync under a narrower strategy: the page
    // is un-syncable now, so the cleanup loop soft-deletes it. That sweep is
    // the run's only effect and must be what the result reports.
    writeFileSync(join(r, 'lib/x.ts'), 'export const x = 2;\n');
    execSync('git add -A && git commit -qm edit', { cwd: r, stdio: 'pipe' });
    const res = await performSync(engine!, {
      repoPath: r, ...OPTS, sourceId: 'sweep-count', strategy: 'markdown',
    });
    expect(await slugsFor('sweep-count')).toEqual(['docs/x']);
    expect(res.deleted).toBe(1);
    expect(res.status).toBe('synced');
  }, 120_000);

  test('a failed pull on a sweep-only run reports partial/pull_failed AND carries deleted=N (not zeroed)', async () => {
    await ensureSetup();
    const { performSync } = await import('../src/commands/sync.ts');
    // Local-path origin: pullRepo always passes `protocol.file.allow=never`,
    // so its internal pull fails deterministically (the #3068 topology) while
    // the working tree still imports. Pull is ENABLED here (no noPull).
    const upstream = mkMixedRepo();
    const mirror = mkdtempSync(join(tmpdir(), 'gb-tw-mirror-'));
    extraRepos.push(mirror);
    rmSync(mirror, { recursive: true, force: true });
    execSync(`git clone -q ${JSON.stringify(upstream)} ${JSON.stringify(mirror)}`, { stdio: 'pipe' });
    execSync('git config user.email t@t && git config user.name T', { cwd: mirror, stdio: 'pipe' });
    const PULL_OPTS = { noEmbed: true, noExtract: true, sourceId: 'sweep-pull' } as const;
    await addSource('sweep-pull', 'auto', mirror);
    const first = await performSync(engine!, { repoPath: mirror, ...PULL_OPTS });
    expect(first.status).toBe('first_sync');
    expect(await slugsFor('sweep-pull')).toEqual(['docs/x', 'lib-x-ts']);

    writeFileSync(join(mirror, 'lib/x.ts'), 'export const x = 2;\n');
    execSync('git add -A && git commit -qm edit', { cwd: mirror, stdio: 'pipe' });
    const res = await performSync(engine!, { repoPath: mirror, ...PULL_OPTS, strategy: 'markdown' });
    expect(await slugsFor('sweep-pull')).toEqual(['docs/x']);
    expect(res.status).toBe('partial');
    expect(res.reason).toBe('pull_failed');
    // #4786's invariant holds on this early return too: the sweep is the
    // run's only effect and must be what the result reports.
    expect(res.deleted).toBe(1);
  }, 120_000);
});

describe('sweep-only sync must not mint an embed-backfill (#4786 x #2139)', () => {
  test('syncProducedEmbeddableContent is false for sweep/delete-only results, true for imports', async () => {
    const { syncProducedEmbeddableContent } = await import('../src/core/sync-embed-backfill.ts');
    const zero = { chunksCreated: 0, added: 0, modified: 0, renamed: 0 };
    expect(syncProducedEmbeddableContent(zero)).toBe(false);
    expect(syncProducedEmbeddableContent({ ...zero, added: 1 })).toBe(true);
    expect(syncProducedEmbeddableContent({ ...zero, modified: 1 })).toBe(true);
    expect(syncProducedEmbeddableContent({ ...zero, renamed: 1 })).toBe(true);
    expect(syncProducedEmbeddableContent({ ...zero, chunksCreated: 3 })).toBe(true);
  });

  test('jobs sync handler: a sweep-only run skips the submitter (no_new_content); an importing run still reaches it', async () => {
    await ensureSetup();
    const { registerBuiltinHandlers } = await import('../src/commands/jobs.ts');
    type Handler = (job: unknown) => Promise<unknown>;
    const handlers = new Map<string, Handler>();
    const worker = { register: (name: string, fn: Handler) => { handlers.set(name, fn); } };
    await registerBuiltinHandlers(worker as never, engine!, { quiet: true });
    const runSync = (data: Record<string, unknown>) => handlers.get('sync')!({
      id: 1, name: 'sync', data, attempts_made: 0, deadlineAtMs: null,
      signal: new AbortController().signal, shutdownSignal: new AbortController().signal,
      updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {},
      isActive: async () => true, readInbox: async () => [],
    }) as Promise<{ status: string; deleted: number; embed_job_id: number | null; embed_skip_reason: string | null }>;

    const r = mkMixedRepo();
    await addSource('sweep-backfill', 'auto', r);
    const first = await runSync({ repoPath: r, sourceId: 'sweep-backfill', noPull: true });
    expect(first.status).toBe('first_sync');
    // PGLite has no worker surface, so the SUBMITTER refuses — which proves
    // the handler reached it: an import passes the content gate.
    expect(first.embed_skip_reason).toBe('no_worker_surface');

    // The handler takes no strategy from job data; narrow the PERSISTED
    // strategy (honored per #4903) so the edited code page is un-syncable
    // and the run's only effect is the #4786 sweep.
    await engine!.executeRaw(
      `UPDATE sources SET config = config || '{"strategy":"markdown"}'::jsonb WHERE id = $1`,
      ['sweep-backfill'],
    );
    writeFileSync(join(r, 'lib/x.ts'), 'export const x = 2;\n');
    execSync('git add -A && git commit -qm edit', { cwd: r, stdio: 'pipe' });
    const swept = await runSync({ repoPath: r, sourceId: 'sweep-backfill', noPull: true });
    expect(await slugsFor('sweep-backfill')).toEqual(['docs/x']);
    expect(swept.status).toBe('synced');
    expect(swept.deleted).toBe(1);
    // Nothing was created to embed: minting a backfill here would start the
    // per-source cooldown and make the NEXT real import's job skip.
    expect(swept.embed_job_id).toBeNull();
    expect(swept.embed_skip_reason).toBe('no_new_content');
  }, 120_000);
});
