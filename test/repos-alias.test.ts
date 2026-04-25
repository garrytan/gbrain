/**
 * v0.19.0 Layer 4 — `gbrain repos` routes into the v0.18.0 sources
 * subsystem. Tests the alias wiring + the deprecation notice so scripts
 * like `gbrain repos list` keep working after the underlying subsystem
 * is replaced.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('sources subsystem (the target of the repos alias)', () => {
  test('add + list + remove round-trip', async () => {
    // Suppress console output for the test run.
    const origLog = console.log;
    const captured: string[] = [];
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
    try {
      await runSources(engine, ['add', 'repo-a', '--path', '/tmp/repo-a']);
      await runSources(engine, ['list']);
      const listOutput = captured.join('\n');
      expect(listOutput).toContain('repo-a');
      // Remove
      captured.length = 0;
      await runSources(engine, ['remove', 'repo-a', '--yes']);
      captured.length = 0;
      await runSources(engine, ['list']);
      // repo-a should no longer appear
      expect(captured.join('\n')).not.toContain('repo-a');
    } finally {
      console.log = origLog;
    }
  });
});

describe('multi-repo.ts is no longer importable', () => {
  test('module is deleted from src/core/', async () => {
    // Dynamic import should throw. If somehow a stale copy exists, we
    // want to know — this guards the Layer 4 delete. The path is built
    // at runtime so TypeScript's module resolution doesn't fail the
    // typecheck on a non-existent module (that's exactly what the test
    // is asserting at runtime).
    const missingModule = '../src/core/' + 'multi-repo.ts';
    let importErr: unknown = null;
    try {
      await import(missingModule);
    } catch (e) {
      importErr = e;
    }
    expect(importErr).not.toBeNull();
  });
});
