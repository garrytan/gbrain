import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readImportCheckpoint,
  resolveImportPlan,
} from '../src/core/services/import-service.ts';

let testDir = '';
let checkpointPath = '';

describe('import resume checkpoint', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'mbrain-import-resume-'));
    checkpointPath = join(testDir, '.mbrain', 'import-checkpoint.json');
  });

  afterEach(() => {
    // Clean up checkpoint after each test
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
    testDir = '';
    checkpointPath = '';
  });

  test('checkpoint file format is valid JSON', () => {
    const checkpoint = {
      dir: '/data/brain',
      totalFiles: 13768,
      processedIndex: 5000,
      timestamp: new Date().toISOString(),
    };

    mkdirSync(join(testDir, '.mbrain'), { recursive: true });
    writeFileSync(checkpointPath, JSON.stringify(checkpoint));

    const loaded = JSON.parse(readFileSync(checkpointPath, 'utf-8'));
    expect(loaded.dir).toBe('/data/brain');
    expect(loaded.totalFiles).toBe(13768);
    expect(loaded.processedIndex).toBe(5000);
    expect(typeof loaded.timestamp).toBe('string');
  });

  test('checkpoint with matching dir and totalFiles enables resume', () => {
    const checkpoint = {
      dir: '/data/brain',
      totalFiles: 100,
      processedIndex: 50,
      timestamp: new Date().toISOString(),
    };

    mkdirSync(join(testDir, '.mbrain'), { recursive: true });
    writeFileSync(checkpointPath, JSON.stringify(checkpoint));

    const cp = readImportCheckpoint(checkpointPath);
    const plan = resolveImportPlan({
      rootDir: '/data/brain',
      allFiles: Array.from({ length: 100 }, (_, index) => `/data/brain/${index}.md`),
      fresh: false,
      checkpoint: cp,
    });

    expect(cp?.dir).toBe('/data/brain');
    expect(cp?.totalFiles).toBe(100);
    expect(cp?.processedIndex).toBe(50);
    expect(plan.resumeIndex).toBe(50);
    expect(plan.resumed).toBe(true);
  });

  test('resume continues from processedIndex even when completedFiles is higher', () => {
    const checkpoint = {
      dir: '/data/brain',
      totalFiles: 100,
      processedIndex: 40,
      completedFiles: 95,
      timestamp: new Date().toISOString(),
    };

    mkdirSync(join(testDir, '.mbrain'), { recursive: true });
    writeFileSync(checkpointPath, JSON.stringify(checkpoint));

    const plan = resolveImportPlan({
      rootDir: '/data/brain',
      allFiles: Array.from({ length: 100 }, (_, index) => `/data/brain/${index}.md`),
      fresh: false,
      checkpoint: readImportCheckpoint(checkpointPath),
    });

    expect(plan.resumeIndex).toBe(40);
    expect(plan.files[0]).toBe('/data/brain/40.md');
    expect(plan.resumed).toBe(true);
  });

  test('checkpoint with different dir does NOT resume', () => {
    const checkpoint = {
      dir: '/data/other-brain',
      totalFiles: 100,
      processedIndex: 50,
      timestamp: new Date().toISOString(),
    };

    mkdirSync(join(testDir, '.mbrain'), { recursive: true });
    writeFileSync(checkpointPath, JSON.stringify(checkpoint));

    const plan = resolveImportPlan({
      rootDir: '/data/brain',
      allFiles: Array.from({ length: 100 }, (_, index) => `/data/brain/${index}.md`),
      fresh: false,
      checkpoint: readImportCheckpoint(checkpointPath),
    });

    expect(plan.resumeIndex).toBe(0);
    expect(plan.resumed).toBe(false);
  });

  test('checkpoint with different totalFiles does NOT resume', () => {
    const checkpoint = {
      dir: '/data/brain',
      totalFiles: 200,
      processedIndex: 50,
      timestamp: new Date().toISOString(),
    };

    mkdirSync(join(testDir, '.mbrain'), { recursive: true });
    writeFileSync(checkpointPath, JSON.stringify(checkpoint));

    const plan = resolveImportPlan({
      rootDir: '/data/brain',
      allFiles: Array.from({ length: 100 }, (_, index) => `/data/brain/${index}.md`),
      fresh: false,
      checkpoint: readImportCheckpoint(checkpointPath),
    });

    expect(plan.resumeIndex).toBe(0);
    expect(plan.resumed).toBe(false);
  });

  test('invalid checkpoint JSON starts fresh', () => {
    mkdirSync(join(testDir, '.mbrain'), { recursive: true });
    writeFileSync(checkpointPath, 'not json');

    expect(readImportCheckpoint(checkpointPath)).toBeNull();
  });

  test('missing checkpoint file starts fresh', () => {
    expect(existsSync(checkpointPath)).toBe(false);
    // No checkpoint = start from 0
  });
});
