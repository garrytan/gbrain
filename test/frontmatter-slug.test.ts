// Matches the spawnSync pattern in test/check-resolvable-cli.test.ts.
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const REPO_ROOT = resolve(import.meta.dir, '..');

function runSlug(...args: string[]): { stdout: string; stderr: string; status: number } {
  const res = spawnSync('bun', [CLI, 'frontmatter', 'slug', ...args], {
    encoding: 'utf-8',
    cwd: REPO_ROOT,
  });
  return {
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
    status: res.status ?? -1,
  };
}

describe('gbrain frontmatter slug', () => {
  test('webex meeting case (the SLUG_MISMATCH bug)', () => {
    const r = runSlug('Briefings/Webex Meeting - 2026-05-13 09:15 - NOC Morning Huddle-20260513 1633-1 [18bb71]');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('briefings/webex-meeting-2026-05-13-0915-noc-morning-huddle-20260513-1633-1-18bb71');
  });

  test('webex DM digest case', () => {
    const r = runSlug('Briefings/Webex Digest - 2026-05-13');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('briefings/webex-digest-2026-05-13');
  });

  test('unicode: strips combining diacritics', () => {
    const r = runSlug("José's Show");
    expect(r.status).toBe(0);
    // apostrophe is not in the allowed set [a-z0-9.\s_-], so it is stripped
    // entirely (not converted to a hyphen): "José's" → "joses", not "jose-s"
    expect(r.stdout).toBe('joses-show');
  });

  test('dots and underscores are preserved', () => {
    const r = runSlug('foo.bar_baz');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('foo.bar_baz');
  });

  test('multi-segment path: each segment slugified, joined with /', () => {
    const r = runSlug('Briefings/2026/Foo Bar');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('briefings/2026/foo-bar');
  });

  test('no argument: exits with usage error code 2', () => {
    const r = runSlug();
    expect(r.status).toBe(2);
  });
});

describe('gbrain frontmatter abi-version', () => {
  test('emits an integer >= 1', () => {
    const res = spawnSync('bun', [CLI, 'frontmatter', 'abi-version'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    expect(res.status).toBe(0);
    expect(res.stdout.trim()).toMatch(/^[0-9]+$/);
    expect(parseInt(res.stdout.trim(), 10)).toBeGreaterThanOrEqual(1);
  });
});
