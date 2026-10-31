/**
 * Unit tests for src/core/npm-squat-check.ts (#505).
 *
 * Tmp-dir fixtures only — fake package.json files and symlinks, no network,
 * no real npm install.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessGbrainBinaries,
  classifyGbrainBinary,
  classifyGlobalGbrainPackage,
} from '../src/core/npm-squat-check.ts';

let root: string;

/** Lay down a package dir with a package.json + a script bin; return bin path. */
function makePkg(dir: string, pkg: Record<string, unknown>, binRel = 'cli.js'): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  const bin = join(dir, binRel);
  mkdirSync(join(bin, '..'), { recursive: true });
  writeFileSync(bin, '#!/usr/bin/env node\nconsole.log("hi");\n');
  return bin;
}

let foreignLink: string; // symlink → unrelated npm package named "gbrain"
let realBinShapeLink: string; // symlink → checkout with bin.gbrain = src/cli.ts
let realRepoFieldLink: string; // symlink → package with garrytan/gbrain repository url
let brokenLink: string;
let nativeBin: string; // fake compiled binary (ELF magic)
let orphanScript: string; // script with no package.json above it

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'npm-squat-'));
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });

  // Unrelated registry package: name "gbrain" but neither real marker.
  const foreignBin = makePkg(
    join(root, 'global', 'node_modules', 'gbrain'),
    { name: 'gbrain', version: '9.9.9', bin: { gbrain: 'cli.js' } },
  );
  foreignLink = join(binDir, 'gbrain-foreign');
  symlinkSync(foreignBin, foreignLink);

  // Real project by bin shape (repo checkout / bun link / github: install).
  const realBin = makePkg(
    join(root, 'checkout'),
    { name: 'gbrain', version: '0.42.0.0', bin: { gbrain: 'src/cli.ts' } },
    join('src', 'cli.ts'),
  );
  realBinShapeLink = join(binDir, 'gbrain-real');
  symlinkSync(realBin, realBinShapeLink);

  // Real project by repository field.
  const repoFieldBin = makePkg(
    join(root, 'repo-field'),
    {
      name: 'gbrain',
      repository: { type: 'git', url: 'git+https://github.com/garrytan/gbrain.git' },
      bin: { gbrain: 'dist/cli.js' },
    },
    join('dist', 'cli.js'),
  );
  realRepoFieldLink = join(binDir, 'gbrain-repofield');
  symlinkSync(repoFieldBin, realRepoFieldLink);

  // Broken symlink.
  brokenLink = join(binDir, 'gbrain-broken');
  symlinkSync(join(root, 'does-not-exist'), brokenLink);

  // Fake compiled binary: ELF magic bytes, no package.json context needed.
  nativeBin = join(binDir, 'gbrain-native');
  writeFileSync(nativeBin, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));

  // Script with no package.json anywhere above (tmpdir has none).
  orphanScript = join(binDir, 'gbrain-orphan');
  writeFileSync(orphanScript, '#!/bin/sh\necho hi\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('classifyGbrainBinary', () => {
  test('unrelated npm package named gbrain → foreign', () => {
    const c = classifyGbrainBinary(foreignLink);
    expect(c.kind).toBe('foreign');
    expect(c.detail).toContain('unrelated npm package');
  });

  test('repo checkout bin shape (src/cli.ts) → real', () => {
    expect(classifyGbrainBinary(realBinShapeLink).kind).toBe('real');
  });

  test('garrytan/gbrain repository field → real', () => {
    expect(classifyGbrainBinary(realRepoFieldLink).kind).toBe('real');
  });

  test('broken symlink → broken', () => {
    expect(classifyGbrainBinary(brokenLink).kind).toBe('broken');
  });

  test('compiled native binary → real', () => {
    const c = classifyGbrainBinary(nativeBin);
    expect(c.kind).toBe('real');
    expect(c.detail).toContain('compiled');
  });

  test('script with no gbrain package.json above → unknown', () => {
    expect(classifyGbrainBinary(orphanScript).kind).toBe('unknown');
  });

  test('Windows/MSYS drive path resolves the executable with an .exe suffix', () => {
    const seen: string[] = [];
    const c = classifyGbrainBinary('/c/Users/chris/.bun/bin/gbrain', {
      platform: 'win32',
      realpath: (candidate) => {
        seen.push(candidate);
        if (candidate === 'C:/Users/chris/.bun/bin/gbrain.exe') return nativeBin;
        throw new Error('ENOENT');
      },
    });
    expect(seen).toEqual([
      'C:/Users/chris/.bun/bin/gbrain',
      'C:/Users/chris/.bun/bin/gbrain.exe',
    ]);
    expect(c.kind).toBe('real');
  });

  test('Windows native drive path also tries the .exe suffix', () => {
    const seen: string[] = [];
    const c = classifyGbrainBinary('C:\\Users\\chris\\.bun\\bin\\gbrain', {
      platform: 'win32',
      realpath: (candidate) => {
        seen.push(candidate);
        if (candidate.endsWith('gbrain.exe')) return nativeBin;
        throw new Error('ENOENT');
      },
    });
    expect(seen).toEqual([
      'C:\\Users\\chris\\.bun\\bin\\gbrain',
      'C:\\Users\\chris\\.bun\\bin\\gbrain.exe',
    ]);
    expect(c.kind).toBe('real');
  });

  test('non-Windows classification does not synthesize executable suffixes', () => {
    const seen: string[] = [];
    const c = classifyGbrainBinary('/opt/homebrew/bin/gbrain', {
      platform: 'darwin',
      realpath: (candidate) => {
        seen.push(candidate);
        throw new Error('ENOENT');
      },
    });
    expect(seen).toEqual(['/opt/homebrew/bin/gbrain']);
    expect(c.kind).toBe('broken');
  });
});

