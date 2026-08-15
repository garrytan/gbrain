/**
 * LOCAL PATCH GUARD (not upstream). One invariant, four lifecycle stages:
 *
 *   after ANY sync that reports success, the set of pages for the source
 *   equals the set of syncable files in the working tree.
 *
 * It is the regression guard for BOTH local fixes, and the two failure
 * signatures name which one fell out of a rebase:
 *
 *   missing: [...]  -> performSyncInner no longer resolves the source's
 *                      persisted `config.strategy`, so a caller that passes
 *                      no --strategy walks as 'markdown' and code files are
 *                      never imported (and modified ones are DELETED).
 *   ghosts:  [...]  -> importCodeFile no longer writes `source_path`, so the
 *                      full-sync delete-reconcile cannot see code pages and
 *                      deleted files are served forever.
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
    // Dot-DIRECTORIES. A code source must see its own CI and agent config;
    // `.gbrain/` is the control that must stay out. Asserted explicitly below
    // rather than through drift alone: `drift()` builds `expected` from the
    // same collector the sync uses, so a collector that prunes `.github` makes
    // both sides agree and the drift check passes on a broken tree.
    mkdirSync(join(repo, '.github/workflows'), { recursive: true });
    mkdirSync(join(repo, '.gbrain'), { recursive: true });
    writeFileSync(join(repo, '.github/workflows/ci.yml'), 'name: ci\non: push\n');
    writeFileSync(join(repo, '.gbrain/state.json'), '{"internal":true}\n');
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

afterAll(async () => {
  if (engine) await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('index matches tree at every lifecycle stage', () => {
  test('S1 first sync, caller passes no strategy', async () => {
    await ensureSetup();
    const { performSync } = await import('../src/commands/sync.ts');
    const r = await performSync(engine!, { repoPath: repo, ...OPTS });
    expect(r.status).toBe('first_sync');
    const indexed = new Set(
      (await engine!.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL`,
        [SID],
      )).map((x) => x.slug),
    );
    // Goes RED when the importer prunes dot-directories at descent, which is
    // where the rule actually bites: `classifySync` alone admitted the path
    // while `isCollectibleForWalker` never offered it, so the index stayed
    // empty of it and every symptom looked like the sync was simply "caught up".
    expect(indexed.has(resolveSlugForPath('.github/workflows/ci.yml'))).toBe(true);
    expect(indexed.has(resolveSlugForPath('.gbrain/state.json'))).toBe(false);
    expect(await drift()).toEqual({ missing: [], ghosts: [] });
    const rows = await engine!.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL`,
      [SID],
    );
    expect(rows.map((r2) => r2.slug).sort()).toEqual(
      [
        'docs/a', 'lib-a-dart', 'lib-mixedcase-dart', 'lib-ete-dart',
        // derived, not typed out: the slug for a dot-dir path is exactly what
        // the resolver produces, and hardcoding a guess here would assert my
        // spelling rather than the index.
        resolveSlugForPath('.github/workflows/ci.yml'),
      ].sort(),
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
