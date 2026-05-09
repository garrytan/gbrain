import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectFilesByStrategy, collectMarkdownFiles } from '../src/commands/import.ts';

// Issue #767 fix: collectFilesByStrategy is the strategy-aware companion to
// collectMarkdownFiles. Without it, performFullSync silently dropped the
// --strategy flag on first sync and produced 0 code pages for fresh code
// sources. These tests verify (1) strategy=code returns only code files,
// (2) strategy=auto returns code + markdown, (3) the symlink containment
// + node_modules + hidden-dir guards from collectMarkdownFiles are mirrored
// in the new walker (the security invariant from L002 must not regress).

describe('collectFilesByStrategy — strategy filtering', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-strategy-root-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('strategy=code returns code files but not markdown', () => {
    writeFileSync(join(root, 'README.md'), '# readme\n');
    writeFileSync(join(root, 'doc.md'), '# doc\n');
    writeFileSync(join(root, 'main.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'helper.py'), 'def helper(): pass\n');
    writeFileSync(join(root, 'app.java'), 'public class App {}\n');
    writeFileSync(join(root, 'core.c'), 'int main() {}\n');

    const files = collectFilesByStrategy(root, 'code');
    expect(files).toContain(join(root, 'main.ts'));
    expect(files).toContain(join(root, 'helper.py'));
    expect(files).toContain(join(root, 'app.java'));
    expect(files).toContain(join(root, 'core.c'));
    expect(files).not.toContain(join(root, 'README.md'));
    expect(files).not.toContain(join(root, 'doc.md'));
  });

  test('strategy=auto returns both code and markdown', () => {
    writeFileSync(join(root, 'doc.md'), '# doc\n');
    writeFileSync(join(root, 'main.ts'), 'export const x = 1;\n');

    const files = collectFilesByStrategy(root, 'auto');
    expect(files).toContain(join(root, 'doc.md'));
    expect(files).toContain(join(root, 'main.ts'));
  });

  test('strategy=code recurses into subdirectories', () => {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'src', 'lib'));
    writeFileSync(join(root, 'src', 'main.ts'), 'export {};\n');
    writeFileSync(join(root, 'src', 'lib', 'util.py'), '# util\n');

    const files = collectFilesByStrategy(root, 'code');
    expect(files).toContain(join(root, 'src', 'main.ts'));
    expect(files).toContain(join(root, 'src', 'lib', 'util.py'));
  });

  test('strategy=code skips node_modules', () => {
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'node_modules', 'foo'));
    writeFileSync(join(root, 'node_modules', 'foo', 'index.ts'), 'export {};\n');
    writeFileSync(join(root, 'app.ts'), 'export {};\n');

    const files = collectFilesByStrategy(root, 'code');
    expect(files).toContain(join(root, 'app.ts'));
    expect(files).not.toContain(join(root, 'node_modules', 'foo', 'index.ts'));
  });

  test('strategy=code skips hidden directories', () => {
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config.ts'), 'not really, but test\n');
    writeFileSync(join(root, 'app.ts'), 'export {};\n');

    const files = collectFilesByStrategy(root, 'code');
    expect(files).toContain(join(root, 'app.ts'));
    expect(files.some(f => f.includes('/.git/'))).toBe(false);
  });

  test('strategy=code skips files larger than 5MB', () => {
    // Build a 5.1MB file to ensure size guard fires.
    const big = 'a'.repeat(5_100_000);
    writeFileSync(join(root, 'big.ts'), big);
    writeFileSync(join(root, 'small.ts'), 'export {};\n');

    const files = collectFilesByStrategy(root, 'code');
    expect(files).toContain(join(root, 'small.ts'));
    expect(files).not.toContain(join(root, 'big.ts'));
  });
});

describe('collectFilesByStrategy — symlink containment (L002 parity)', () => {
  // Mirrors import-walker.test.ts. Same security invariant must hold for
  // the strategy-aware walker so first-sync code import doesn't open a
  // symlink-exfiltration vector that the markdown walker has been hardened
  // against since PR #26 / PR #38.

  let root: string;
  let secretDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-strategy-root-'));
    secretDir = mkdtempSync(join(tmpdir(), 'gbrain-strategy-secret-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  });

  test('skips a symlink file pointing outside the source root', () => {
    const secretFile = join(secretDir, 'secret.ts');
    writeFileSync(secretFile, 'export const SECRET = "do not ingest";\n');

    writeFileSync(join(root, 'legit.ts'), 'export const ok = true;\n');
    symlinkSync(secretFile, join(root, 'innocent.ts'));

    const files = collectFilesByStrategy(root, 'code');
    expect(files).toContain(join(root, 'legit.ts'));
    expect(files).not.toContain(join(root, 'innocent.ts'));
    expect(files).not.toContain(secretFile);
  });

  test('does not descend into a symlinked directory', () => {
    const outsideSub = join(secretDir, 'sub');
    mkdirSync(outsideSub);
    writeFileSync(join(outsideSub, 'external.ts'), 'export const x = 1;\n');

    writeFileSync(join(root, 'legit.ts'), 'export const ok = true;\n');
    symlinkSync(outsideSub, join(root, 'linked-src'));

    const files = collectFilesByStrategy(root, 'code');
    expect(files).toContain(join(root, 'legit.ts'));
    expect(files).not.toContain(join(root, 'linked-src', 'external.ts'));
    expect(files).not.toContain(join(outsideSub, 'external.ts'));
  });

  test('skips broken symlinks without crashing', () => {
    writeFileSync(join(root, 'legit.ts'), 'export {};\n');
    symlinkSync('/nonexistent/path/to/nowhere', join(root, 'dangling.ts'));

    const files = collectFilesByStrategy(root, 'code');
    expect(files).toContain(join(root, 'legit.ts'));
    expect(files).not.toContain(join(root, 'dangling.ts'));
  });
});

describe('collectFilesByStrategy — parity with collectMarkdownFiles for markdown content', () => {
  // strategy=auto should include the same markdown set that the legacy
  // collectMarkdownFiles returns, so callers that opt in to auto don't lose
  // any pre-existing markdown coverage.

  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-strategy-parity-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('strategy=auto subsumes collectMarkdownFiles for an md-only tree', () => {
    writeFileSync(join(root, 'a.md'), '# a\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'b.md'), '# b\n');

    const mdOnly = collectMarkdownFiles(root);
    const auto = collectFilesByStrategy(root, 'auto');

    for (const md of mdOnly) {
      expect(auto).toContain(md);
    }
  });
});
