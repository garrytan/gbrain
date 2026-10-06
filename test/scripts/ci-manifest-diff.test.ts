/**
 * scripts/ci-manifest-diff.sh, scripts/ci-dependency-audit.sh and the
 * test.yml dependency-audit scope step (GBRA-47 B11, C11; ENG-17): manifest
 * diffs compare parsed JSON, unknown diffs fail closed, and bun audit blocks
 * only where the scope says so.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';

const root = join(import.meta.dir, '../..');
const SCRIPT = join(root, 'scripts/ci-manifest-diff.sh');
const base = { name: 'gbrain', version: '0.60.48.0', scripts: { test: 'bun test' }, dependencies: { a: '1.0.0' } };

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-manifest-diff-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function compare(mode: string, head: unknown, baseJson: unknown = base): string {
  return withDir(dir => {
    writeFileSync(join(dir, 'base.json'), typeof baseJson === 'string' ? baseJson : JSON.stringify(baseJson));
    writeFileSync(join(dir, 'head.json'), typeof head === 'string' ? head : JSON.stringify(head, null, 4));
    const r = spawnSync('bash', [SCRIPT, mode, join(dir, 'base.json'), join(dir, 'head.json')], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  });
}

/** A fake `gh` that serves PR files and per-ref file contents from a JSON map keyed by `<path>@<ref>`. */
function fakeGh(dir: string, files: string[] | 'error', contents: Record<string, unknown> = {}): string {
  writeFileSync(join(dir, 'contents.json'), JSON.stringify(contents));
  writeFileSync(join(dir, 'files.txt'), files === 'error' ? '' : files.join('\n') + '\n');
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash
args="$*"
if [[ "$args" == *"/pulls/"*"/files"* ]]; then
  ${files === 'error' ? 'exit 1' : `cat '${join(dir, 'files.txt')}'; exit 0`}
fi
if [[ "$args" =~ contents/([^?]+)\\?ref=([a-z]+) ]]; then
  key="\${BASH_REMATCH[1]}@\${BASH_REMATCH[2]}"
  jq -e --arg k "$key" '.[$k] // error("missing")' '${join(dir, 'contents.json')}' || exit 1
  exit 0
fi
exit 1
`);
  chmodSync(join(dir, 'gh'), 0o755);
  return dir;
}

describe('ci-manifest-diff.sh', () => {
  test('version-only is true only when nothing but the top-level version changed (parsed, so formatting is ignored)', () => {
    expect(compare('version-only', { ...base, version: '0.60.49.0' })).toBe('true');
    expect(compare('version-only', { ...base, version: '0.60.49.0', scripts: { test: 'bun test --x' } })).toBe('false');
    expect(compare('version-only', base)).toBe('false');
    expect(compare('version-only', '{not json')).toBe('false');
  });

  test('dependency-change looks at dependency fields only and fails closed on unreadable JSON', () => {
    expect(compare('dependency-change', { ...base, version: '9', scripts: {} })).toBe('false');
    expect(compare('dependency-change', { ...base, dependencies: { a: '1.0.1' } })).toBe('true');
    expect(compare('dependency-change', { ...base, overrides: { b: '2' } })).toBe('true');
    expect(compare('dependency-change', '{not json')).toBe('true');
  });

  test('drop-version-only removes a version-bump manifest and keeps every other path; unreadable revisions are kept', () => withDir(dir => {
    fakeGh(dir, [], {
      'package.json@base': base, 'package.json@head': { ...base, version: '0.60.49.0' },
      'openclaw.plugin.json@base': { version: '1' }, 'openclaw.plugin.json@head': { version: '1', id: 'changed' },
    });
    const r = spawnSync('bash', [SCRIPT, 'drop-version-only'], {
      input: 'package.json\nopenclaw.plugin.json\nsrc/x.ts\n', encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, REPO: 'o/r', BASE_SHA: 'base', HEAD_SHA: 'head' },
    });
    expect(r.stdout).toBe('openclaw.plugin.json\nsrc/x.ts\n');
    const noRefs = spawnSync('bash', [SCRIPT, 'drop-version-only'], { input: 'package.json\n', encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}` } });
    expect(noRefs.stdout).toBe('package.json\n');
  }));
});