describe('assessGbrainBinaries', () => {
  test('no candidates → skip', () => {
    expect(assessGbrainBinaries([]).status).toBe('skip');
    expect(assessGbrainBinaries(['', '  ']).status).toBe('skip');
  });

  test('foreign shadowing real → warn with remediation', () => {
    const a = assessGbrainBinaries([foreignLink, realBinShapeLink]);
    expect(a.status).toBe('warn');
    expect(a.message).toContain('unrelated npm package');
    expect(a.message).toContain('bun install -g github:garrytan/gbrain');
  });

  test('only foreign on PATH → warn', () => {
    expect(assessGbrainBinaries([foreignLink]).status).toBe('warn');
  });

  test('broken entry wins on PATH → warn', () => {
    const a = assessGbrainBinaries([brokenLink, realBinShapeLink]);
    expect(a.status).toBe('warn');
    expect(a.message).toContain('broken');
  });

  test('real first, foreign behind → ok but noted', () => {
    const a = assessGbrainBinaries([realBinShapeLink, foreignLink]);
    expect(a.status).toBe('ok');
    expect(a.message).toContain('also installed');
  });

  test('clean real binary → ok', () => {
    const a = assessGbrainBinaries([nativeBin]);
    expect(a.status).toBe('ok');
    expect(a.binaries[0]!.kind).toBe('real');
  });

  test('unknown only → ok (fail-open, no false alarm)', () => {
    expect(assessGbrainBinaries([orphanScript]).status).toBe('ok');
  });

  test('duplicate PATH entries deduped', () => {
    const a = assessGbrainBinaries([realBinShapeLink, realBinShapeLink]);
    expect(a.binaries.length).toBe(1);
  });
});

