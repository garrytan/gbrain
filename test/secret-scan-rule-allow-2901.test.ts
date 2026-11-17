/**
 * GST-2901: a `.gbrain-scan-allow` line `path:<glob> pattern:<rule>` allows one rule in the files the glob matches and
 * leaves every other rule active there. Path globs and fingerprints keep their meaning; a malformed line or an unknown
 * rule name allows nothing and is reported; the scan output names the line that allowed a hit. Synthetic values only,
 * assembled at runtime.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowlistProblems } from '../src/core/secret-scan-allowlist.ts';
import { loadWorkspaceAllowlist, NAMED_SECRET_RULES, SCAN_ALLOW_FILENAME, scanFiles, type SecretFinding } from '../src/core/secret-scan.ts';
import { rangeSecretRefusal, scanRange } from '../src/core/git/range-secret-scan.ts';

const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaWF0IjoxNzAwMDAwMDAwfQ', 'c2lnbmF0dXJlLXBsYWNlaG9sZGVyLTAwMDA'].join('.');
const AWS = 'AKIA' + 'IOSFODNN7EXAMPLE';
const MAILER = `<a href="https://mail.example.invalid/unsubscribe?t=${JWT}">Unsubscribe</a>\n`;
const KNOWN = [...NAMED_SECRET_RULES, 'high_entropy_assignment', 'labeled_credential'];

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(allow: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-scan-rule-'));
  roots.push(root);
  writeFileSync(join(root, SCAN_ALLOW_FILENAME), allow);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
function scan(root: string, rels: string[]) {
  const allowed: Array<{ file: string; pattern: string; entry: string }> = [];
  const findings = scanFiles(rels.map(rel => join(root, rel)), { allowlist: loadWorkspaceAllowlist(root), workspaceRoot: root,
    onAllowed: hit => allowed.push({ file: hit.file.slice(root.length + 1), pattern: hit.pattern, entry: hit.entry }) });
  return { found: findings.map((f: SecretFinding) => `${f.file!.slice(root.length + 1)}:${f.pattern}`).sort(), allowed };
}

describe('path:<glob> pattern:<rule>', () => {
  test('allows only the named rule, only in matching files, and names the line that allowed it', () => {
    const root = workspace('path:mail/*.html pattern:jwt\n', {
      'mail/digest.html': MAILER + `aws ${AWS}\n`,
      'mail/sub/receipt.html': MAILER,
      'notes/plan.md': MAILER,
    });
    const r = scan(root, ['mail/digest.html', 'mail/sub/receipt.html', 'notes/plan.md']);
    expect(r.found).toEqual(['mail/digest.html:aws_access_key', 'mail/sub/receipt.html:jwt', 'notes/plan.md:jwt']);
    expect(r.allowed).toEqual([{ file: 'mail/digest.html', pattern: 'jwt', entry: 'path:mail/*.html pattern:jwt' }]);
  });

  test('a glob with no slash matches the file name at any depth, like a path entry', () => {
    const root = workspace('path:*.html pattern:jwt\n', { 'a/b/one.html': MAILER, 'two.md': MAILER });
    expect(scan(root, ['a/b/one.html', 'two.md']).found).toEqual(['two.md:jwt']);
  });
});

describe('existing entries keep their meaning', () => {
  test('a path glob still skips every rule in the file and a fingerprint still allows one value anywhere', () => {
    const glob = workspace('mail/*.html\n', { 'mail/digest.html': MAILER + `aws ${AWS}\n` });
    expect(scan(glob, ['mail/digest.html']).found).toEqual([]);
    const first = scan(workspace('', { 'x.md': MAILER }), ['x.md']);
    expect(first.found).toEqual(['x.md:jwt']);
    const fingerprintRoot = workspace('', { 'x.md': MAILER, 'y.md': MAILER });
    const [finding] = scanFiles([join(fingerprintRoot, 'x.md')], { allowlist: [], workspaceRoot: fingerprintRoot });
    writeFileSync(join(fingerprintRoot, SCAN_ALLOW_FILENAME), `${finding!.fingerprint}\n`);
    expect(scan(fingerprintRoot, ['x.md', 'y.md']).found).toEqual([]);
    expect(allowlistProblems(['mail/*.html', finding!.fingerprint, '*.pem', 'fixtures/**'], KNOWN)).toEqual([]);
  });
});

describe('a malformed line or an unknown rule allows nothing and is reported', () => {
  const cases = [
    ['path:mail/*.html pattern:jwtt', /unknown rule jwtt/],
    ['path:mail/*.html pattern:jwt,bearer', /malformed rule entry/],
    ['path:mail/*.html pattern:jwt bearer', /malformed rule entry/],
    ['path:mail/*.html  pattern:', /malformed rule entry/],
    ['pattern:jwt', /malformed rule entry/],
    ['path:mail/*.html', /read as a path glob for files whose name starts with path:/],
  ] as const;
  for (const [entry, problem] of cases) {
    test(entry, () => {
      const root = workspace(`${entry}\n`, { 'mail/digest.html': MAILER + `aws ${AWS}\n` });
      expect(scan(root, ['mail/digest.html']).found).toEqual(['mail/digest.html:aws_access_key', 'mail/digest.html:jwt']);
      const problems = allowlistProblems([entry], KNOWN);
      expect(problems).toHaveLength(1);
      expect(problems[0]!.problem).toMatch(problem);
    });
  }
});

describe('the publish scan', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'example@example.invalid',
    GIT_COMMITTER_NAME: 'Example', GIT_COMMITTER_EMAIL: 'example@example.invalid' } }).toString().trim();
  function repo(allow: string) {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-scan-rule-repo-'));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, SCAN_ALLOW_FILENAME), allow);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'allowlist');
    const base = git(root, 'rev-parse', 'HEAD');
    mkdirSync(join(root, 'mail'));
    writeFileSync(join(root, 'mail/digest.html'), MAILER);
    writeFileSync(join(root, 'notes.md'), MAILER);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'mailers');
    return { root, base, head: git(root, 'rev-parse', 'HEAD') };
  }

  test('a rule entry allows the hit in matching files, records the line that allowed it, and still refuses elsewhere', () => {
    const { root, base, head } = repo('path:mail/*.html pattern:jwt\n');
    const result = scanRange(root, base, head);
    expect(result.findings.map(f => `${f.path}:${f.pattern}`)).toEqual(['notes.md:jwt']);
    expect(result.allowed).toEqual([{ path: 'mail/digest.html', commit: head, line: 1, pattern: 'jwt', entry: 'path:mail/*.html pattern:jwt' }]);
    expect(result.allowlist_problems).toBeUndefined();
  });

  test('an unknown rule name allows nothing, and the refusal names the line', () => {
    const { root, base, head } = repo('path:mail/*.html pattern:jwtt\n');
    const result = scanRange(root, base, head);
    expect(result.findings.map(f => `${f.path}:${f.pattern}`).sort()).toEqual(['mail/digest.html:jwt', 'notes.md:jwt']);
    expect(result.allowed).toBeUndefined();
    expect(result.allowlist_problems?.map(p => p.entry)).toEqual(['path:mail/*.html pattern:jwtt']);
    expect(rangeSecretRefusal(root, base, head, result)!.suggestion).toContain('Check these .gbrain-scan-allow lines: path:mail/*.html pattern:jwtt (unknown rule jwtt, so it allows nothing');
  });

  test('the refusal detail keeps the first 10 allowed hits and their total, however many a rule entry allowed', () => {
    const { root, base } = repo('path:mail/*.html pattern:jwt\n');
    writeFileSync(join(root, 'mail/archive.html'), MAILER.repeat(30));
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'archive');
    const head = git(root, 'rev-parse', 'HEAD');
    const result = scanRange(root, base, head);
    expect(result.allowed).toHaveLength(31);
    const detail = JSON.parse(rangeSecretRefusal(root, base, head, result)!.detail!);
    expect(detail.findings.map((f: { path: string }) => f.path)).toEqual(['notes.md']);
    expect(detail.allowed).toHaveLength(10);
    expect(detail.allowed_total).toBe(31);
  });
});