describe('test.yml dependency-audit scope', () => {
  const step = (load(readFileSync(join(root, '.github/workflows/test.yml'), 'utf8')) as {
    jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }>;
  }).jobs['dependency-audit'].steps.find(s => s.id === 'scope')!;

  const scope = (env: Record<string, string>, files: string[] | 'error', contents: Record<string, unknown> = {}) => withDir(dir => {
    fakeGh(dir, files, contents);
    const output = join(dir, 'out');
    writeFileSync(output, '');
    const r = spawnSync('bash', ['-c', step.run!], {
      cwd: root, encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, PR: '7', REPO: 'o/r', LABELS: '[]', BASE_SHA: 'base', HEAD_SHA: 'head',
        CHANGED_FILES: files === 'error' ? '1' : String(files.length), GITHUB_OUTPUT: output, ...env },
    });
    expect(r.status, r.stderr).toBe(0);
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(l => l.split('=', 2) as [string, string]));
  });

  test('pushes and schedules always block; a labelled PR blocks', () => {
    expect(scope({ EVENT: 'push' }, 'error').blocking).toBe('true');
    expect(scope({ EVENT: 'schedule' }, 'error').blocking).toBe('true');
    expect(scope({ EVENT: 'pull_request', LABELS: '["dependency-audit"]' }, ['docs/a.md']).blocking).toBe('true');
  });

  test('a PR blocks only on lockfile, patches/ or dependency-field changes, and on an unreadable diff', () => {
    expect(scope({ EVENT: 'pull_request' }, ['docs/a.md', 'src/x.ts'])).toEqual({ blocking: 'false', reason: 'no lockfile, patches/ or dependency-field change' });
    expect(scope({ EVENT: 'pull_request' }, ['src/x.ts', 'bun.lock']).blocking).toBe('true');
    expect(scope({ EVENT: 'pull_request' }, ['patches/postgres@3.4.9.patch']).blocking).toBe('true');
    expect(scope({ EVENT: 'pull_request' }, ['package.json'], { 'package.json@base': base, 'package.json@head': { ...base, version: '2' } }).blocking).toBe('false');
    expect(scope({ EVENT: 'pull_request' }, ['package.json'], { 'package.json@base': base, 'package.json@head': { ...base, dependencies: { a: '2' } } }).blocking).toBe('true');
    expect(scope({ EVENT: 'pull_request' }, 'error').blocking).toBe('true');
  });
});

describe('ci-dependency-audit.sh', () => {
  const audit = (blocking: string, auditExit: number) => withDir(dir => {
    writeFileSync(join(dir, 'bun'), `#!/usr/bin/env bash\nexit ${auditExit}\n`);
    chmodSync(join(dir, 'bun'), 0o755);
    return spawnSync('bash', [join(root, 'scripts/ci-dependency-audit.sh')], {
      cwd: root, encoding: 'utf8', env: { PATH: `${dir}:${process.env.PATH}`, BLOCKING: blocking, REASON: 'r' },
    });
  });

  test('advisories fail a blocking run with the fix and warn on an advisory-only PR', () => {
    const blocked = audit('true', 1);
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain('::error::bun audit found advisories (blocking: r)');
    expect(blocked.stdout).toContain('Fix: bump the package');
    const advisory = audit('false', 1);
    expect(advisory.status).toBe(0);
    expect(advisory.stdout).toContain('::warning::bun audit found advisories; advisory-only');
    expect(advisory.stdout).toContain('add the dependency-audit label');
    expect(audit('false', 0).status).toBe(0);
  });
});
