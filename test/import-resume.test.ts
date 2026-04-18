import { describe, test, expect, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  readImportCheckpoint,
  resolveImportPlan,
} from '../src/core/services/import-service.ts';

const CHECKPOINT_PATH = join(homedir(), '.mbrain', 'import-checkpoint.json');

describe('import resume checkpoint', () => {
  afterEach(() => {
    // Clean up checkpoint after each test
    if (existsSync(CHECKPOINT_PATH)) {
      rmSync(CHECKPOINT_PATH);
    }
  });

  test('checkpoint file format is valid JSON', () => {
    const checkpoint = {
      dir: '/data/brain',
      totalFiles: 13768,
      processedIndex: 5000,
      timestamp: new Date().toISOString(),
    };

    mkdirSync(join(homedir(), '.mbrain'), { recursive: true });
    writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));

    const loaded = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf-8'));
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

    mkdirSync(join(homedir(), '.mbrain'), { recursive: true });
    writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));

    const cp = readImportCheckpoint(CHECKPOINT_PATH);
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

    mkdirSync(join(homedir(), '.mbrain'), { recursive: true });
    writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));

    const plan = resolveImportPlan({
      rootDir: '/data/brain',
      allFiles: Array.from({ length: 100 }, (_, index) => `/data/brain/${index}.md`),
      fresh: false,
      checkpoint: readImportCheckpoint(CHECKPOINT_PATH),
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

    mkdirSync(join(homedir(), '.mbrain'), { recursive: true });
    writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));

    const plan = resolveImportPlan({
      rootDir: '/data/brain',
      allFiles: Array.from({ length: 100 }, (_, index) => `/data/brain/${index}.md`),
      fresh: false,
      checkpoint: readImportCheckpoint(CHECKPOINT_PATH),
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

    mkdirSync(join(homedir(), '.mbrain'), { recursive: true });
    writeFileSync(CHECKPOINT_PATH, JSON.stringify(checkpoint));

    const plan = resolveImportPlan({
      rootDir: '/data/brain',
      allFiles: Array.from({ length: 100 }, (_, index) => `/data/brain/${index}.md`),
      fresh: false,
      checkpoint: readImportCheckpoint(CHECKPOINT_PATH),
    });

    expect(plan.resumeIndex).toBe(0);
    expect(plan.resumed).toBe(false);
  });

  test('invalid checkpoint JSON starts fresh', () => {
    mkdirSync(join(homedir(), '.mbrain'), { recursive: true });
    writeFileSync(CHECKPOINT_PATH, 'not json');

    expect(readImportCheckpoint(CHECKPOINT_PATH)).toBeNull();
  });

  test('missing checkpoint file starts fresh', () => {
    expect(existsSync(CHECKPOINT_PATH)).toBe(false);
    // No checkpoint = start from 0
  });
});
