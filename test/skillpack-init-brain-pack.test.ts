/**
 * Tests for src/core/skillpack/init-brain-pack.ts (the brain-resident pack
 * scaffolder) and src/core/skillpack/brain-pack-lint.ts (E6 version-skew lint).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  runInitBrainPack,
  InitBrainPackError,
} from '../src/core/skillpack/init-brain-pack.ts';
import { validateSkillpackManifest } from '../src/core/skillpack/manifest-v1.ts';
import { lintBrainPackTools } from '../src/core/skillpack/brain-pack-lint.ts';
import { VERSION } from '../src/version.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-brainpack-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runInitBrainPack', () => {
  test('writes a brain_resident manifest pinned to exact VERSION', () => {
    const result = runInitBrainPack({ targetDir: dir, name: 'deal-brain', schemaPack: 'gbrain-base' });
    expect(result.manifest.brain_resident).toBe(true);
    expect(result.manifest.schema_pack).toBe('gbrain-base');
    expect(result.manifest.gbrain_min_version).toBe(VERSION); // exact, not major.minor.0
    // round-trips through the validator
    const raw = JSON.parse(readFileSync(join(dir, 'skillpack.json'), 'utf-8'));
    expect(() => validateSkillpackManifest(raw)).not.toThrow();
  });

  test('README has all 5 stable machine-parseable headings', () => {
    runInitBrainPack({ targetDir: dir, name: 'deal-brain' });
    const readme = readFileSync(join(dir, 'README.md'), 'utf-8');
    expect(readme).toContain('## 1. What this brain is');
    expect(readme).toContain('## 2. Skills in this pack');
    expect(readme).toContain('## 3. Install');
    expect(readme).toContain('## 4. Conventions this brain expects');
    expect(readme).toContain('## 5. Version compatibility');
  });

  test('refuses to overwrite existing files', () => {
    writeFileSync(join(dir, 'skillpack.json'), '{"keep":"me"}');
    const result = runInitBrainPack({ targetDir: dir, name: 'deal-brain' });
    expect(result.filesSkippedExisting).toContain(join(dir, 'skillpack.json'));
    expect(readFileSync(join(dir, 'skillpack.json'), 'utf-8')).toBe('{"keep":"me"}');
  });

  test('dry-run writes nothing', () => {
    const result = runInitBrainPack({ targetDir: dir, name: 'deal-brain', dryRun: true });
    expect(result.filesWritten.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'skillpack.json'))).toBe(false);
  });

  test('rejects non-kebab name', () => {
    expect(() => runInitBrainPack({ targetDir: dir, name: 'Deal Brain' })).toThrow(InitBrainPackError);
  });
});

describe('lintBrainPackTools (E6)', () => {
  test('flags a declared tool the serving op set does not have', () => {
    runInitBrainPack({ targetDir: dir, name: 'deal-brain', firstSkillSlug: 'diligence' });
    // Inject a tools: frontmatter with one known + one unknown op.
    const skillMd = join(dir, 'skills/diligence/SKILL.md');
    writeFileSync(
      skillMd,
      ['---', 'name: diligence', 'description: x', 'tools: [search, totally_made_up_op]', '---', '', '# diligence', ''].join('\n'),
    );
    const result = lintBrainPackTools(dir, new Set(['search', 'put_page']));
    expect(result.unknownTools).toEqual([{ skill: 'skills/diligence', tool: 'totally_made_up_op' }]);
  });

  test('no findings when all tools known (fresh pack has no tools:)', () => {
    runInitBrainPack({ targetDir: dir, name: 'deal-brain', firstSkillSlug: 'diligence' });
    const result = lintBrainPackTools(dir, new Set(['search', 'put_page']));
    expect(result.unknownTools).toEqual([]);
  });
});
