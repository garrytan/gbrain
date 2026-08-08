/**
 * #2114 — `gbrain import <dir>` (and the sync layer's legacy anchor path)
 * must not silently repoint the global brain repo.
 *
 * Pre-fix, the sync-checkpoint block at the end of `runImport` wrote
 * `sync.repo_path` and `sync.last_run` unconditionally (and `sync.last_commit`
 * when the import had no failures) whenever the imported directory was a git
 * repo — and `writeSyncAnchor`'s legacy no-sourceId branch did the same for
 * sync-driven full-reimport fallbacks. Importing ANY other directory silently
 * repointed `put_page` write-through at that directory (write-through.ts falls
 * back to `sync.repo_path` when the source row has no local_path) and
 * poisoned the incremental sync anchor. Nothing logged the change.
 *
 * The guard (shared `ownsGlobalSyncAnchor` in core/sync.ts, used by BOTH
 * layers): only the default source may move the globals, and only for the
 * configured brain repo — the global key when set, else the default source
 * row's local_path when set. Only a truly fresh brain bootstraps.
 *
 * Hermetic: PGLite in-memory; `GBRAIN_HOME` overridden via `withEnv` so
 * runImport's checkpoint file NEVER touches the real `~/.gbrain` (the
 * pattern documented in test/import-resume.test.ts); `GBRAIN_SOURCE`
 * cleared so a dev-shell source override can't reroute resolution; git
 * fixtures run with global/system config disabled so user hooks and
 * templates can't fire.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import { writeSyncAnchor } from '../src/commands/sync.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let workspace: string; // GBRAIN_HOME target — keeps the import checkpoint out of ~/.gbrain

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  workspace = mkdtempSync(join(tmpdir(), 'gbrain-2114-home-'));
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(workspace, { recursive: true, force: true });
});

/** runImport with the hermetic env: isolated GBRAIN_HOME, no source override. */
async function run(args: string[]): Promise<Awaited<ReturnType<typeof runImport>>> {
  let result!: Awaited<ReturnType<typeof runImport>>;
  await withEnv({ GBRAIN_HOME: workspace, GBRAIN_SOURCE: undefined }, async () => {
    result = await runImport(engine, args);
  });
  return result;
}

/** git isolated from the user's global/system config (hooks, templates, signing). */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', env: GIT_ENV });
}

/**
 * Throwaway git repo with one committed markdown page. The page filename is
 * derived from the prefix so two fixture repos never collide on slug when
 * imported into different sources of the same brain.
 */
function makeGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(dir, `${prefix}note.md`),
    `---\ntype: note\n---\n# Note ${prefix}\n\nContent of ${prefix}.`,
  );
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  // runImport canonicalizes the target dir (resolveImportTargetDir), so
  // return the realpath here to make equality assertions exact.
  return realpathSync(dir);
}

function headOf(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
    env: GIT_ENV,
  }).trim();
}

function commitNewFile(dir: string, name: string): void {
  writeFileSync(join(dir, name), `---\ntype: note\n---\n# ${name}\n\nMore content.`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `add ${name}`);
}

