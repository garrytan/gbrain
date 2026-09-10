/**
 * The hidden-path WAIVER must reach callers that never touch the CLI (#4901).
 *
 * `--include-hidden` is a per-invocation flag. `sync.exclude` already has a
 * persisted twin so autopilot, minion sync jobs and the dream cycle inherit an
 * operator's narrowing; the waiver has none, so an operator who wants a
 * committed `.github/` indexed can say so on one code path and nowhere else.
 *
 * The gap is sharper than "less convenient". `sync --all` REFUSES the flag
 * outright — "--src-subpath/--exclude/--include-hidden scope a single sync
 * invocation; they cannot be combined with --all" — and `--all` is the form a
 * scheduled sync uses. So today the waiver cannot be expressed at all on the
 * only path that runs unattended.
 *
 * THE DEFAULT DOES NOT MOVE. An unset key admits nothing, exactly as today.
 * This is the plumbing for an opt-in that already exists, not the product
 * decision about whether dot-directories should be indexed by default, which
 * #4901 leaves to the maintainer.
 *
 * Under test:
 *   1. Baseline — with no config and no flag, a committed dot-directory is not
 *      indexed. Without this, case 2 could pass because the file never landed.
 *   2. `sync.include_hidden` is honored with NO flag passed.
 *   3. A trailing slash is normalized to a subtree glob, as `sync.exclude` is:
 *      `.github/` without the `**` matches the directory entry and none of the
 *      files inside it — silent, and indistinguishable from the feature not
 *      working.
 *   4. A per-call flag UNIONS with the persisted waiver rather than replacing
 *      it, so an ad-hoc admission never silently closes one the operator
 *      persisted.
 *   5. The waiver is scoped: a dot-directory the operator did NOT name stays
 *      pruned. A test that only proves admission would pass on a change that
 *      admits everything.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { runSources } from '../src/commands/sources.ts';

let engine: PGLiteEngine;
let repoPath: string;
const SOURCE_ID = 'testsrc-inchid-cfg';

function commitAll(msg: string): void {
  execSync('git add -A', { cwd: repoPath, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: repoPath, stdio: 'pipe' });
}

async function pageExists(slug: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL`,
    [slug, SOURCE_ID],
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** No `includeHidden` key: this is exactly what an internal caller passes. */
const baseOpts = () => ({
  repoPath,
  sourceId: SOURCE_ID,
  noPull: true,
  noEmbed: true,
  noExtract: true,
});

describe('sync.include_hidden config reaches non-CLI callers', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await runSources(engine, ['add', SOURCE_ID, '--no-federated']);

    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-inchid-cfg-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "t@t.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'notes'), { recursive: true });
    writeFileSync(join(repoPath, 'notes/base.md'), '# Base\n\ncommitted\n');
    commitAll('base');

    const first = await performSync(engine, baseOpts());
    expect(first.status).toBe('first_sync');
    expect(await pageExists('notes/base')).toBe(true);
  }, 120_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  }, 60_000);

  test('baseline: with no config and no flag, a dot-directory is not indexed', async () => {
    mkdirSync(join(repoPath, '.github/workflows'), { recursive: true });
    writeFileSync(join(repoPath, '.github/workflows/ci.md'), '# CI\n\nbaseline\n');
    writeFileSync(join(repoPath, 'notes/sibling.md'), '# Sibling\n\nindexed\n');
    commitAll('dot-dir baseline');

    await performSync(engine, baseOpts());

    expect(await pageExists('.github/workflows/ci')).toBe(false);
    // The control: the same commit's non-hidden file DID land, so a false in
    // the line above is the prune and not a sync that did nothing.
    expect(await pageExists('notes/sibling')).toBe(true);
  }, 60_000);

  test('persisted sync.include_hidden is honored with no flag passed', async () => {
    await engine.setConfig('sync.include_hidden', '.github/');

    writeFileSync(join(repoPath, '.github/workflows/release.md'), '# Release\n\nmust be indexed\n');
    commitAll('release workflow');

    await performSync(engine, baseOpts());

    // The whole point: no caller passed --include-hidden, and the waiver held.
    expect(await pageExists('.github/workflows/release')).toBe(true);
  }, 60_000);

  test('a trailing slash covers the files inside, not just the directory entry', async () => {
    mkdirSync(join(repoPath, '.github/ISSUE_TEMPLATE'), { recursive: true });
    writeFileSync(join(repoPath, '.github/ISSUE_TEMPLATE/bug.md'), '# Bug\n\nnested\n');
    commitAll('nested template');

    await performSync(engine, baseOpts());

    // LOWERCASED, underscores kept: the slug for `.github/ISSUE_TEMPLATE/bug.md`
    // is `.github/issue_template/bug`. The directory keeps GitHub's real casing
    // on disk on purpose — asserting the on-disk spelling here is how this case
    // first failed, and it read exactly like the waiver not reaching nested paths.
    expect(await pageExists('.github/issue_template/bug')).toBe(true);
  }, 60_000);

  test('an unnamed dot-directory stays pruned', async () => {
    // Scope, not blanket admission. Without this a change that waived every
    // dot-prefixed directory would pass every case above.
    mkdirSync(join(repoPath, '.vscode'), { recursive: true });
    writeFileSync(join(repoPath, '.vscode/notes.md'), '# Editor\n\nmust stay out\n');
    commitAll('vscode');

    await performSync(engine, baseOpts());

    expect(await pageExists('.vscode/notes')).toBe(false);
  }, 60_000);

  test('a per-call flag unions with the persisted waiver', async () => {
    mkdirSync(join(repoPath, '.claude'), { recursive: true });
    writeFileSync(join(repoPath, '.claude/adhoc.md'), '# Ad hoc\n\nadmitted by the flag\n');
    writeFileSync(join(repoPath, '.github/workflows/union.md'), '# Union\n\nadmitted by the config\n');
    commitAll('union case');

    await performSync(engine, { ...baseOpts(), includeHidden: ['.claude/**'] });

    // The flag admits its own path AND does not close the persisted one.
    expect(await pageExists('.claude/adhoc')).toBe(true);
    expect(await pageExists('.github/workflows/union')).toBe(true);
  }, 60_000);
});
