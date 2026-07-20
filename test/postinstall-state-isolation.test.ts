import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join, relative, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const POSTINSTALL = join(REPO_ROOT, 'scripts', 'postinstall.ts');
const LOCKFILE = join(REPO_ROOT, 'bun.lock');
const cleanup: string[] = [];

afterEach(() => {
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function snapshotTree(root: string): string[] {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path).replaceAll('\\', '/');
      const stat = statSync(path);
      if (stat.isDirectory()) {
        rows.push(`d:${rel}`);
        walk(path);
      } else {
        rows.push(`f:${rel}:${stat.size}:${sha256(path)}`);
      }
    }
  };
  walk(root);
  return rows;
}

function makeSandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-isolation-'));
  cleanup.push(root);
  mkdirSync(join(root, 'profile'), { recursive: true });
  mkdirSync(join(root, 'temp'), { recursive: true });
  mkdirSync(join(root, 'hostile-bin'), { recursive: true });
  return root;
}

describe('postinstall state isolation', () => {
  test('package hook is the checked-in package-root advisory', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.postinstall).toBe('bun scripts/postinstall.ts');
    expect(existsSync(POSTINSTALL)).toBe(true);

    const source = readFileSync(POSTINSTALL, 'utf8');
    expect(source).not.toMatch(/from ['"]bun['"]/);
    expect(source).not.toMatch(/\b(which|spawn|spawnSync|exec|execSync)\s*\(/);
    expect(source).not.toContain('process.env');
  });

  test('hostile PATH and homes cannot cause a process or state write', () => {
    const root = makeSandbox();
    const marker = join(root, 'DECOY_GBRAIN_RAN');
    const hostileBin = join(root, 'hostile-bin');
    const profile = join(root, 'profile');
    const explicitHome = join(root, 'explicit-gbrain-home');
    const auditDir = join(root, 'explicit-audit-dir');

    writeFileSync(join(hostileBin, 'gbrain'), `#!/bin/sh\nprintf ran > '${marker}'\n`);
    writeFileSync(join(hostileBin, 'gbrain.cmd'), `@echo ran>"${marker}"\r\n`);

    const beforeTree = snapshotTree(root);
    const lockBefore = sha256(LOCKFILE);
    const result = Bun.spawnSync({
      cmd: [process.execPath, POSTINSTALL],
      cwd: REPO_ROOT,
      env: {
        PATH: hostileBin,
        GBRAIN_HOME: explicitHome,
        GBRAIN_AUDIT_DIR: auditDir,
        HOME: profile,
        USERPROFILE: profile,
        TMP: join(root, 'temp'),
        TEMP: join(root, 'temp'),
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        WINDIR: process.env.WINDIR ?? '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe('');
    expect(new TextDecoder().decode(result.stderr)).toBe([
      '[gbrain] Package installed. No brain state was read or changed.',
      'Next step for a new brain: gbrain init',
      'After updating a source checkout: gbrain apply-migrations --yes',
      'For a managed installation: gbrain upgrade',
      '',
    ].join('\n'));
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(explicitHome)).toBe(false);
    expect(existsSync(auditDir)).toBe(false);
    expect(existsSync(join(profile, '.gbrain'))).toBe(false);
    expect(snapshotTree(root)).toEqual(beforeTree);
    expect(sha256(LOCKFILE)).toBe(lockBefore);
  });

  test('install docs make every state transition explicit', () => {
    const docs = [
      'INSTALL_FOR_AGENTS.md',
      'docs/INSTALL.md',
      'docs/operations/headless-install.md',
    ].map(path => readFileSync(join(REPO_ROOT, path), 'utf8'));

    for (const doc of docs) {
      expect(doc).toContain('Package installation is non-stateful');
      expect(doc).toContain('gbrain init');
      expect(doc).toContain('gbrain apply-migrations --yes');
      expect(doc).toContain('gbrain upgrade');
    }
  });
});
