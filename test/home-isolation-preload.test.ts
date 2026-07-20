import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PRELOAD = join(import.meta.dir, 'helpers', 'home-isolation-preload.ts');
const ISOLATION_GATE = join(REPO_ROOT, 'scripts', 'check-test-isolation.sh');

function bashExecutable(): string {
  if (process.platform !== 'win32') return 'bash';
  const probe = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  const execPath = String(probe.stdout ?? '').trim();
  const candidate = execPath ? resolve(execPath, '..', '..', '..', 'bin', 'bash.exe') : '';
  return candidate && existsSync(candidate) ? candidate : 'bash';
}

const BASH = bashExecutable();

type TextSpawnResult = { status: number | null; stdout: string; stderr: string };

function inheritedEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.GBRAIN_TEST_HOME;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runPreload(
  script: string,
  overrides: Record<string, string | undefined> = {},
): TextSpawnResult {
  const result = spawnSync(process.execPath, ['--preload', PRELOAD, '-e', script], {
    cwd: REPO_ROOT,
    env: inheritedEnv(overrides),
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

async function runPreloadAsync(script: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--preload', PRELOAD, '-e', script], {
      cwd: REPO_ROOT,
      env: inheritedEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolveResult({ code, stdout, stderr }));
  });
}

function parseLastJson(stdout: string): Record<string, string> {
  const lines = stdout.trim().split(/\r?\n/);
  return JSON.parse(lines.at(-1) ?? '{}') as Record<string, string>;
}

function exactTreeSnapshot(root: string): string {
  if (!existsSync(root)) return 'absent';
  const rows: string[] = [];
  const walk = (path: string, rel: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      rows.push(`link\t${rel}\t${readlinkSync(path)}`);
      return;
    }
    if (stat.isDirectory()) {
      rows.push(`dir\t${rel}`);
      for (const name of readdirSync(path).sort()) walk(join(path, name), join(rel, name));
      return;
    }
    const bytes = readFileSync(path);
    rows.push(`file\t${rel}\t${bytes.byteLength}\t${createHash('sha256').update(bytes).digest('hex')}`);
  };
  walk(root, '.');
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}

