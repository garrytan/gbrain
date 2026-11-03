/**
 * `npm_squat` through the real CLI: `gbrain doctor --only npm_squat --json`
 * with an unrelated npm package named "gbrain" on PATH, and with one installed
 * globally (a fake `npm root -g`) whose bin is not on PATH. Both warn with an
 * ask_user fix that removes it with npm. Doctor runs from this checkout, a real
 * gbrain, so no reinstall is chained. A package outside npm's global root gets
 * no runnable command. Temp dirs only; the fake npm prints a path, and PATH
 * holds a temp bin with only bun, so a gbrain installed on the machine is never seen.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gb, oneDocument } from './helpers/agent-journey.ts';

let home: string;
let npmRoot: string;
let pathBin: string; // gbrain → unrelated package
let npmBin: string; // npm printing npmRoot, no gbrain
let otherBin: string; // gbrain → unrelated package outside npm's global root
let bunBin: string; // only bun

function foreignPackage(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'gbrain', version: '1.0.0', bin: { gbrain: 'cli.js' } }));
  writeFileSync(join(dir, 'cli.js'), '#!/usr/bin/env node\nconsole.log("not gbrain");\n');
  chmodSync(join(dir, 'cli.js'), 0o755);
  return join(dir, 'cli.js');
}

const squatOf = (doc: Record<string, any>) => (doc.checks as Array<Record<string, any>>).find(c => c.name === 'npm_squat');
const pathWith = (...dirs: string[]) => [...dirs, bunBin, '/usr/bin', '/bin'].join(':');
const fakeNpm = (dir: string, root: string) => {
  writeFileSync(join(dir, 'npm'), `#!/bin/sh\necho ${root}\n`);
  chmodSync(join(dir, 'npm'), 0o755);
};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-npm-squat-'));
  bunBin = join(home, 'bun-bin');
  mkdirSync(bunBin);
  symlinkSync(process.execPath, join(bunBin, 'bun'));
  pathBin = join(home, 'path-bin');
  mkdirSync(pathBin);
  const prefixA = join(home, 'npm-prefix-a', 'lib', 'node_modules');
  symlinkSync(foreignPackage(join(prefixA, 'gbrain')), join(pathBin, 'gbrain'));
  fakeNpm(pathBin, prefixA);
  npmRoot = join(home, 'npm-prefix-b', 'lib', 'node_modules');
  foreignPackage(join(npmRoot, 'gbrain'));
  npmBin = join(home, 'npm-bin');
  mkdirSync(npmBin);
  fakeNpm(npmBin, npmRoot);
  otherBin = join(home, 'other-bin');
  mkdirSync(otherBin);
  symlinkSync(foreignPackage(join(home, 'pnpm-global', 'node_modules', 'gbrain')), join(otherBin, 'gbrain'));
});
afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('doctor npm_squat', () => {
  test('an unrelated package on PATH warns with an npm remove and no reinstall', async () => {
    const res = await gb(home, ['doctor', '--only', 'npm_squat', '--json'], { env: { PATH: pathWith(pathBin), BUN_INSTALL: join(home, 'bun') } });
    const check = squatOf(oneDocument(res, 'doctor npm_squat'));
    expect(check).toBeDefined();
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('on PATH resolves to an unrelated npm package');
    expect(check!.fix.next).toBe('ask_user');
    expect(check!.fix.argv).toEqual(['npm', 'uninstall', '-g', 'gbrain']);
    expect(check!.fix.then).toBeUndefined();
    expect(check!.fix.verify.argv.slice(0, 5)).toEqual(['gbrain', 'doctor', '--only', 'npm_squat', '--json']);
  }, 120_000);

  test('an unrelated global npm install off PATH warns too', async () => {
    const res = await gb(home, ['doctor', '--only', 'npm_squat', '--json'], { env: { PATH: pathWith(npmBin), BUN_INSTALL: join(home, 'bun') } });
    const check = squatOf(oneDocument(res, 'doctor npm_squat'));
    expect(check).toBeDefined();
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain(`installed globally at ${realpathSync(join(npmRoot, 'gbrain'))}`);
    expect(check!.fix.argv).toEqual(['npm', 'uninstall', '-g', 'gbrain']);
  }, 120_000);

  test('an unrelated package outside npm\'s global root gets no runnable remove command', async () => {
    const res = await gb(home, ['doctor', '--only', 'npm_squat', '--json'], { env: { PATH: pathWith(otherBin, npmBin), BUN_INSTALL: join(home, 'bun') } });
    const check = squatOf(oneDocument(res, 'doctor npm_squat'));
    expect(check!.status).toBe('warn');
    expect(check!.fix.argv).toBeUndefined();
    expect(check!.fix.actor).toBe('user');
    expect(check!.fix.user_message).toContain('package manager that installed it');
  }, 120_000);
});
