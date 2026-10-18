/**
 * #6756: ci:local mounts the named volume gbrain-ci-admin-dist over
 * /app/admin/dist, and a new named volume starts empty, so a fresh checkout's
 * `bun run build` failed on the hashed admin bundles src/admin-embedded.ts
 * imports. The runner now copies the worktree's admin/dist (mounted read-only
 * at /ci-src/admin-dist) into the volume before the build: an exact copy of
 * the current worktree bytes, stale hashed files removed. It refuses only
 * when a tracked admin/dist file cannot be read, naming it and the admin build.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const SCRIPT = join(ROOT, 'scripts/ci-hydrate-admin-dist.sh');
const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

function write(dir: string, files: Record<string, string>): string {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-admin-dist-'));
  homes.push(dir);
  return write(dir, files);
}

/** A checkout whose admin/dist holds `files`, all tracked by git (index only). */
function checkout(files: Record<string, string>): string {
  const repo = tree({});
  write(join(repo, 'admin', 'dist'), files);
  const git = (...args: string[]) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  expect(git('init', '-q').status).toBe(0);
  expect(git('add', 'admin/dist').status).toBe(0);
  return repo;
}

function listing(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else out[r] = readFileSync(join(dir, r), 'utf8');
    }
  };
  walk('');
  return out;
}

const hydrate = (repo: string, dest: string) => spawnSync('bash', [SCRIPT, join(repo, 'admin', 'dist'), dest], { cwd: repo, encoding: 'utf8' });
const WORKTREE = { 'index.html': '<script src="/assets/index-NEW.js">', 'assets/index-NEW.js': 'new bundle', 'assets/logo.svg': '<svg/>' };

describe('#6756 ci:local hydrates the admin/dist volume from the worktree', () => {
  test('cold: an empty volume gets the worktree bytes', () => {
    const repo = checkout(WORKTREE), dest = join(tree({}), 'dist');
    const r = hydrate(repo, dest);
    expect(r.status, r.stderr).toBe(0);
    expect(listing(dest)).toEqual(WORKTREE);
  });

  test('warm: a volume already matching stays identical', () => {
    const repo = checkout(WORKTREE), dest = tree(WORKTREE);
    expect(hydrate(repo, dest).status).toBe(0);
    expect(listing(dest)).toEqual(WORKTREE);
  });

  test('changed bundle: uncommitted worktree bytes win over the volume', () => {
    const repo = checkout(WORKTREE), dest = tree(WORKTREE);
    writeFileSync(join(repo, 'admin', 'dist', 'assets', 'logo.svg'), '<svg edited/>');
    expect(hydrate(repo, dest).status).toBe(0);
    expect(listing(dest)).toEqual({ ...WORKTREE, 'assets/logo.svg': '<svg edited/>' });
  });

  test('deleted bundle: stale hashed files from an older build are removed', () => {
    const repo = checkout(WORKTREE);
    const dest = tree({ 'index.html': '<script src="/assets/index-OLD.js">', 'assets/index-OLD.js': 'old bundle', '.vite/manifest.json': '{}' });
    expect(hydrate(repo, dest).status).toBe(0);
    expect(listing(dest)).toEqual(WORKTREE);
  });

  test('a tracked file missing from the worktree refuses, naming the file and the admin build, and leaves the volume alone', () => {
    const repo = checkout(WORKTREE), dest = tree({ 'index.html': 'kept' });
    rmSync(join(repo, 'admin', 'dist', 'assets', 'index-NEW.js'));
    const r = hydrate(repo, dest);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('admin/dist/assets/index-NEW.js is tracked but cannot be read');
    expect(r.stderr).toContain('bun run build:admin');
    expect(listing(dest)).toEqual({ 'index.html': 'kept' });
  });

  test('an untracked file in the worktree is copied too; only tracked files gate the refusal', () => {
    const repo = checkout(WORKTREE), dest = tree({});
    writeFileSync(join(repo, 'admin', 'dist', 'local-only.txt'), 'untracked');
    expect(hydrate(repo, dest).status).toBe(0);
    expect(listing(dest)).toEqual({ ...WORKTREE, 'local-only.txt': 'untracked' });
  });

  test('the runner mounts the worktree admin/dist read-only and hydrates after git setup, before the build', () => {
    const compose = Bun.YAML.parse(readFileSync(join(ROOT, 'docker-compose.ci.yml'), 'utf8')) as { services: { runner: { volumes: string[] } } };
    expect(compose.services.runner.volumes).toContain('./admin/dist:/ci-src/admin-dist:ro');
    expect(compose.services.runner.volumes).toContain('gbrain-ci-admin-dist:/app/admin/dist');
    const source = readFileSync(join(ROOT, 'scripts/ci-local.sh'), 'utf8');
    const template = source.slice(source.indexOf("INNER_CMD=$(cat <<'EOF'"), source.indexOf('__RUN_PHASES__'));
    const hydrateAt = template.indexOf('bash scripts/ci-hydrate-admin-dist.sh /ci-src/admin-dist admin/dist');
    expect(hydrateAt).toBeGreaterThan(template.indexOf('safe.directory'));
    expect(hydrateAt).toBeLessThan(template.indexOf('bun run build'));
    expect(existsSync(SCRIPT)).toBe(true);
  });
});