describe('global GBrain home-isolation preload', () => {
  test('overrides hostile inherited homes before imports and confines helpers and subprocesses', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-preload-hostile-'));
    const parent = join(root, 'safe-parent');
    const hostileHome = join(root, 'hostile-home');
    const hostileAudit = join(root, 'hostile-audit');
    mkdirSync(parent);
    mkdirSync(hostileHome);
    mkdirSync(hostileAudit);
    writeFileSync(join(hostileHome, 'sentinel'), 'home-unchanged');
    writeFileSync(join(hostileAudit, 'sentinel'), 'audit-unchanged');

    const actualProfileHome = join(homedir(), '.gbrain');
    const actualProfileBefore = exactTreeSnapshot(actualProfileHome);
    const script = `
      const { gbrainPath } = await import('./src/core/config.ts');
      const { createAuditWriter, resolveAuditDir } = await import('./src/core/audit/audit-writer.ts');
      const { readFileSync, readdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const writer = createAuditWriter({ featureName: 'home-isolation-proof' });
      writer.log({ proof: 'owned-child' });
      const auditFile = join(process.env.GBRAIN_AUDIT_DIR, readdirSync(process.env.GBRAIN_AUDIT_DIR)[0]);
      const nested = Bun.spawnSync({
        cmd: [process.execPath, '-e', 'console.log(JSON.stringify({home:process.env.GBRAIN_HOME,audit:process.env.GBRAIN_AUDIT_DIR}))'],
        env: { ...process.env },
      });
      console.log(JSON.stringify({
        home: process.env.GBRAIN_HOME,
        audit: process.env.GBRAIN_AUDIT_DIR,
        gbrainPath: gbrainPath('probe.json'),
        resolvedAudit: resolveAuditDir(),
        auditFile,
        auditBody: readFileSync(auditFile, 'utf8').trim(),
        nested: nested.stdout.toString().trim(),
        HOME: process.env.HOME ?? '',
        USERPROFILE: process.env.USERPROFILE ?? '',
      }));
    `;
    const beforeHome = process.env.HOME ?? '';
    const beforeProfile = process.env.USERPROFILE ?? '';
    const result = runPreload(script, {
      GBRAIN_TEST_HOME: parent,
      GBRAIN_HOME: hostileHome,
      GBRAIN_AUDIT_DIR: hostileAudit,
    });

    expect(result.status, result.stderr).toBe(0);
    const output = parseLastJson(result.stdout);
    const nested = JSON.parse(output.nested) as { home: string; audit: string };
    const homeRelative = relative(realpathSync(parent), output.home);
    expect(homeRelative.startsWith('..') || isAbsolute(homeRelative)).toBe(false);
    expect(output.audit).toBe(join(output.home, '.gbrain', 'audit'));
    expect(output.gbrainPath).toBe(join(output.home, '.gbrain', 'probe.json'));
    expect(output.resolvedAudit).toBe(output.audit);
    expect(dirname(output.auditFile)).toBe(output.audit);
    expect(JSON.parse(output.auditBody)).toMatchObject({ proof: 'owned-child' });
    expect(nested).toEqual({ home: output.home, audit: output.audit });
    expect(output.HOME).toBe(beforeHome);
    expect(output.USERPROFILE).toBe(beforeProfile);
    expect(readFileSync(join(hostileHome, 'sentinel'), 'utf8')).toBe('home-unchanged');
    expect(readFileSync(join(hostileAudit, 'sentinel'), 'utf8')).toBe('audit-unchanged');
    expect(existsSync(parent)).toBe(true);
    expect(readdirSync(parent)).toEqual([]);
    expect(exactTreeSnapshot(actualProfileHome)).toBe(actualProfileBefore);
    rmSync(root, { recursive: true, force: true });
  });

  test('blank and unset override use unique OS-temporary children across concurrent processes', async () => {
    const script = `await Bun.sleep(75); console.log(JSON.stringify({home:process.env.GBRAIN_HOME,audit:process.env.GBRAIN_AUDIT_DIR}));`;
    const [first, second] = await Promise.all([
      runPreloadAsync(script),
      runPreloadAsync(script),
    ]);
    expect(first.code, first.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    const firstOutput = parseLastJson(first.stdout);
    const secondOutput = parseLastJson(second.stdout);
    expect(firstOutput.home).not.toBe(secondOutput.home);
    expect(existsSync(firstOutput.home)).toBe(false);
    expect(existsSync(secondOutput.home)).toBe(false);

    const blank = runPreload('console.log(JSON.stringify({home:process.env.GBRAIN_HOME}))', {
      GBRAIN_TEST_HOME: '   ',
    });
    expect(blank.status, blank.stderr).toBe(0);
    expect(existsSync(parseLastJson(blank.stdout).home)).toBe(false);

    const hostileRoot = mkdtempSync(join(tmpdir(), 'gbrain-preload-default-hostile-'));
    const hostileHome = join(hostileRoot, 'home');
    const hostileAudit = join(hostileRoot, 'audit');
    mkdirSync(hostileHome);
    mkdirSync(hostileAudit);
    writeFileSync(join(hostileHome, 'sentinel'), 'home-unchanged');
    writeFileSync(join(hostileAudit, 'sentinel'), 'audit-unchanged');
    const hostileDefault = runPreload(
      'console.log(JSON.stringify({home:process.env.GBRAIN_HOME,audit:process.env.GBRAIN_AUDIT_DIR}))',
      { GBRAIN_HOME: hostileHome, GBRAIN_AUDIT_DIR: hostileAudit },
    );
    expect(hostileDefault.status, hostileDefault.stderr).toBe(0);
    const hostileOutput = parseLastJson(hostileDefault.stdout);
    expect(hostileOutput.home).not.toBe(hostileHome);
    expect(hostileOutput.audit).not.toBe(hostileAudit);
    expect(existsSync(hostileOutput.home)).toBe(false);
    expect(readFileSync(join(hostileHome, 'sentinel'), 'utf8')).toBe('home-unchanged');
    expect(readFileSync(join(hostileAudit, 'sentinel'), 'utf8')).toBe('audit-unchanged');
    rmSync(hostileRoot, { recursive: true, force: true });
  });

  test('normal-exit cleanup removes only its marked child and preserves caller-owned siblings', () => {
    const parent = mkdtempSync(join(tmpdir(), 'gbrain-preload-owned-'));
    const sibling = join(parent, 'caller-owned-after-start');
    const script = `
      const { dirname, join } = await import('node:path');
      const { writeFileSync } = await import('node:fs');
      const sibling = join(dirname(process.env.GBRAIN_HOME), 'caller-owned-after-start');
      writeFileSync(sibling, 'retain');
      console.log(JSON.stringify({home:process.env.GBRAIN_HOME}));
    `;
    const result = runPreload(script, { GBRAIN_TEST_HOME: parent });
    expect(result.status, result.stderr).toBe(0);
    const output = parseLastJson(result.stdout);
    expect(existsSync(output.home)).toBe(false);
    expect(readFileSync(sibling, 'utf8')).toBe('retain');
    rmSync(parent, { recursive: true, force: true });
  });

  test('cleanup remains the final normal-exit action after a later listener writes', () => {
    const parent = mkdtempSync(join(tmpdir(), 'gbrain-preload-late-exit-'));
    const sibling = join(parent, 'later-listener-ran');
    const script = `
      const { dirname, join } = await import('node:path');
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const home = process.env.GBRAIN_HOME;
      const sibling = join(dirname(home), 'later-listener-ran');
      process.on('exit', () => {
        mkdirSync(home, { recursive: true });
        writeFileSync(join(home, 'late-write'), 'must-be-cleaned');
        writeFileSync(sibling, 'listener-ran');
      });
      console.log(JSON.stringify({ home }));
    `;
    const result = runPreload(script, { GBRAIN_TEST_HOME: parent });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(parseLastJson(result.stdout).home)).toBe(false);
    expect(readFileSync(sibling, 'utf8')).toBe('listener-ran');
    rmSync(parent, { recursive: true, force: true });
  });

  test('retires the test runner child after later file-level teardown writes', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-preload-runner-exit-'));
    const parent = join(root, 'safe-parent');
    const testFile = join(root, 'later-teardown.test.ts');
    mkdirSync(parent);
    writeFileSync(testFile, [
      "import { afterAll, expect, test } from 'bun:test';",
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "test('uses isolated home', () => expect(process.env.GBRAIN_HOME).toBeTruthy());",
      "afterAll(() => {",
      "  mkdirSync(process.env.GBRAIN_HOME!, { recursive: true });",
      "  writeFileSync(join(process.env.GBRAIN_HOME!, 'late-file-hook'), 'owned');",
      "});",
      '',
    ].join('\n'));

    try {
      const result = spawnSync(process.execPath, ['test', testFile], {
        cwd: REPO_ROOT,
        env: inheritedEnv({ GBRAIN_TEST_HOME: parent }),
        encoding: 'utf8',
      });
      expect(result.status, String(result.stderr ?? '')).toBe(0);
      expect(String(result.stderr ?? '')).not.toContain('cleanup refused');
      expect(readdirSync(parent)).toEqual([]);

      writeFileSync(testFile, [
        "import { afterAll, expect, test } from 'bun:test';",
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "test('intentional failure still cleans', () => expect(false).toBe(true));",
        "afterAll(() => {",
        "  mkdirSync(process.env.GBRAIN_HOME!, { recursive: true });",
        "  writeFileSync(join(process.env.GBRAIN_HOME!, 'late-file-hook'), 'owned');",
        "});",
        '',
      ].join('\n'));
      const failed = spawnSync(process.execPath, ['test', testFile], {
        cwd: REPO_ROOT,
        env: inheritedEnv({ GBRAIN_TEST_HOME: parent }),
        encoding: 'utf8',
      });
      expect(failed.status).toBe(1);
      expect(String(failed.stderr ?? '')).not.toContain('cleanup refused');
      expect(readdirSync(parent)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('unsafe explicit parents fail before the application body runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-preload-unsafe-'));
    const nonempty = join(root, 'source-like-nonempty');
    const reparseTarget = join(root, 'reparse-target');
    const reparseLink = join(root, 'reparse-link');
    mkdirSync(nonempty);
    mkdirSync(reparseTarget);
    writeFileSync(join(nonempty, 'source.md'), '# source');
    symlinkSync(reparseTarget, reparseLink, process.platform === 'win32' ? 'junction' : 'dir');

    const cases = [
      ['relative', 'relative-test-home'],
      ['root', parse(REPO_ROOT).root],
      ['profile-default', homedir()],
      ['repository-worktree', REPO_ROOT],
      ['nonempty-source', nonempty],
      ['reparse', reparseLink],
    ] as const;
    for (const [name, parent] of cases) {
      const bodyMarker = join(root, `${name}.body-ran`);
      const result = runPreload(
        `const { writeFileSync } = await import('node:fs'); writeFileSync(${JSON.stringify(bodyMarker)}, 'ran');`,
        { GBRAIN_TEST_HOME: parent },
      );
      expect(result.status, `${name}: ${result.stderr}`).not.toBe(0);
      expect(existsSync(bodyMarker), name).toBe(false);
    }
    const inheritedTempCases: Array<[string, Record<string, string | undefined>]> = [
      ['hostile-TEMP-repository', { TEMP: REPO_ROOT }],
      ['hostile-TEMP-profile', { TEMP: homedir() }],
      ['hostile-TMP-repository', { TEMP: ' ', TMP: REPO_ROOT }],
    ];
    for (const [name, env] of inheritedTempCases) {
      const bodyMarker = join(root, `${name}.body-ran`);
      const result = runPreload(
        `const { writeFileSync } = await import('node:fs'); writeFileSync(${JSON.stringify(bodyMarker)}, 'ran');`,
        { GBRAIN_TEST_HOME: undefined, ...env },
      );
      expect(result.status, `${name}: ${result.stderr}`).not.toBe(0);
      expect(existsSync(bodyMarker), name).toBe(false);
    }
    expect(readdirSync(reparseTarget)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});

describe('test-isolation bunfig pin', () => {
  function runGate(bunfig: string): TextSpawnResult {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-isolation-gate-'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'bunfig.toml'), bunfig);
    const init = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
    expect(init.status, init.stderr).toBe(0);
    const result = spawnSync(BASH, [ISOLATION_GATE, 'test'], {
      cwd: root,
      env: inheritedEnv(),
      encoding: 'utf8',
      timeout: 30_000,
    });
    rmSync(root, { recursive: true, force: true });
    return {
      status: result.status,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  }

  test('accepts the unique first preload and rejects missing, duplicate, and reordered pins', () => {
    const home = './test/helpers/home-isolation-preload.ts';
    const legacy = './test/helpers/legacy-embedding-preload.ts';
    const valid = runGate(`[test]\npreload = ["${home}", "${legacy}"]\n`);
    expect(valid.status, `${valid.stdout}\n${valid.stderr}`).toBe(0);

    const invalid = [
      `[test]\npreload = ["${legacy}"]\n`,
      `[test]\npreload = ["${home}", "${home}", "${legacy}"]\n`,
      `[test]\npreload = ["${legacy}", "${home}"]\n`,
      `[test]\npreload = ["${home}"]\npreload = ["${legacy}"]\n`,
      `preload = ["${home}"]\n[test]\ntimeout = 60000\n`,
    ];
    for (const bunfig of invalid) {
      expect(runGate(bunfig).status, bunfig).not.toBe(0);
    }
  }, 60_000);
});
