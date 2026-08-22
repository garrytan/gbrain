import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  resolveInstalledBuildCommit,
  resolveSourceCheckoutCommit,
} from '../src/core/build-provenance.ts';

const temporaryPaths: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('runtime build provenance', () => {
  test('Windows trusted Git roots do not come from inherited environment variables', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'core', 'build-provenance.ts'), 'utf8');
    expect(source).not.toContain('process.env.ProgramFiles');
    expect(source).not.toContain("process.env['ProgramFiles(x86)']");
  });
  test('resolves the exact commit for a Bun GitHub install and caches it', async () => {
    const root = temporaryDirectory('gbrain-installed-provenance-');
    writeFileSync(join(root, '.bun-tag'), 'ljcarreira-galaico-gbrain-124880f\n');
    const expected = '124880fa375d7dc429dff9601fec8d54e7770736';
    let fetches = 0;

    const first = await resolveInstalledBuildCommit(root, async (url) => {
      fetches += 1;
      expect(url).toBe('https://api.github.com/repos/ljcarreira-galaico/gbrain/commits/124880f');
      return new Response(JSON.stringify({ sha: expected }), { status: 200 });
    });
    const second = await resolveInstalledBuildCommit(root, async () => {
      throw new Error('the cached commit must avoid a second request');
    });

    expect(first).toBe(expected);
    expect(second).toBe(expected);
    expect(fetches).toBe(1);
  });

  test('rejects a GitHub response outside the installed short commit', async () => {
    const root = temporaryDirectory('gbrain-installed-provenance-mismatch-');
    writeFileSync(join(root, '.bun-tag'), 'garrytan-gbrain-124880f\n');
    await expect(resolveInstalledBuildCommit(root, async () => (
      new Response(JSON.stringify({ sha: 'f'.repeat(40) }), { status: 200 })
    ))).rejects.toThrow(/does not match/i);
  });

  test('rejects a malformed GitHub owner before making a request', async () => {
    const root = temporaryDirectory('gbrain-installed-provenance-owner-');
    writeFileSync(join(root, '.bun-tag'), 'evil/path-gbrain-124880f\n');
    let requested = false;
    await expect(resolveInstalledBuildCommit(root, async () => {
      requested = true;
      return new Response(JSON.stringify({ sha: '124880f' + 'a'.repeat(33) }), { status: 200 });
    })).rejects.toThrow(/owner|tag/i);
    expect(requested).toBe(false);
  });

  test('invalidates a cached commit when the Bun tag changes', async () => {
    const root = temporaryDirectory('gbrain-installed-provenance-upgrade-');
    writeFileSync(join(root, '.bun-tag'), 'garrytan-gbrain-aaaaaaa\n');
    await resolveInstalledBuildCommit(root, async () => (
      new Response(JSON.stringify({ sha: 'a'.repeat(40) }), { status: 200 })
    ));
    writeFileSync(join(root, '.bun-tag'), 'garrytan-gbrain-bbbbbbb\n');
    let fetched = false;
    const upgraded = await resolveInstalledBuildCommit(root, async () => {
      fetched = true;
      return new Response(JSON.stringify({ sha: 'b'.repeat(40) }), { status: 200 });
    });
    expect(fetched).toBe(true);
    expect(upgraded).toBe('b'.repeat(40));
  });

  test('resolves only a clean source checkout', () => {
    const root = temporaryDirectory('gbrain-source-provenance-');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'cli.ts'), 'export {};\n');
    const git = spawnSync('git', ['init', '-q'], { cwd: root });
    expect(git.status).toBe(0);
    spawnSync('git', ['config', 'user.email', 'provenance@example.invalid'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Provenance Test'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
    const expected = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();

    expect(resolveSourceCheckoutCommit(root)).toBe(expected);
    writeFileSync(join(root, 'src', 'cli.ts'), 'export const dirty = true;\n');
    expect(() => resolveSourceCheckoutCommit(root)).toThrow(/clean source checkout/i);
  });

  test('rejects a writable Git executable on POSIX', () => {
    if (process.platform === 'win32') return;
    const root = temporaryDirectory('gbrain-source-provenance-fake-git-');
    mkdirSync(join(root, '.git'));
    const fakeBin = temporaryDirectory('gbrain-source-provenance-bin-');
    const fakeGit = join(fakeBin, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\nprintf "%040d\\n" 0\n');
    chmodSync(fakeGit, 0o777);
    expect(() => resolveSourceCheckoutCommit(root, fakeGit)).toThrow(/protected executable/i);
  });

  test('ignores a protected fake Git at the front of PATH on POSIX', () => {
    if (process.platform === 'win32') return;
    const root = temporaryDirectory('gbrain-source-provenance-path-');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'cli.ts'), 'export {};\n');
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'provenance@example.invalid'],
      ['config', 'user.name', 'Provenance Test'],
      ['add', '.'],
      ['commit', '-qm', 'fixture'],
    ]) expect(spawnSync('git', args, { cwd: root }).status).toBe(0);
    const expected = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    const fakeBin = temporaryDirectory('gbrain-source-provenance-path-bin-');
    const marker = join(fakeBin, 'invoked');
    const fakeGit = join(fakeBin, 'git');
    writeFileSync(fakeGit, `#!/bin/sh\ntouch '${marker}'\ncase "$*" in *status*) exit 0;; *) printf '%040d\\n' 0;; esac\n`);
    chmodSync(fakeGit, 0o755);
    const moduleUrl = pathToFileURL(join(import.meta.dir, '..', 'src', 'core', 'build-provenance.ts')).href;
    const script = `import { resolveSourceCheckoutCommit } from ${JSON.stringify(moduleUrl)}; console.log(resolveSourceCheckoutCommit(${JSON.stringify(root)}));`;
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin` },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(expected);
    expect(existsSync(marker)).toBe(false);
  });
});
