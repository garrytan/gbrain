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