describe('global installs (npm root -g, Bun global dir)', () => {
  let npmForeign: string; // <npm root -g>/gbrain, an unrelated package
  let bunGlobalRoot: string;
  let bunForeign: string; // <bun global>/node_modules/gbrain, an unrelated package
  let realGlobal: string; // this project installed globally

  beforeAll(() => {
    npmForeign = join(root, 'npm-prefix', 'lib', 'node_modules', 'gbrain');
    makePkg(npmForeign, { name: 'gbrain', version: '1.0.0', bin: { gbrain: 'cli.js' } });
    bunGlobalRoot = join(root, 'bun-home', 'install', 'global');
    bunForeign = join(bunGlobalRoot, 'node_modules', 'gbrain');
    makePkg(bunForeign, { name: 'gbrain', version: '1.0.0', bin: { gbrain: 'cli.js' } });
    realGlobal = join(root, 'real-prefix', 'node_modules', 'gbrain');
    makePkg(realGlobal, { name: 'gbrain', version: '0.60.0.0', bin: { gbrain: 'src/cli.ts' } }, join('src', 'cli.ts'));
  });

  test('classifies a global package directory, null when nothing named gbrain is there', () => {
    expect(classifyGlobalGbrainPackage(npmForeign)).toMatchObject({ kind: 'foreign', global: true });
    expect(classifyGlobalGbrainPackage(realGlobal)).toMatchObject({ kind: 'real', global: true });
    expect(classifyGlobalGbrainPackage(join(root, 'nowhere', 'gbrain'))).toBeNull();
  });

  test('unrelated global package and no gbrain on PATH → warn with remove, reinstall and #218 recovery', () => {
    const a = assessGbrainBinaries([], { globalPackages: [npmForeign], npmRoot: join(root, 'npm-prefix', 'lib', 'node_modules') });
    expect(a.status).toBe('warn');
    expect(a.message).toContain('installed globally');
    expect(a.message).toContain('no real gbrain is on PATH');
    expect(a.message).toContain('bun install -g github:garrytan/gbrain#latest-stable');
    expect(a.message).toContain('#218');
    expect(a.message).toContain('gbrain apply-migrations --yes --no-autopilot-install');
    expect(a.fix).toMatchObject({
      argv: ['npm', 'uninstall', '-g', 'gbrain'],
      ask_user: true,
      verify: { argv: ['gbrain', 'doctor', '--only', 'npm_squat', '--json'] },
    });
    expect(a.fix!.then!.argv).toEqual(['bun', 'install', '-g', 'github:garrytan/gbrain#latest-stable']);
    expect(a.fix!.then!.then!.argv).toEqual(['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install']);
  });

  test('an unrelated package in Bun\'s global dir is removed with Bun', () => {
    const a = assessGbrainBinaries([], { globalPackages: [bunForeign], bunGlobalRoot });
    expect(a.status).toBe('warn');
    expect(a.fix!.argv).toEqual(['bun', 'remove', '-g', 'gbrain']);
  });

  test('foreign shadowing real on PATH → fix removes it without reinstalling', () => {
    const a = assessGbrainBinaries([foreignLink, realBinShapeLink], { npmRoot: join(root, 'global', 'node_modules') });
    expect(a.fix!.argv).toEqual(['npm', 'uninstall', '-g', 'gbrain']);
    expect(a.fix!.then).toBeUndefined();
  });

  test('only foreign on PATH → fix removes it and reinstalls', () => {
    const a = assessGbrainBinaries([foreignLink], { npmRoot: join(root, 'global', 'node_modules') });
    expect(a.fix!.argv).toEqual(['npm', 'uninstall', '-g', 'gbrain']);
    expect(a.fix!.then!.argv).toEqual(['bun', 'install', '-g', 'github:garrytan/gbrain#latest-stable']);
  });

  test('a global package PATH already reaches is listed once', () => {
    const a = assessGbrainBinaries([foreignLink], { globalPackages: [join(root, 'global', 'node_modules', 'gbrain')] });
    expect(a.binaries.length).toBe(1);
    expect(a.message).toContain('on PATH resolves to an unrelated npm package');
  });

  test('real on PATH with an unrelated global package behind it → ok, noted', () => {
    const a = assessGbrainBinaries([realBinShapeLink], { globalPackages: [npmForeign] });
    expect(a.status).toBe('ok');
    expect(a.message).toContain('also installed');
    expect(a.fix).toBeUndefined();
  });

  test('a foreign package outside npm and Bun global roots gets no runnable remove command', () => {
    const a = assessGbrainBinaries([foreignLink], { npmRoot: join(root, 'npm-prefix', 'lib', 'node_modules'), bunGlobalRoot });
    expect(a.status).toBe('warn');
    expect(a.fix!.argv).toBeUndefined();
    expect(a.fix!.actor).toBe('user');
    expect(a.fix!.then).toBeUndefined();
    expect(a.fix!.user_message).toContain('package manager that installed it');
  });

  test('an unidentified gbrain on PATH before an unrelated global package → remove only, no reinstall', () => {
    const wrapperDir = join(root, 'wrapper-bin');
    mkdirSync(wrapperDir, { recursive: true });
    writeFileSync(join(wrapperDir, 'gbrain'), '#!/bin/sh\nexec bun "$HOME/gbrain/src/cli.ts" "$@"\n');
    const a = assessGbrainBinaries([join(wrapperDir, 'gbrain')], { globalPackages: [npmForeign], npmRoot: join(root, 'npm-prefix', 'lib', 'node_modules') });
    expect(a.status).toBe('warn');
    expect(a.message).not.toContain('no real gbrain is on PATH');
    expect(a.fix!.argv).toEqual(['npm', 'uninstall', '-g', 'gbrain']);
    expect(a.fix!.then).toBeUndefined();
  });

  test('doctor running from this project counts as a real gbrain → remove only, no reinstall', () => {
    const a = assessGbrainBinaries([], { globalPackages: [npmForeign], npmRoot: join(root, 'npm-prefix', 'lib', 'node_modules'), selfDir: join(realGlobal, 'src') });
    expect(a.status).toBe('warn');
    expect(a.message).not.toContain('no real gbrain is on PATH');
    expect(a.fix!.then).toBeUndefined();
  });

  test('a real global package or an empty global dir adds nothing', () => {
    expect(assessGbrainBinaries([], { globalPackages: [realGlobal, join(root, 'nowhere', 'gbrain')] }).status).toBe('skip');
  });
});