/**
 * Capture everything written to stderr while `fn` runs. Bun's console.error
 * does NOT route through process.stderr.write, so two layers are patched:
 * globalThis.console.error (catches the guard notices fired from src modules)
 * and process.stderr.write (catches the progress reporter). Extends the
 * stream-patch pattern from test/sync-sole-non-default-routing.test.ts with
 * the console layer bun requires.
 */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const captured: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  const origError = globalThis.console.error;
  (process.stderr as unknown as { write: typeof origWrite }).write = ((
    chunk: string | Uint8Array,
  ): boolean => {
    captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof origWrite;
  globalThis.console.error = (...args: unknown[]): void => {
    captured.push(args.map(String).join(' ') + '\n');
  };
  try {
    await fn();
  } finally {
    (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
    globalThis.console.error = origError;
  }
  return captured.join('');
}

describe('import sync-bookmark guard (#2114)', () => {
  let repoA: string;
  let repoB: string;
  const cleanups: string[] = [];

  beforeEach(async () => {
    // Reset the global sync bookmarks and imported pages between cases.
    await (engine as any).db.exec(`DELETE FROM config WHERE key LIKE 'sync.%'`);
    for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'page_versions', 'ingest_log', 'pages']) {
      await (engine as any).db.exec(`DELETE FROM ${t}`);
    }
    await (engine as any).db.exec(`DELETE FROM sources WHERE id <> 'default'`);
    await (engine as any).db.exec(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
    repoA = makeGitRepo('gbrain-2114-a-');
    repoB = makeGitRepo('gbrain-2114-b-');
    cleanups.push(repoA, repoB);
  });

  afterAll(() => {
    for (const d of cleanups) rmSync(d, { recursive: true, force: true });
  });

  test('first import bootstraps sync.repo_path (fresh-brain flow unchanged)', async () => {
    expect(await engine.getConfig('sync.repo_path')).toBeFalsy();

    const result = await run([repoA, '--no-embed', '--json']);
    expect(result.imported).toBeGreaterThanOrEqual(1);

    expect(await engine.getConfig('sync.repo_path')).toBe(repoA);
    expect(await engine.getConfig('sync.last_commit')).toBe(headOf(repoA));
    expect(await engine.getConfig('sync.last_run')).toBeTruthy();
  });

  test('importing a DIFFERENT git repo does not clobber the configured brain repo', async () => {
    await run([repoA, '--no-embed', '--json']);
    const anchorBefore = await engine.getConfig('sync.last_commit');
    expect(anchorBefore).toBe(headOf(repoA)); // premise: clean first import took the anchor
    const lastRunBefore = await engine.getConfig('sync.last_run');

    let result!: Awaited<ReturnType<typeof runImport>>;
    const notices = await captureStderr(async () => {
      result = await run([repoB, '--no-embed', '--json']);
    });
    // The import itself still succeeds — only the bookmark writes are guarded.
    expect(result.imported).toBeGreaterThanOrEqual(1);

    // The #2114 clobber: pre-fix, repo_path + last_run moved to repoB
    // unconditionally (and last_commit with them on a clean import).
    expect(await engine.getConfig('sync.repo_path')).toBe(repoA);
    expect(await engine.getConfig('sync.last_commit')).toBe(anchorBefore);
    expect(await engine.getConfig('sync.last_run')).toBe(lastRunBefore);

    // The refusal is loud, and names the intentional-repoint command.
    expect(notices).toContain('NOT repointing');
    expect(notices).toContain('gbrain config set sync.repo_path');
  });

  test('re-importing the SAME repo still advances the bookmark', async () => {
    await run([repoA, '--no-embed', '--json']);
    const firstHead = headOf(repoA);
    expect(await engine.getConfig('sync.last_commit')).toBe(firstHead);

    commitNewFile(repoA, 'second.md');
    const secondHead = headOf(repoA);
    expect(secondHead).not.toBe(firstHead);

    await run([repoA, '--no-embed', '--json']);
    expect(await engine.getConfig('sync.last_commit')).toBe(secondHead);
    expect(await engine.getConfig('sync.repo_path')).toBe(repoA);
  });

  test('non-canonical CONFIGURED spelling still counts as the same repo (realpath compare)', async () => {
    // The import target is canonicalized by resolveImportTargetDir before the
    // guard runs, but the CONFIGURED value can be any spelling the user gave
    // `gbrain config set sync.repo_path` (macOS: /var/... vs /private/var/...,
    // or a symlink). The guard must canonicalize BOTH sides — a plain
    // string/resolve() compare would false-refuse the user's own brain repo.
    const altA = repoA.startsWith('/private/') ? repoA.slice('/private'.length) : repoA;
    if (altA !== repoA) {
      expect(realpathSync(altA)).toBe(repoA); // sanity: same dir, different spelling
    }
    await engine.setConfig('sync.repo_path', altA);
    await engine.setConfig('sync.last_commit', 'stale-anchor');

    const notices = await captureStderr(async () => {
      await run([repoA, '--no-embed', '--json']);
    });

    // Same repo → no refusal, bookmark advances past the stale anchor.
    expect(notices).not.toContain('NOT repointing');
    expect(await engine.getConfig('sync.last_commit')).toBe(headOf(repoA));
  });

  test('unset global does NOT green-light bootstrap when the default source row holds the brain repo', async () => {
    // Modern sync writes the default source's anchor to sources.local_path and
    // leaves the global unset. An unset global alone must not let a foreign
    // import claim the brain-repo identity (#2114 false-accept).
    await (engine as any).db.exec(
      `UPDATE sources SET local_path = '${repoA}' WHERE id = 'default'`,
    );
    expect(await engine.getConfig('sync.repo_path')).toBeFalsy();

    const notices = await captureStderr(async () => {
      await run([repoB, '--no-embed', '--json']);
    });
    expect(notices).toContain('NOT repointing');
    expect(await engine.getConfig('sync.repo_path')).toBeFalsy();
    expect(await engine.getConfig('sync.last_commit')).toBeFalsy();

    // The REAL brain repo may align the global with the source row.
    await run([repoA, '--no-embed', '--json']);
    expect(await engine.getConfig('sync.repo_path')).toBe(repoA);
  });

  test('non-default source import never touches the global sync.* keys', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('work-code', 'work-code') ON CONFLICT DO NOTHING`,
    );

    // Case 1: globals unset — a non-default import must NOT bootstrap them
    // (the globals describe the default source's repo, not this one).
    await run([repoB, '--source-id', 'work-code', '--no-embed', '--json']);
    expect(await engine.getConfig('sync.repo_path')).toBeFalsy();
    expect(await engine.getConfig('sync.last_commit')).toBeFalsy();

    // Case 2: globals configured — a non-default import must leave them alone.
    await run([repoA, '--no-embed', '--json']);
    expect(await engine.getConfig('sync.repo_path')).toBe(repoA);
    const anchorBefore = await engine.getConfig('sync.last_commit');
    expect(anchorBefore).toBe(headOf(repoA)); // premise: clean default import took the anchor

    commitNewFile(repoB, 'more.md');
    await run([repoB, '--source-id', 'work-code', '--no-embed', '--json']);

    expect(await engine.getConfig('sync.repo_path')).toBe(repoA);
    expect(await engine.getConfig('sync.last_commit')).toBe(anchorBefore);
  });

  test('writeSyncAnchor legacy (no-sourceId) branch refuses foreign dirs too', async () => {
    // The original #2114 incident came through the sync layer: a full-reimport
    // fallback against a staging dir hit writeSyncAnchor's legacy branch and
    // clobbered the globals. The same ownership guard must hold there.
    await engine.setConfig('sync.repo_path', repoA);
    await engine.setConfig('sync.last_commit', 'anchor-a');

    const notices = await captureStderr(async () => {
      // Foreign dir: both writes must be refused.
      await writeSyncAnchor(engine, undefined, 'repo_path', repoB);
      await writeSyncAnchor(engine, undefined, 'last_commit', 'anchor-b', undefined, repoB);
    });
    expect(await engine.getConfig('sync.repo_path')).toBe(repoA);
    expect(await engine.getConfig('sync.last_commit')).toBe('anchor-a');
    expect(notices).toContain('not moving the global anchor');

    // The configured repo itself still advances (repoDir threaded for last_commit).
    await writeSyncAnchor(engine, undefined, 'last_commit', 'anchor-a2', undefined, repoA);
    expect(await engine.getConfig('sync.last_commit')).toBe('anchor-a2');

    // A resolved sourceId keeps writing to its own sources row, untouched by the guard.
    await writeSyncAnchor(engine, 'default', 'repo_path', repoA);
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = 'default'`,
    );
    expect(rows[0]?.local_path).toBe(repoA);
  });
});
