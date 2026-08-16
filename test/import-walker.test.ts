import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, mkdtempSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectMarkdownFiles, collectSyncableFiles } from '../src/commands/import.ts';

// These tests exercise the filesystem walker that feeds `gbrain import`.
// They target L002 (report/findings.md): a malicious symlink inside a shared
// brain directory must not cause the walker to read files outside the brain
// root. See src/commands/import.ts:collectMarkdownFiles.

describe('collectMarkdownFiles — symlink containment', () => {
  let root: string;
  let secretDir: string;

  beforeEach(() => {
    // Fresh directories per test so symlinks can't cross-contaminate runs.
    root = mkdtempSync(join(tmpdir(), 'gbrain-walker-root-'));
    secretDir = mkdtempSync(join(tmpdir(), 'gbrain-walker-secret-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  });

  test('includes real markdown files inside the root', () => {
    writeFileSync(join(root, 'legit.md'), '# legit\n');
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'other.md'), '# other\n');

    const files = collectMarkdownFiles(root);
    expect(files).toContain(join(root, 'legit.md'));
    expect(files).toContain(join(root, 'notes', 'other.md'));
  });

  test('skips a symlink file pointing outside the brain root', () => {
    // Plant a real secret outside the brain root
    const secretFile = join(secretDir, 'secret.md');
    writeFileSync(secretFile, '# secret — must not be ingested\n');

    // Inside the brain, create a symlink that points at the secret.
    // Before the fix, statSync followed the link and reported it as
    // a regular file, so it ended up in the walker's output and got
    // fed to importFile — chunked, embedded, and indexed in the brain.
    writeFileSync(join(root, 'legit.md'), '# legit\n');
    symlinkSync(secretFile, join(root, 'innocent.md'));

    const files = collectMarkdownFiles(root);
    expect(files).toContain(join(root, 'legit.md'));
    // The symlink itself must not appear — this is the security guarantee.
    expect(files).not.toContain(join(root, 'innocent.md'));
    // And the canonical secret path must definitely not be in the results.
    expect(files).not.toContain(secretFile);
  });

  test('does not descend into a symlinked directory', () => {
    // Create a directory outside the root with a markdown file inside it.
    const outsideSub = join(secretDir, 'sub');
    mkdirSync(outsideSub);
    writeFileSync(join(outsideSub, 'external.md'), '# external\n');

    // Plant a symlink inside the brain pointing at that directory.
    // Before the fix, walk() would follow it and emit external.md.
    // With lstatSync, stat.isSymbolicLink() is true and we refuse
    // to descend — this also blocks circular-symlink DoS as a side effect.
    writeFileSync(join(root, 'legit.md'), '# legit\n');
    symlinkSync(outsideSub, join(root, 'linked-notes'));

    const files = collectMarkdownFiles(root);
    expect(files).toContain(join(root, 'legit.md'));
    expect(files).not.toContain(join(root, 'linked-notes', 'external.md'));
    expect(files).not.toContain(join(outsideSub, 'external.md'));
  });

  test('skips broken symlinks without crashing', () => {
    // A dangling symlink — the target never existed. Pre-existing behavior
    // (PR #26 / PR #38) handled this via try/catch around statSync. The
    // L002 fix must not regress it: lstatSync succeeds on a dangling link
    // (it reports on the link itself, not the target), so we reach the
    // isSymbolicLink() branch and skip cleanly, no throw.
    writeFileSync(join(root, 'legit.md'), '# legit\n');
    symlinkSync('/nonexistent/path/to/nowhere', join(root, 'dangling.md'));

    const files = collectMarkdownFiles(root);
    expect(files).toContain(join(root, 'legit.md'));
    expect(files).not.toContain(join(root, 'dangling.md'));
  });
});

describe('collectSyncableFiles — malformed-filename exclusion (both routes)', () => {
  let root: string;
  const JUNK = '[foo.md](https-example).md';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-walker-malformed-'));
    writeFileSync(join(root, 'legit.md'), '# legit\n');
    writeFileSync(join(root, JUNK), '# junk\n');
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', '[wip] draft.md'), '# wip\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('FS-walk route excludes bracket-named files', () => {
    const files = collectSyncableFiles(root);
    expect(files).toContain(join(root, 'legit.md'));
    expect(files).not.toContain(join(root, JUNK));
    expect(files).not.toContain(join(root, 'notes', '[wip] draft.md'));
  });

  test('FS-walk route never DESCENDS into a bracket-named directory (clean children stay out)', () => {
    // The descent-time check is a separate carve-out from the per-file check:
    // a clean-named .md INSIDE a bracket-named dir still has a malformed PATH.
    mkdirSync(join(root, '[archive] 2026'));
    writeFileSync(join(root, '[archive] 2026', 'clean-name.md'), '# hidden by dir\n');
    const files = collectSyncableFiles(root);
    expect(files).toContain(join(root, 'legit.md'));
    expect(files).not.toContain(join(root, '[archive] 2026', 'clean-name.md'));
  });

  test('git fast-path route excludes bracket-named files', () => {
    execSync('git init', { cwd: root, stdio: 'pipe' });
    execSync('git config user.email "t@t.com" && git config user.name "T"', { cwd: root, stdio: 'pipe' });
    execSync('git add -A && git commit -m x', { cwd: root, stdio: 'pipe' });
    const files = collectSyncableFiles(root);
    expect(files).toContain(join(root, 'legit.md'));
    expect(files).not.toContain(join(root, JUNK));
    expect(files).not.toContain(join(root, 'notes', '[wip] draft.md'));
  });
});
