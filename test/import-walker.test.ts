import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectMarkdownFiles } from '../src/commands/import.ts';

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

// These tests exercise the isSyncable() filter the import walker now applies
// so it agrees with `gbrain sync` about what counts as a page. Before this
// fix, `gbrain import` walked every .md/.mdx and let scaffolding files
// (README.md, schema.md, index.md, log.md) plus ops/ paths through, even
// though sync correctly skipped them. Those leaked rows had no inbound links
// and dragged brain_score's noOrphans factor down. See issue #345.
describe('collectMarkdownFiles — isSyncable filter parity', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-walker-isSyncable-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('skips directory README.md scaffolding files', () => {
    mkdirSync(join(root, 'companies'));
    mkdirSync(join(root, 'people'));
    writeFileSync(join(root, 'companies', 'README.md'), '# Companies index\n');
    writeFileSync(join(root, 'people', 'README.md'), '# People index\n');
    writeFileSync(join(root, 'companies', 'acme.md'), '# Acme\n');
    writeFileSync(join(root, 'people', 'alice.md'), '# Alice\n');

    const files = collectMarkdownFiles(root);
    expect(files).toContain(join(root, 'companies', 'acme.md'));
    expect(files).toContain(join(root, 'people', 'alice.md'));
    expect(files).not.toContain(join(root, 'companies', 'README.md'));
    expect(files).not.toContain(join(root, 'people', 'README.md'));
  });

  test('skips top-level scaffolding meta files', () => {
    writeFileSync(join(root, 'README.md'), '# brain\n');
    writeFileSync(join(root, 'schema.md'), '# schema\n');
    writeFileSync(join(root, 'index.md'), '# index\n');
    writeFileSync(join(root, 'log.md'), '# log\n');
    writeFileSync(join(root, 'notes.md'), '# real page\n');

    const files = collectMarkdownFiles(root);
    expect(files).toContain(join(root, 'notes.md'));
    expect(files).not.toContain(join(root, 'README.md'));
    expect(files).not.toContain(join(root, 'schema.md'));
    expect(files).not.toContain(join(root, 'index.md'));
    expect(files).not.toContain(join(root, 'log.md'));
  });

  test('skips ops/ directory contents', () => {
    mkdirSync(join(root, 'ops'));
    writeFileSync(join(root, 'ops', 'deploy-log.md'), '# deploy log\n');
    writeFileSync(join(root, 'ops', 'config.md'), '# ops config\n');
    writeFileSync(join(root, 'real.md'), '# real page\n');

    const files = collectMarkdownFiles(root);
    expect(files).toContain(join(root, 'real.md'));
    expect(files).not.toContain(join(root, 'ops', 'deploy-log.md'));
    expect(files).not.toContain(join(root, 'ops', 'config.md'));
  });

  test('skips .raw/ sidecar directory contents', () => {
    mkdirSync(join(root, 'people'));
    mkdirSync(join(root, 'people', 'alice.raw'));
    writeFileSync(join(root, 'people', 'alice.raw', 'source.md'), '# source\n');
    writeFileSync(join(root, 'people', 'alice.md'), '# Alice\n');

    const files = collectMarkdownFiles(root);
    expect(files).toContain(join(root, 'people', 'alice.md'));
    expect(files).not.toContain(join(root, 'people', 'alice.raw', 'source.md'));
  });

  test('still includes legitimate nested .md and .mdx pages', () => {
    mkdirSync(join(root, 'a'));
    mkdirSync(join(root, 'a', 'b'));
    mkdirSync(join(root, 'a', 'b', 'c'));
    writeFileSync(join(root, 'a', 'b', 'c', 'deep.md'), '# deep\n');
    writeFileSync(join(root, 'a', 'b', 'c', 'mdx-page.mdx'), '# mdx\n');
    writeFileSync(join(root, 'flat.md'), '# flat\n');

    const files = collectMarkdownFiles(root);
    expect(files).toContain(join(root, 'flat.md'));
    expect(files).toContain(join(root, 'a', 'b', 'c', 'deep.md'));
    expect(files).toContain(join(root, 'a', 'b', 'c', 'mdx-page.mdx'));
  });
});
