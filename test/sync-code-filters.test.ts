import { beforeAll, afterAll, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';

function createCodeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-code-sync-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });

  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'build/generated'), { recursive: true });
  mkdirSync(join(dir, 'keyboard/ask-core/addons/languages/en/dictionary'), { recursive: true });

  writeFileSync(join(dir, 'gbrain.yml'), `code_index:
  include:
    - "**/*.kt"
    - "**/*.kts"
  exclude:
    - "**/build/**"
    - "**/generated/**"
    - "keyboard/ask-core/addons/languages/**/dictionary/**"
`);
  writeFileSync(join(dir, 'src/main.kt'), 'class MainKeyboard\n');
  writeFileSync(join(dir, 'src/gradle.kts'), 'println("keep")\n');
  writeFileSync(join(dir, 'build/generated/skip.kt'), 'class GeneratedSkip\n');
  writeFileSync(
    join(dir, 'keyboard/ask-core/addons/languages/en/dictionary/huge.kt'),
    'class DictionaryBlob\n',
  );
  execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });

  return dir;
}

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = orig;
  }
}

describe('performSync code_index filters', () => {
  let engine: PGLiteEngine;
  let repoPath: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    repoPath = createCodeRepo();
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(repoPath, { recursive: true, force: true });
  });

  test('full code sync honors repo-local include/exclude filters and logs summary', async () => {
    const { result, logs } = await captureLogs(() =>
      performSync(engine, {
        repoPath,
        noPull: true,
        noEmbed: true,
        strategy: 'code',
      }),
    );

    expect(result.status).toBe('first_sync');
    expect(result.added).toBe(2);
    expect(await engine.getPage('src-main-kt')).not.toBeNull();
    expect(await engine.getPage('src-gradle-kts')).not.toBeNull();
    expect(await engine.getPage('build-generated-skip-kt')).toBeNull();
    expect(await engine.getPage('keyboard-ask-core-addons-languages-en-dictionary-huge-kt')).toBeNull();
    expect(logs).toContain('Code import filters: 2 include globs, 3 exclude globs');
    expect(logs).toContain('Found 2 code files after filtering');
  });

  test('incremental code sync applies the same filters to git diff changes', async () => {
    writeFileSync(join(repoPath, 'src/feature.kt'), 'class FeatureKeyboard\n');
    writeFileSync(join(repoPath, 'build/generated/ignored.kt'), 'class Ignored\n');
    execSync('git add -A && git commit -m "incremental"', { cwd: repoPath, stdio: 'pipe' });

    const { result, logs } = await captureLogs(() =>
      performSync(engine, {
        repoPath,
        noPull: true,
        noEmbed: true,
        strategy: 'code',
      }),
    );

    expect(result.status).toBe('synced');
    expect(result.added).toBe(1);
    expect(result.pagesAffected).toContain('src-feature-kt');
    expect(await engine.getPage('src-feature-kt')).not.toBeNull();
    expect(await engine.getPage('build-generated-ignored-kt')).toBeNull();
    expect(logs).toContain('Code import filters: 2 include globs, 3 exclude globs');
    expect(logs).toContain('Found 1 code files after filtering');
  });
});
