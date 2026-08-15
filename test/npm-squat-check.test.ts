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
