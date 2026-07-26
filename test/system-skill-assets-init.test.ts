import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const helperSrc = readFileSync(
  new URL('../src/core/system-skill-assets.ts', import.meta.url),
  'utf8',
);
const initSrc = readFileSync(
  new URL('../src/commands/init.ts', import.meta.url),
  'utf8',
);
const applyMigrationsSrc = readFileSync(
  new URL('../src/commands/apply-migrations.ts', import.meta.url),
  'utf8',
);
const dreamSrc = readFileSync(
  new URL('../src/commands/dream.ts', import.meta.url),
  'utf8',
);
const buildSidecarSrc = readFileSync(
  new URL('../desktop/scripts/build-sidecar.ts', import.meta.url),
  'utf8',
);
const verifyPackageSrc = readFileSync(
  new URL('../desktop/scripts/verify-package.ts', import.meta.url),
  'utf8',
);

describe('system skill asset initialization', () => {
  test('tracks the canonical filing-rules assets', () => {
    expect(helperSrc).toContain('_brain-filing-rules.json');
    expect(helperSrc).toContain('_brain-filing-rules.md');
    expect(helperSrc).toContain('desktop?.knowledge_directory');
  });

  test('runs from init and upgrade paths', () => {
    expect(initSrc).toContain('ensureSystemSkillAssets');
    expect(initSrc).toContain('ensureConfiguredSystemSkillAssets(config)');
    expect(applyMigrationsSrc).toContain('ensureSystemSkillAssets');
    expect(applyMigrationsSrc).toContain('ensureConfiguredSystemSkillAssets(config)');
    expect(dreamSrc).toContain('ensureDreamSystemSkillAssets(brainDir)');
    expect(dreamSrc).toContain('ensureSystemSkillAssets(targetDir)');
  });

  test('desktop sidecar bundle carries source system skill assets', () => {
    expect(buildSidecarSrc).toContain("join(outputDirectory, 'skills', '_brain-filing-rules.json')");
    expect(buildSidecarSrc).toContain("join(outputDirectory, 'skills', '_brain-filing-rules.md')");
  });

  test('desktop package verification requires bundled system skill assets', () => {
    expect(verifyPackageSrc).toContain("join(shape.runtimeRoot, 'skills', '_brain-filing-rules.json')");
    expect(verifyPackageSrc).toContain("join(shape.runtimeRoot, 'skills', '_brain-filing-rules.md')");
  });

  test('dream validates ad-hoc input paths before cycle execution', () => {
    expect(dreamSrc).toContain('validateDreamInputPath(opts.inputFile)');
    expect(dreamSrc).toContain('--input path does not exist');
  });
});
