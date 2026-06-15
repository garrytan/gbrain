/**
 * `gbrain lint` source-glob filter — walker integration.
 *
 * PR #2157 (commit cf9a3b18, `feat/sync-source-glob-filters`) wired
 * `sources.config.include_globs` / `exclude_globs` into `gbrain sync` so a
 * user could exclude `Resources/veriff/**` and have every subsequent sync
 * honor it. The lint command walked the same source dirs blind and emitted
 * findings against paths the user had already declared out of scope — a
 * half-finished feature.
 *
 * This patch extends the same persisted glob contract to lint:
 *   - `gbrain lint` gains `--include / --exclude` flags (parallel to sync).
 *   - `runLintCore` lifts `sources.config.{include,exclude}_globs` for any
 *     target whose absolute path matches a source row's `local_path`, so the
 *     cycle.lint phase + Minion lint handlers honor the same filter without
 *     restating it.
 *   - The walker in `collectPages` applies the filter using the SAME
 *     `matchesAnyGlob` helper sync uses, anchored at the target dir (so a
 *     persisted `Resources/veriff/**` glob written against the source root
 *     works without rewriting it as an absolute path).
 *
 * These tests pin the walker contract. The engine-side lift
 * (`resolveSourceGlobsForTarget`) is best-effort by design (returns `{}` on
 * any error) and is exercised by the dream-cycle lint phase end-to-end.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// runLintCore is the library entry — the same surface the cycle.lint phase
// and Minion handlers call. Exercising it covers the walker via its real
// callsite; testing `collectPages` directly would skip the wiring.
import { runLintCore } from '../src/commands/lint.ts';

// A self-contained content-sanity stub so the test never touches a real
// engine / config file. Empty operator-literal list keeps the content-sanity
// pass silent so the only findings come from the structural rules
// (no-frontmatter etc.).
const STUB_CS = {
  fail_on_throw: false,
  warn_on_throw: false,
  bytes_warn: 1024 * 1024,
  operator_literals: [],
};

describe('runLintCore — source-glob walker filter', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-lint-globs-'));
    // Three subtrees with mixed structured / archive-style content.
    // All pages have `# Title` headers but no frontmatter so each one
    // emits at least one `no-frontmatter` issue under the default rule set.
    mkdirSync(join(root, 'Notes'), { recursive: true });
    mkdirSync(join(root, 'Resources', 'veriff'), { recursive: true });
    mkdirSync(join(root, 'Resources', 'prior-art', 'archive-v1'), { recursive: true });

    writeFileSync(join(root, 'Notes', 'a.md'), '# A\nbody\n');
    writeFileSync(join(root, 'Notes', 'b.md'), '# B\nbody\n');
    writeFileSync(join(root, 'Resources', 'veriff', 'spec-1.md'), '# Veriff spec 1\nbody\n');
    writeFileSync(join(root, 'Resources', 'veriff', 'spec-2.md'), '# Veriff spec 2\nbody\n');
    writeFileSync(join(root, 'Resources', 'prior-art', 'archive-v1', 'old.md'), '# Old\nbody\n');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('no filter — walks every .md (regression guard for default behavior)', async () => {
    const result = await runLintCore({
      target: root,
      contentSanity: STUB_CS,
    });
    expect(result.pages_scanned).toBe(5);
    expect(result.pages_with_issues).toBeGreaterThan(0);
  });

  test('exclude glob skips matching paths (Resources/veriff/** off-limits)', async () => {
    const result = await runLintCore({
      target: root,
      contentSanity: STUB_CS,
      exclude: ['Resources/veriff/**'],
    });
    // 5 total minus 2 veriff specs = 3 pages walked.
    expect(result.pages_scanned).toBe(3);
  });

  test('exclude with multiple patterns is union (veriff + prior-art both skipped)', async () => {
    const result = await runLintCore({
      target: root,
      contentSanity: STUB_CS,
      exclude: ['Resources/veriff/**', 'Resources/prior-art/**'],
    });
    // 5 total minus 3 (2 veriff + 1 archive-v1) = 2 pages walked.
    expect(result.pages_scanned).toBe(2);
  });

  test('include glob narrows the walk to matching paths only', async () => {
    const result = await runLintCore({
      target: root,
      contentSanity: STUB_CS,
      include: ['Notes/**'],
    });
    expect(result.pages_scanned).toBe(2);
  });

  test('exclude runs AFTER include (same precedence as `gbrain sync`)', async () => {
    const result = await runLintCore({
      target: root,
      contentSanity: STUB_CS,
      include: ['**/*.md'],
      exclude: ['Resources/**'],
    });
    // include lets everything through; exclude drops the 3 Resources/* files.
    expect(result.pages_scanned).toBe(2);
  });

  test('empty include / exclude arrays do NOT engage the filter', async () => {
    // Symmetric with `parseGlobList` returning undefined for empty input —
    // an empty include would otherwise classify every path as a miss and
    // silently zero out the lint scope. Pin the guard at the walker level.
    const result = await runLintCore({
      target: root,
      contentSanity: STUB_CS,
      include: [],
      exclude: [],
    });
    expect(result.pages_scanned).toBe(5);
  });

  test('exclude semantics match sync — `**` matches across path segments', async () => {
    const result = await runLintCore({
      target: root,
      contentSanity: STUB_CS,
      exclude: ['**/spec-*.md'],
    });
    // Both Veriff specs match the deep glob; Notes + archive-v1 survive.
    expect(result.pages_scanned).toBe(3);
  });

  test('single-file target bypasses the filter (file mode is not a walk)', async () => {
    // A user lints one .md explicitly: filters are a directory-walk concern,
    // so the file is processed even if its name would match an exclude.
    const result = await runLintCore({
      target: join(root, 'Resources', 'veriff', 'spec-1.md'),
      contentSanity: STUB_CS,
      exclude: ['Resources/veriff/**'],
    });
    expect(result.pages_scanned).toBe(1);
  });
});
