import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { buildSyncManifest, isSyncable, pathToSlug, pruneDir, isCodeFilePath } from '../src/core/sync.ts';
import { buildAutoEmbedArgs, buildGitInvocation } from '../src/commands/sync.ts';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

describe('buildSyncManifest', () => {
  test('parses A/M/D entries from single commit', () => {
    const output = `A\tpeople/new-person.md\nM\tpeople/existing-person.md\nD\tpeople/deleted-person.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['people/new-person.md']);
    expect(manifest.modified).toEqual(['people/existing-person.md']);
    expect(manifest.deleted).toEqual(['people/deleted-person.md']);
    expect(manifest.renamed).toEqual([]);
  });

  test('parses R100 rename entries', () => {
    const output = `R100\tpeople/old-name.md\tpeople/new-name.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.renamed).toEqual([{ from: 'people/old-name.md', to: 'people/new-name.md' }]);
    expect(manifest.added).toEqual([]);
    expect(manifest.modified).toEqual([]);
    expect(manifest.deleted).toEqual([]);
  });

  test('parses partial rename (R075)', () => {
    const output = `R075\tpeople/old.md\tpeople/new.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.renamed).toEqual([{ from: 'people/old.md', to: 'people/new.md' }]);
  });

  test('handles empty diff', () => {
    const manifest = buildSyncManifest('');
    expect(manifest.added).toEqual([]);
    expect(manifest.modified).toEqual([]);
    expect(manifest.deleted).toEqual([]);
    expect(manifest.renamed).toEqual([]);
  });

  test('handles mixed entries with blank lines', () => {
    const output = `A\tpeople/a.md\n\nM\tpeople/b.md\n\nD\tpeople/c.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['people/a.md']);
    expect(manifest.modified).toEqual(['people/b.md']);
    expect(manifest.deleted).toEqual(['people/c.md']);
  });

  test('skips malformed lines', () => {
    const output = `A\tpeople/a.md\ngarbage line\nM\tpeople/b.md`;
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['people/a.md']);
    expect(manifest.modified).toEqual(['people/b.md']);
  });
});

describe('isSyncable', () => {
  test('accepts normal .md files', () => {
    expect(isSyncable('people/pedro-franceschi.md')).toBe(true);
    expect(isSyncable('meetings/2026-04-03-lunch.md')).toBe(true);
    expect(isSyncable('daily/2026-04-05.md')).toBe(true);
    expect(isSyncable('notes.md')).toBe(true);
  });

  test('accepts .mdx files', () => {
    expect(isSyncable('components/hero.mdx')).toBe(true);
    expect(isSyncable('docs/getting-started.mdx')).toBe(true);
  });

  test('rejects non-.md/.mdx files', () => {
    expect(isSyncable('people/photo.jpg')).toBe(false);
    expect(isSyncable('config.json')).toBe(false);
    expect(isSyncable('src/cli.ts')).toBe(false);
  });

  test('rejects files in hidden directories', () => {
    expect(isSyncable('.git/config')).toBe(false);
    expect(isSyncable('.obsidian/plugins.md')).toBe(false);
    expect(isSyncable('people/.hidden/secret.md')).toBe(false);
  });

  test('rejects .raw/ sidecar directories', () => {
    expect(isSyncable('people/pedro.raw/source.md')).toBe(false);
    expect(isSyncable('dir/.raw/notes.md')).toBe(false);
  });

  test('rejects skip-list basenames', () => {
    expect(isSyncable('schema.md')).toBe(false);
    expect(isSyncable('index.md')).toBe(false);
    expect(isSyncable('log.md')).toBe(false);
    expect(isSyncable('README.md')).toBe(false);
    expect(isSyncable('people/README.md')).toBe(false);
  });

  test('accepts ops/ — ordinary content directory, not pruned (#2404)', () => {
    expect(isSyncable('ops/deploy-log.md')).toBe(true);
    expect(isSyncable('ops/config.md')).toBe(true);
    expect(isSyncable('ops/tasks.md')).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────
  // v0.36 walker drift fix (closes #923, #202): node_modules exclusion
  // ────────────────────────────────────────────────────────────────

  test('CRITICAL latent-bug regression: rejects node_modules paths at any depth', () => {
    // Pre-v0.36, isSyncable had no node_modules check. Any markdown file
    // under a non-dot `node_modules` directory slipped through. This is
    // the canonical latent-bug fix gated by IRON RULE per the wave plan.
    expect(isSyncable('node_modules/some-pkg/README.md')).toBe(false);
    expect(isSyncable('node_modules/some-pkg/CHANGELOG.md')).toBe(false);
    expect(isSyncable('node_modules/some-pkg/docs/api.md')).toBe(false);
    expect(isSyncable('apps/web/node_modules/dep/notes.md')).toBe(false);
  });
});

describe('pruneDir', () => {
  test('blocks node_modules (no leading dot, the latent-bug case)', () => {
    expect(pruneDir('node_modules')).toBe(false);
  });

  test('blocks dot-prefix dirs (.git, .obsidian, .raw, .cache, etc.)', () => {
    expect(pruneDir('.git')).toBe(false);
    expect(pruneDir('.obsidian')).toBe(false);
    expect(pruneDir('.raw')).toBe(false);
    expect(pruneDir('.cache')).toBe(false);
    expect(pruneDir('.vscode')).toBe(false);
  });

  test('allows ops — ordinary content dir, not a vendor tree (#2404)', () => {
    expect(pruneDir('ops')).toBe(true);
  });

  test('blocks vendored / generated trees', () => {
    expect(pruneDir('vendor')).toBe(false);
    expect(pruneDir('dist')).toBe(false);
    expect(pruneDir('build')).toBe(false);
    expect(pruneDir('venv')).toBe(false);
  });

  test('blocks *.raw sidecar dirs (gbrain convention)', () => {
    expect(pruneDir('.raw')).toBe(false);
    expect(pruneDir('pedro.raw')).toBe(false);
    expect(pruneDir('article.raw')).toBe(false);
  });

  test('allows normal content dirs', () => {
    expect(pruneDir('wiki')).toBe(true);
    expect(pruneDir('people')).toBe(true);
    expect(pruneDir('meetings')).toBe(true);
    expect(pruneDir('corpus')).toBe(true);
    expect(pruneDir('2026')).toBe(true);
  });

  test('empty string returns true (defensive default)', () => {
    expect(pruneDir('')).toBe(true);
  });
});

describe('isCodeFilePath', () => {
  test('v0.36.x #878 regression: Terraform / HCL extensions are admitted', () => {
    expect(isCodeFilePath('infra/main.tf')).toBe(true);
    expect(isCodeFilePath('infra/prod.tfvars')).toBe(true);
    expect(isCodeFilePath('modules/network/variables.hcl')).toBe(true);
  });

  test('extensions are case-insensitive', () => {
    expect(isCodeFilePath('INFRA/MAIN.TF')).toBe(true);
    expect(isCodeFilePath('Modules/Net/Vars.HCL')).toBe(true);
  });

  test('does not false-positive on lookalike suffixes', () => {
    expect(isCodeFilePath('docs/notes.txt')).toBe(false);
    expect(isCodeFilePath('readme.tflint')).toBe(false);
    expect(isCodeFilePath('config.hcling')).toBe(false);
  });

  test('still accepts the v0.20.0 baseline set (regression guard)', () => {
    expect(isCodeFilePath('src/foo.ts')).toBe(true);
    expect(isCodeFilePath('src/bar.py')).toBe(true);
    expect(isCodeFilePath('config.toml')).toBe(true);
  });
});

describe('pathToSlug', () => {
  test('strips .md extension and lowercases', () => {
    expect(pathToSlug('people/pedro-franceschi.md')).toBe('people/pedro-franceschi');
  });

  test('normalizes to lowercase', () => {
    expect(pathToSlug('People/Pedro-Franceschi.md')).toBe('people/pedro-franceschi');
  });

  test('strips leading slash', () => {
    expect(pathToSlug('/people/pedro.md')).toBe('people/pedro');
  });

  test('normalizes backslash separators', () => {
    expect(pathToSlug('people\\pedro.md')).toBe('people/pedro');
  });

  test('handles flat files', () => {
    expect(pathToSlug('notes.md')).toBe('notes');
  });

  test('handles nested paths', () => {
    expect(pathToSlug('projects/gbrain/spec.md')).toBe('projects/gbrain/spec');
  });

  test('adds repo prefix when provided', () => {
    expect(pathToSlug('people/pedro.md', 'brain')).toBe('brain/people/pedro');
  });

  test('no prefix when not provided', () => {
    expect(pathToSlug('people/pedro.md')).toBe('people/pedro');
  });

  test('handles empty string', () => {
    expect(pathToSlug('')).toBe('');
  });

  test('handles file with only extension', () => {
    expect(pathToSlug('.md')).toBe('');
  });

  test('slugifies spaces to hyphens', () => {
    expect(pathToSlug('Apple Notes/2017-05-03 ohmygreen.md')).toBe('apple-notes/2017-05-03-ohmygreen');
  });

  test('strips special characters', () => {
    expect(pathToSlug('notes/meeting (march 2024).md')).toBe('notes/meeting-march-2024');
  });
});

describe('isSyncable edge cases', () => {
  test('rejects uppercase .MD extension', () => {
    // isSyncable checks path.endsWith('.md'), so .MD should fail
    expect(isSyncable('people/someone.MD')).toBe(false);
  });

  test('rejects files with no extension', () => {
    expect(isSyncable('README')).toBe(false);
  });

  test('accepts deeply nested .md files', () => {
    expect(isSyncable('a/b/c/d/e/f/deep.md')).toBe(true);
  });

  test('rejects .md files inside nested hidden dirs', () => {
    expect(isSyncable('docs/.internal/secret.md')).toBe(false);
  });
});

describe('buildSyncManifest edge cases', () => {
  test('handles tab-separated fields correctly', () => {
    const output = "A\tpath/to/file.md";
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual(['path/to/file.md']);
  });

  test('handles multiple renames', () => {
    const output = [
      'R100\told/a.md\tnew/a.md',
      'R095\told/b.md\tnew/b.md',
    ].join('\n');
    const manifest = buildSyncManifest(output);
    expect(manifest.renamed).toHaveLength(2);
    expect(manifest.renamed[0].from).toBe('old/a.md');
    expect(manifest.renamed[1].from).toBe('old/b.md');
  });

  test('ignores unknown status codes', () => {
    const output = "X\tunknown/file.md";
    const manifest = buildSyncManifest(output);
    expect(manifest.added).toEqual([]);
    expect(manifest.modified).toEqual([]);
    expect(manifest.deleted).toEqual([]);
    expect(manifest.renamed).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────
// performSync dry-run (v0.17 regression guard for full-sync silent writes)
// ────────────────────────────────────────────────────────────────

describe('performSync dry-run never writes', () => {
  let engine: PGLiteEngine;
  let repoPath: string;

  // One PGLite per file — beforeEach wipes data only. Each test still gets a
  // fresh git repo via mkdtempSync, but skips the ~20s PGLite cold-start.
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-sync-dryrun-'));
    execSync('git init', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
    mkdirSync(join(repoPath, 'people'), { recursive: true });
    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---',
      'type: person',
      'title: Alice',
      '---',
      '',
      'Alice is a person.',
    ].join('\n'));
    writeFileSync(join(repoPath, 'people/bob.md'), [
      '---',
      'type: person',
      'title: Bob',
      '---',
      '',
      'Bob is another person.',
    ].join('\n'));
    execSync('git add -A && git commit -m "initial"', { cwd: repoPath, stdio: 'pipe' });
  });

  afterEach(() => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  });

  test('first-sync dry-run does NOT write to DB or advance the bookmark', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, {
      repoPath,
      dryRun: true,
      noPull: true,
      noEmbed: true,
    });

    // Status + counts reflect what WOULD be imported.
    expect(result.status).toBe('dry_run');
    expect(result.added).toBe(2); // alice + bob, both syncable
    expect(result.chunksCreated).toBe(0);
    expect(result.embedded).toBe(0);

    // DB is clean: no pages written.
    expect(await engine.getPage('people/alice')).toBeNull();
    expect(await engine.getPage('people/bob')).toBeNull();

    // Bookmark NOT set — this is the regression the guard enforces.
    expect(await engine.getConfig('sync.last_commit')).toBeNull();
    expect(await engine.getConfig('sync.repo_path')).toBeNull();
  });

  test('single-source --json emits exactly one schema-1 document', async () => {
    const { runSync } = await import('../src/commands/sync.ts');
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const originalLog = console.log;
    const originalError = console.error;
    let stdout = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    console.log = (...args: unknown[]) => {
      stdout += args.map(String).join(' ') + '\n';
    };
    console.error = () => {};
    try {
      await runSync(engine, [
        '--source', 'default',
        '--repo', repoPath,
        '--strategy', 'markdown',
        '--dry-run',
        '--no-pull',
        '--no-embed',
        '--no-extract',
        '--json',
      ]);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      console.log = originalLog;
      console.error = originalError;
    }

    const documents = stdout.trim().split('\n');
    expect(documents).toHaveLength(1);
    const parsed = JSON.parse(documents[0]) as Record<string, unknown>;
    expect(parsed.schema_version).toBe(1);
    expect(parsed.result_kind).toBe('gbrain_sync');
    expect(parsed.status).toBe('dry_run');
    const corpus = parsed.corpus as Record<string, unknown>;
    expect(corpus.image_operations_applied).toBe(0);
    expect(corpus.image_pages_after).toBe(0);
    expect(Object.values(corpus)).not.toContain(null);
  });

  test('JSON parse refusals are one gbrain_sync_error document', async () => {
    const { runSync } = await import('../src/commands/sync.ts');
    for (const testCase of [
      {
        args: ['--json', '--dry-run', '--expected-target'],
        reason: 'plan_failed',
      },
      {
        args: [
          '--json',
          '--dry-run',
          '--expected-bookmark', 'none',
          '--expected-bookmark', 'none',
        ],
        reason: 'plan_failed',
      },
      {
        args: ['--json', '--dry-run', '--skip-failed'],
        reason: 'dry_run_modifier_conflict',
      },
      {
        args: ['--json', '--dry-run', '--strategy', 'typo'],
        reason: 'plan_failed',
      },
      {
        args: ['--json', '--dry-run', '--unknown-sync-flag'],
        reason: 'plan_failed',
      },
      {
        args: ['--json', '--dry-run', '--source', 'default', '--source', 'default'],
        reason: 'plan_failed',
      },
      {
        args: ['--json', '--dry-run', '--repo'],
        reason: 'plan_failed',
      },
      {
        args: ['--json', '--watch'],
        reason: 'plan_failed',
      },
      {
        args: ['--json', '--help'],
        reason: 'plan_failed',
      },
      {
        args: ['--json', '--dry-run', '--missing-path', 'invalid'],
        reason: 'plan_failed',
      },
      {
        args: ['--json', '--dry-run', '--max-age', 'invalid'],
        reason: 'plan_failed',
      },
      {
        args: ['--json', '--dry-run', '--max-sources', '0'],
        reason: 'plan_failed',
      },
      {
        args: ['--json', '--dry-run', '--workers', '0'],
        reason: 'plan_failed',
      },
      {
        args: ['--json', '--dry-run', '--parallel', '0'],
        reason: 'plan_failed',
      },
      {
        args: ['--json', '--dry-run', '--timeout', 'invalid'],
        reason: 'plan_failed',
      },
    ]) {
      const originalExit = process.exit;
      const originalStdoutWrite = process.stdout.write;
      const originalLog = console.log;
      const originalError = console.error;
      let stdout = '';
      const exit = new Error('__expected_exit__');
      process.exit = (() => {
        throw exit;
      }) as never;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      }) as typeof process.stdout.write;
      console.log = (...args: unknown[]) => {
        stdout += args.map(String).join(' ') + '\n';
      };
      console.error = () => {};
      try {
        await runSync(engine, testCase.args);
      } catch (error) {
        if (error !== exit) throw error;
      } finally {
        process.exit = originalExit;
        process.stdout.write = originalStdoutWrite;
        console.log = originalLog;
        console.error = originalError;
      }

      const documents = stdout.trim().split('\n');
      expect(documents).toHaveLength(1);
      const parsed = JSON.parse(documents[0]) as Record<string, unknown>;
      expect(parsed.schema_version).toBe(1);
      expect(parsed.result_kind).toBe('gbrain_sync_error');
      expect(parsed.reason_code).toBe(testCase.reason);
      expect(parsed.state_changed).toBe('none');
    }
  });

  test('source-resolution failures remain one JSON refusal document', async () => {
    const { runSync } = await import('../src/commands/sync.ts');
    const originalExit = process.exit;
    const originalStdoutWrite = process.stdout.write;
    const originalLog = console.log;
    const originalError = console.error;
    let stdout = '';
    const exit = new Error('__expected_exit__');
    process.exit = (() => {
      throw exit;
    }) as never;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    console.log = (...args: unknown[]) => {
      stdout += args.map(String).join(' ') + '\n';
    };
    console.error = () => {};
    try {
      await runSync(engine, [
        '--json',
        '--source', 'missing-source',
        '--repo', repoPath,
        '--strategy', 'auto',
        '--dry-run',
        '--no-pull',
        '--no-embed',
        '--no-extract',
      ]);
    } catch (error) {
      if (error !== exit) throw error;
    } finally {
      process.exit = originalExit;
      process.stdout.write = originalStdoutWrite;
      console.log = originalLog;
      console.error = originalError;
    }

    const documents = stdout.trim().split('\n');
    expect(documents).toHaveLength(1);
    const parsed = JSON.parse(documents[0]) as Record<string, unknown>;
    expect(parsed.result_kind).toBe('gbrain_sync_error');
    expect(parsed.reason_code).toBe('source_changed');
    expect(parsed.state_changed).toBe('none');
  });

  test('schema-1 errors report partial after durable sync work begins', async () => {
    const { performSync, runSync } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
      [repoPath],
    );
    await performSync(engine, {
      repoPath,
      sourceId: 'default',
      strategy: 'markdown',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const bookmark = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(repoPath, 'people/alice.md'),
      [
        '---',
        'type: person',
        'title: Alice',
        '---',
        '',
        'Alice changed after the baseline.',
      ].join('\n'),
    );
    execSync('git add -A && git commit -m "change alice"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    const originalLogIngest = engine.logIngest.bind(engine);
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const originalLog = console.log;
    const originalError = console.error;
    let stdout = '';
    engine.logIngest = async () => {
      throw new Error('injected post-bookmark failure');
    };
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    console.log = (...args: unknown[]) => {
      stdout += args.map(String).join(' ') + '\n';
    };
    console.error = () => {};
    try {
      await runSync(engine, [
        '--json',
        '--source', 'default',
        '--repo', repoPath,
        '--strategy', 'markdown',
        '--no-pull',
        '--no-embed',
        '--no-extract',
        '--expected-target', target,
        '--expected-bookmark', bookmark,
        '--require-clean',
      ]);
    } finally {
      engine.logIngest = originalLogIngest;
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      console.log = originalLog;
      console.error = originalError;
    }

    const documents = stdout.trim().split('\n');
    expect(documents).toHaveLength(1);
    const parsed = JSON.parse(documents[0]) as Record<string, unknown>;
    expect(parsed.result_kind).toBe('gbrain_sync_error');
    expect(parsed.state_changed).toBe('partial');
    const sourceRows = await engine.executeRaw<{ last_commit: string | null }>(
      `SELECT last_commit FROM sources WHERE id = 'default'`,
    );
    expect(sourceRows[0]?.last_commit).toBe(target);
  });

  test('schema-1 paired precondition failures report no state change', async () => {
    const { runSync } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
      [repoPath],
    );
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    const originalLog = console.log;
    const originalError = console.error;
    let stdout = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    console.log = (...args: unknown[]) => {
      stdout += args.map(String).join(' ') + '\n';
    };
    console.error = () => {};
    try {
      await runSync(engine, [
        '--json',
        '--source', 'default',
        '--repo', repoPath,
        '--strategy', 'markdown',
        '--dry-run',
        '--no-pull',
        '--expected-target', '0000000000000000000000000000000000000000',
        '--expected-bookmark', 'none',
        '--require-clean',
      ]);
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      console.log = originalLog;
      console.error = originalError;
    }

    const documents = stdout.trim().split('\n');
    expect(documents).toHaveLength(1);
    const parsed = JSON.parse(documents[0]) as Record<string, unknown>;
    expect(parsed.result_kind).toBe('gbrain_sync_error');
    expect(parsed.reason_code).toBe('target_changed');
    expect(parsed.state_changed).toBe('none');
  });

  test('paired CLI refuses --skip-failed before source resolution or mutation', async () => {
    const { runSync } = await import('../src/commands/sync.ts');
    const originalExit = process.exit;
    const originalStdoutWrite = process.stdout.write;
    const originalError = console.error;
    const exit = new Error('__expected_exit__');
    let exitCode: number | undefined;
    let stdout = '';
    let engineTouched = false;
    const refusingEngine = new Proxy({} as PGLiteEngine, {
      get() {
        engineTouched = true;
        throw new Error('engine must not be touched');
      },
    });
    process.exit = ((code?: number) => {
      exitCode = code;
      throw exit;
    }) as never;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    console.error = () => {};
    try {
      await runSync(refusingEngine, [
        '--json',
        '--source', 'default',
        '--repo', repoPath,
        '--strategy', 'markdown',
        '--no-pull',
        '--skip-failed',
        '--expected-target', '0000000000000000000000000000000000000000',
        '--expected-bookmark', 'none',
        '--require-clean',
      ]);
    } catch (error) {
      if (error !== exit) throw error;
    } finally {
      process.exit = originalExit;
      process.stdout.write = originalStdoutWrite;
      console.error = originalError;
    }

    expect(exitCode).toBe(1);
    expect(engineTouched).toBe(false);
    const documents = stdout.trim().split('\n');
    expect(documents).toHaveLength(1);
    const parsed = JSON.parse(documents[0]) as Record<string, unknown>;
    expect(parsed.result_kind).toBe('gbrain_sync_error');
    expect(parsed.reason_code).toBe('plan_failed');
    expect(parsed.state_changed).toBe('none');
  });

  test('paired exact-target sync requires no-pull before taking the writer path', async () => {
    const { performSync, SyncPreconditionError } = await import('../src/commands/sync.ts');
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    await expect(
      performSync(engine, {
        repoPath,
        dryRun: true,
        noEmbed: true,
        noExtract: true,
        expectedTarget: target,
        expectedBookmark: null,
        requireClean: true,
      }),
    ).rejects.toBeInstanceOf(SyncPreconditionError);
    expect(await engine.getConfig('sync.last_commit')).toBeNull();
  });

  test('paired default source refuses a repository outside its registered root', async () => {
    const { performSync, SyncPreconditionError } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `UPDATE sources SET local_path = $1 WHERE id = 'default'`,
      [repoPath],
    );
    const otherRepo = mkdtempSync(join(tmpdir(), 'gbrain-sync-other-root-'));
    execSync('git init', { cwd: otherRepo, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: otherRepo, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: otherRepo, stdio: 'pipe' });
    writeFileSync(join(otherRepo, 'other.md'), '# Other\n');
    execSync('git add -A && git commit -m "other"', { cwd: otherRepo, stdio: 'pipe' });
    const target = execSync('git rev-parse HEAD', {
      cwd: otherRepo,
      encoding: 'utf8',
    }).trim();

    try {
      await expect(
        performSync(engine, {
          sourceId: 'default',
          repoPath: otherRepo,
          dryRun: true,
          noPull: true,
          noEmbed: true,
          noExtract: true,
          expectedTarget: target,
          expectedBookmark: null,
          requireClean: true,
        }),
      ).rejects.toBeInstanceOf(SyncPreconditionError);
    } finally {
      rmSync(otherRepo, { recursive: true, force: true });
    }
    expect(await engine.getPage('other')).toBeNull();
  });

  test('paired schema-1 apply refuses multimodal indexing before mutation', async () => {
    const { performSync, SyncPreconditionError } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-multimodal', repoPath],
    );
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, async () => {
      await expect(
        performSync(engine, {
          sourceId: 'paired-multimodal',
          repoPath,
          strategy: 'auto',
          noPull: true,
          noEmbed: true,
          noExtract: true,
          expectedTarget: target,
          expectedBookmark: null,
          requireClean: true,
        }),
      ).rejects.toBeInstanceOf(SyncPreconditionError);
    });
    expect(await engine.getPage('people/alice', {
      sourceId: 'paired-multimodal',
    })).toBeNull();
    const rows = await engine.executeRaw<{ last_commit: string | null }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-multimodal'],
    );
    expect(rows[0].last_commit).toBeNull();
  });

  test('first sync without origin skips git pull noise and uses local working tree', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const messages: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')); };
    try {
      const result = await performSync(engine, {
        repoPath,
        noEmbed: true,
      });
      expect(result.status).toBe('first_sync');
    } finally {
      console.error = originalError;
    }

    expect(messages.some(m => m.includes('No origin remote') && m.includes('skipping git pull'))).toBe(true);
    expect(messages.some(m => m.includes('sync.git_pull start'))).toBe(false);
    expect(messages.some(m => m.includes('git pull failed'))).toBe(false);
  });

  test('incremental dry-run does NOT write to DB or advance the bookmark', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // First do a real sync to seed the bookmark.
    const real = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });
    expect(real.status).toBe('first_sync');
    const bookmarkAfterReal = await engine.getConfig('sync.last_commit');
    expect(bookmarkAfterReal).not.toBeNull();

    // Add a third file.
    writeFileSync(join(repoPath, 'people/carol.md'), [
      '---',
      'type: person',
      'title: Carol',
      '---',
      '',
      'Carol joins the cast.',
    ].join('\n'));
    execSync('git add -A && git commit -m "add carol"', { cwd: repoPath, stdio: 'pipe' });

    // Incremental sync in dry-run mode.
    const result = await performSync(engine, {
      repoPath,
      dryRun: true,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('dry_run');
    expect(result.added).toBe(1); // carol only
    expect(result.chunksCreated).toBe(0);
    expect(result.embedded).toBe(0);

    // carol is NOT in the DB.
    expect(await engine.getPage('people/carol')).toBeNull();
    // alice + bob still present from the real sync.
    expect(await engine.getPage('people/alice')).not.toBeNull();
    expect(await engine.getPage('people/bob')).not.toBeNull();

    // Bookmark unchanged — still at the pre-carol commit.
    const bookmarkAfterDry = await engine.getConfig('sync.last_commit');
    expect(bookmarkAfterDry).toBe(bookmarkAfterReal);
  });

  test('strategy-changing dry-run preserves previously indexed out-of-strategy pages', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
    });
    expect(await engine.getPage('people/alice')).not.toBeNull();

    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---',
      'type: person',
      'title: Alice',
      '---',
      '',
      'Alice changed after the initial sync.',
    ].join('\n'));
    execSync('git add -A && git commit -m "update alice"', { cwd: repoPath, stdio: 'pipe' });

    const result = await performSync(engine, {
      repoPath,
      strategy: 'code',
      dryRun: true,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('dry_run');
    expect(await engine.getPage('people/alice')).not.toBeNull();
  });

  test('paired strategy apply reports the locked bookmark and exact plan evidence', async () => {
    const {
      buildGBrainSyncEnvelope,
      performSync,
    } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-source', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-source',
      repoPath,
      strategy: 'markdown',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const sourceBefore = await engine.executeRaw<{
      last_commit: string;
    }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-source'],
    );
    const bookmark = sourceBefore[0].last_commit;

    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(
      join(repoPath, 'src/app.ts'),
      'export const answer = 42;\n',
    );
    execSync('git add -A && git commit -m "add code"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    const opts = {
      sourceId: 'paired-source',
      repoPath,
      strategy: 'code' as const,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    };
    const result = await performSync(engine, opts);
    const envelope = buildGBrainSyncEnvelope(result, opts);

    expect(result.status).toBe('first_sync');
    expect(envelope.repository.from_commit).toBe(bookmark);
    expect(envelope.repository.target_commit).toBe(target);
    expect(envelope.repository.bookmark_after).toBe(target);
    expect(envelope.repository.last_successful_strategy).toBe('code');
    expect(envelope.strategy_changed).toBe(true);
    expect(envelope.operations.added).toBe(1);
    expect(envelope.operations.preserved).toBe(2);
    expect(envelope.corpus.markdown_planned_or_applied).toBe(0);
    expect(envelope.corpus.code_pages_before).toBe(0);
    expect(envelope.corpus.code_pages_after).toBe(1);
    expect(envelope.corpus.code_deletions_applied).toBe(0);
    expect(envelope.corpus.image_operations_applied).toBe(0);
    expect(envelope.corpus.image_pages_after).toBe(0);
    expect(envelope.corpus.multimodal_enabled).toBe(false);
    expect(envelope.corpus.embedding_status).toBe('deferred');
    expect(envelope.corpus.extraction_status).toBe('deferred');
    expect(envelope.corpus.search_ready).toBe(false);
    expect(Object.keys(envelope.corpus).sort()).toEqual([
      'code_deletions_applied',
      'code_pages_after',
      'code_pages_before',
      'embedding_status',
      'extraction_status',
      'image_operations_applied',
      'image_pages_after',
      'markdown_planned_or_applied',
      'multimodal_enabled',
      'search_ready',
    ]);
    for (const key of [
      'markdown_planned_or_applied',
      'code_pages_before',
      'code_pages_after',
      'code_deletions_applied',
      'image_operations_applied',
      'image_pages_after',
    ] as const) {
      expect(Number.isInteger(envelope.corpus[key])).toBe(true);
      expect(envelope.corpus[key]).toBeGreaterThanOrEqual(0);
    }
    expect(await engine.getPage('people/alice', {
      sourceId: 'paired-source',
    })).not.toBeNull();
  });

  test('paired full apply blocks when a planned delete is not accounted', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-delete', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-delete',
      repoPath,
      strategy: 'markdown',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const rows = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-delete'],
    );
    const bookmark = rows[0].last_commit;
    rmSync(join(repoPath, 'people/alice.md'));
    execSync('git add -A && git commit -m "remove alice"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    const originalDeletePages = engine.deletePages.bind(engine);
    engine.deletePages = async () => [];
    let result;
    try {
      result = await performSync(engine, {
        sourceId: 'paired-delete',
        repoPath,
        strategy: 'markdown',
        full: true,
        noPull: true,
        noEmbed: true,
        noExtract: true,
        expectedTarget: target,
        expectedBookmark: bookmark,
        requireClean: true,
      });
    } finally {
      engine.deletePages = originalDeletePages;
    }

    expect(result.status).toBe('blocked_by_failures');
    expect(result.deleted).toBe(1);
    const after = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-delete'],
    );
    expect(after[0].last_commit).toBe(bookmark);
    expect(await engine.getPage('people/alice', {
      sourceId: 'paired-delete',
    })).not.toBeNull();
  });

  test('full and incremental plans both preserve a rename into an excluded path', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-excluded-rename', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-excluded-rename',
      repoPath,
      strategy: 'markdown',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const rows = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-excluded-rename'],
    );
    const bookmark = rows[0].last_commit;
    mkdirSync(join(repoPath, 'archive'), { recursive: true });
    execSync('git mv people/alice.md archive/alice.md', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    execSync('git commit -m "move alice into excluded archive"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    const paired = {
      sourceId: 'paired-excluded-rename',
      repoPath,
      strategy: 'markdown' as const,
      dryRun: true,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
      exclude: ['archive/**'],
    };

    const incremental = await performSync(engine, paired);
    const full = await performSync(engine, { ...paired, full: true });

    expect(incremental.deleted).toBe(0);
    expect(incremental.preserved).toBe(1);
    expect(incremental.affected?.total).toBe(0);
    expect(full.deleted).toBe(0);
    expect(full.preserved).toBe(1);
    expect(full.affected?.total).toBe(0);
    expect(full.affectedDigest).toBe(incremental.affectedDigest);
    expect(await engine.getPage('people/alice', {
      sourceId: 'paired-excluded-rename',
    })).not.toBeNull();
  });

  test('full and incremental plans both preserve a rename outside the selected strategy', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-strategy-rename', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-strategy-rename',
      repoPath,
      strategy: 'markdown',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const rows = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-strategy-rename'],
    );
    const bookmark = rows[0].last_commit;
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    execSync('git mv people/alice.md src/alice.ts', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    execSync('git commit -m "move alice outside markdown strategy"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    const paired = {
      sourceId: 'paired-strategy-rename',
      repoPath,
      strategy: 'markdown' as const,
      dryRun: true,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    };

    const incremental = await performSync(engine, paired);
    const full = await performSync(engine, { ...paired, full: true });

    expect(incremental.deleted).toBe(0);
    expect(incremental.preserved).toBe(1);
    expect(incremental.affected?.total).toBe(0);
    expect(full.deleted).toBe(0);
    expect(full.preserved).toBe(1);
    expect(full.affected?.total).toBe(0);
    expect(full.affectedDigest).toBe(incremental.affectedDigest);
    expect(await engine.getPage('people/alice', {
      sourceId: 'paired-strategy-rename',
    })).not.toBeNull();
  });

  test('full and incremental plans both preserve a modified command-excluded path', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-excluded-modify', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-excluded-modify',
      repoPath,
      strategy: 'markdown',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const rows = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-excluded-modify'],
    );
    const bookmark = rows[0].last_commit;
    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---',
      'type: person',
      'title: Alice',
      '---',
      '',
      'This excluded edit must remain unplanned.',
    ].join('\n'));
    execSync('git add -A && git commit -m "modify excluded alice"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    const paired = {
      sourceId: 'paired-excluded-modify',
      repoPath,
      strategy: 'markdown' as const,
      dryRun: true,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
      exclude: ['people/alice.md'],
    };

    const incremental = await performSync(engine, paired);
    const full = await performSync(engine, { ...paired, full: true });

    expect(incremental.modified).toBe(0);
    expect(incremental.preserved).toBe(1);
    expect(incremental.affected?.total).toBe(0);
    expect(full.modified).toBe(0);
    expect(full.preserved).toBe(1);
    expect(full.affected?.total).toBe(0);
    expect(full.affectedDigest).toBe(incremental.affectedDigest);
  });

  test('paired delete never removes a same-slug manual page that the source never indexed', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    writeFileSync(
      join(repoPath, 'note.md'),
      ['---', 'type: note', 'title: Repository note', '---', '', 'Excluded.'].join('\n'),
    );
    execSync('git add -A && git commit -m "add excluded repository note"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-manual-delete', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-manual-delete',
      repoPath,
      strategy: 'markdown',
      exclude: ['note.md'],
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    await engine.putPage('note', {
      type: 'note',
      title: 'Manual note',
      compiled_truth: 'Must survive repository deletion.',
      frontmatter: {},
    }, { sourceId: 'paired-manual-delete' });
    const before = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-manual-delete'],
    );
    const bookmark = before[0].last_commit;
    rmSync(join(repoPath, 'note.md'));
    execSync('git add -A && git commit -m "delete excluded repository note"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    const paired = {
      sourceId: 'paired-manual-delete',
      repoPath,
      strategy: 'markdown' as const,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    };

    const incremental = await performSync(engine, {
      ...paired,
      dryRun: true,
    });
    const full = await performSync(engine, {
      ...paired,
      dryRun: true,
      full: true,
    });
    expect(incremental.deleted).toBe(0);
    expect(incremental.affected?.total).toBe(0);
    expect(full.deleted).toBe(0);
    expect(full.affected?.total).toBe(0);

    const applied = await performSync(engine, paired);
    expect(applied.status).toBe('up_to_date');
    expect(await engine.getPage('note', {
      sourceId: 'paired-manual-delete',
    })).not.toBeNull();
  });

  test('deletion under a command exclusion preserves the indexed page in full and incremental modes', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    mkdirSync(join(repoPath, 'notes'), { recursive: true });
    writeFileSync(
      join(repoPath, 'notes/a.md'),
      ['---', 'type: note', 'title: A', '---', '', 'Keep this indexed.'].join('\n'),
    );
    execSync('git add -A && git commit -m "add excluded deletion fixture"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-excluded-delete', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-excluded-delete',
      repoPath,
      strategy: 'markdown',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const before = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-excluded-delete'],
    );
    const bookmark = before[0].last_commit;
    rmSync(join(repoPath, 'notes/a.md'));
    execSync('git add -A && git commit -m "delete command-excluded page"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    const paired = {
      sourceId: 'paired-excluded-delete',
      repoPath,
      strategy: 'markdown' as const,
      exclude: ['notes/**'],
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    };

    const incremental = await performSync(engine, {
      ...paired,
      dryRun: true,
    });
    const full = await performSync(engine, {
      ...paired,
      dryRun: true,
      full: true,
    });
    expect(incremental.deleted).toBe(0);
    expect(incremental.preserved).toBe(1);
    expect(full.deleted).toBe(0);
    expect(full.preserved).toBe(1);
    expect(full.affectedDigest).toBe(incremental.affectedDigest);

    const applied = await performSync(engine, paired);
    expect(applied.deleted).toBe(0);
    expect(await engine.getPage('notes/a', {
      sourceId: 'paired-excluded-delete',
    })).not.toBeNull();
  });

  test('incremental fallback-slug evidence matches preview and apply', async () => {
    const {
      buildGBrainSyncEnvelope,
      performSync,
    } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-fallback-slug', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-fallback-slug',
      repoPath,
      strategy: 'auto',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const rows = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-fallback-slug'],
    );
    const bookmark = rows[0].last_commit;
    writeFileSync(
      join(repoPath, '💾.md'),
      ['---', 'type: concept', 'title: Disk', 'slug: disk', '---', '', 'Saved.'].join('\n'),
    );
    execSync('git add -A && git commit -m "add fallback slug page"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    const paired = {
      sourceId: 'paired-fallback-slug',
      repoPath,
      strategy: 'auto' as const,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    };

    const previewResult = await performSync(engine, {
      ...paired,
      dryRun: true,
    });
    const preview = buildGBrainSyncEnvelope(previewResult, paired);
    expect(preview.affected.sample).toEqual([
      {
        operation: 'add',
        path: '💾.md',
        slug: 'disk',
      },
    ]);

    const appliedResult = await performSync(engine, paired);
    const applied = buildGBrainSyncEnvelope(appliedResult, paired);
    expect(applied.affected).toEqual(preview.affected);
    expect(applied.affected_digest).toBe(preview.affected_digest);
    expect(await engine.getPage('disk', {
      sourceId: 'paired-fallback-slug',
    })).not.toBeNull();
  });

  test('paired delete applies the immutable planned fallback slug without re-resolving it', async () => {
    const {
      buildGBrainSyncEnvelope,
      performSync,
    } = await import('../src/commands/sync.ts');
    writeFileSync(
      join(repoPath, '💾.md'),
      [
        '---',
        'type: concept',
        'title: Canonical disk',
        'slug: canonical-disk',
        '---',
        '',
        'Stored under a frontmatter fallback slug.',
      ].join('\n'),
    );
    execSync('git add -A && git commit -m "add planned fallback delete"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-planned-delete-slug', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-planned-delete-slug',
      repoPath,
      strategy: 'markdown',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const rows = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-planned-delete-slug'],
    );
    const bookmark = rows[0].last_commit;
    expect(await engine.getPage('canonical-disk', {
      sourceId: 'paired-planned-delete-slug',
    })).not.toBeNull();

    rmSync(join(repoPath, '💾.md'));
    execSync('git add -A && git commit -m "delete fallback slug page"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    const paired = {
      sourceId: 'paired-planned-delete-slug',
      repoPath,
      strategy: 'markdown' as const,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    };
    const previewResult = await performSync(engine, {
      ...paired,
      dryRun: true,
    });
    const preview = buildGBrainSyncEnvelope(previewResult, paired);
    expect(preview.affected.sample).toEqual([
      {
        operation: 'delete',
        path: '💾.md',
        slug: 'canonical-disk',
      },
    ]);

    const originalResolveSlugsByPaths =
      engine.resolveSlugsByPaths.bind(engine);
    let resolverCalls = 0;
    engine.resolveSlugsByPaths = async () => {
      resolverCalls++;
      throw new Error('planned delete must not re-resolve');
    };
    let applied;
    try {
      applied = await performSync(engine, paired);
    } finally {
      engine.resolveSlugsByPaths = originalResolveSlugsByPaths;
    }

    expect(applied.status).toBe('synced');
    expect(resolverCalls).toBe(0);
    expect(await engine.getPage('canonical-disk', {
      sourceId: 'paired-planned-delete-slug',
    })).toBeNull();
    const after = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-planned-delete-slug'],
    );
    expect(after[0].last_commit).toBe(target);
  });

  test('fallback frontmatter slug changes refuse preview and apply without advancing', async () => {
    const {
      performSync,
      SyncPreconditionError,
    } = await import('../src/commands/sync.ts');
    writeFileSync(
      join(repoPath, '💾.md'),
      ['---', 'type: concept', 'title: Disk', 'slug: disk', '---', '', 'Saved.'].join('\n'),
    );
    execSync('git add -A && git commit -m "add stable fallback slug"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-fallback-change', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-fallback-change',
      repoPath,
      strategy: 'markdown',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const before = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-fallback-change'],
    );
    const bookmark = before[0].last_commit;
    writeFileSync(
      join(repoPath, '💾.md'),
      ['---', 'type: concept', 'title: Drive', 'slug: drive', '---', '', 'Changed.'].join('\n'),
    );
    execSync('git add -A && git commit -m "change fallback slug"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    const paired = {
      sourceId: 'paired-fallback-change',
      repoPath,
      strategy: 'markdown' as const,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    };

    for (const dryRun of [true, false]) {
      try {
        await performSync(engine, { ...paired, dryRun });
        throw new Error('expected fallback slug change refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(SyncPreconditionError);
        expect(error).toMatchObject({ reasonCode: 'plan_failed' });
      }
    }

    const after = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-fallback-change'],
    );
    expect(after[0].last_commit).toBe(bookmark);
    expect(await engine.getPage('disk', {
      sourceId: 'paired-fallback-change',
    })).not.toBeNull();
    expect(await engine.getPage('drive', {
      sourceId: 'paired-fallback-change',
    })).toBeNull();
  });

  test('ephemeral-only markdown edits are omitted from immutable mutation evidence', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-ephemeral', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-ephemeral',
      repoPath,
      strategy: 'markdown',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const rows = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-ephemeral'],
    );
    const bookmark = rows[0].last_commit;
    writeFileSync(join(repoPath, 'people/alice.md'), [
      '---',
      'type: person',
      'title: Alice',
      'captured_at: 2026-07-28T12:00:00Z',
      '---',
      '',
      'Alice is a person.',
    ].join('\n'));
    execSync('git add -A && git commit -m "refresh ephemeral capture time"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    const preview = await performSync(engine, {
      sourceId: 'paired-ephemeral',
      repoPath,
      strategy: 'markdown',
      dryRun: true,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    });

    expect(preview.modified).toBe(0);
    expect(preview.affected?.total).toBe(0);
  });

  test('slug-equivalent rename persists the destination source_path', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    writeFileSync(
      join(repoPath, 'note!.md'),
      ['---', 'type: concept', 'title: Note', '---', '', 'Same content.'].join('\n'),
    );
    execSync('git add -A && git commit -m "add punctuation note"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-same-slug-rename', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-same-slug-rename',
      repoPath,
      strategy: 'markdown',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const before = await engine.executeRaw<{
      last_commit: string;
    }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-same-slug-rename'],
    );
    const bookmark = before[0].last_commit;
    execSync('git mv "note!.md" note.md && git commit -m "normalize note path"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    const paired = {
      sourceId: 'paired-same-slug-rename',
      repoPath,
      strategy: 'markdown' as const,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    };

    const result = await performSync(engine, paired);
    expect(result.renamed).toBe(1);
    const pages = await engine.executeRaw<{ source_path: string | null }>(
      `SELECT source_path FROM pages WHERE source_id = $1 AND slug = 'note'`,
      ['paired-same-slug-rename'],
    );
    expect(pages).toEqual([{ source_path: 'note.md' }]);
  });

  test('fallback-slug rename persists the planned destination source_path', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    writeFileSync(
      join(repoPath, '💽.md'),
      ['---', 'type: concept', 'title: Disk', 'slug: disk', '---', '', 'Same content.'].join('\n'),
    );
    execSync('git add -A && git commit -m "add fallback rename source"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-fallback-rename', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-fallback-rename',
      repoPath,
      strategy: 'markdown',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const before = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-fallback-rename'],
    );
    const bookmark = before[0].last_commit;
    execSync('git mv "💽.md" "💾.md" && git commit -m "rename fallback path"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    const paired = {
      sourceId: 'paired-fallback-rename',
      repoPath,
      strategy: 'markdown' as const,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    };
    const incremental = await performSync(engine, {
      ...paired,
      dryRun: true,
    });
    const full = await performSync(engine, {
      ...paired,
      dryRun: true,
      full: true,
    });
    expect(full.affected).toEqual(incremental.affected);
    expect(full.affectedDigest).toBe(incremental.affectedDigest);

    const result = await performSync(engine, {
      ...paired,
      full: true,
    });

    expect(result.affected?.sample).toEqual([
      {
        operation: 'rename',
        path: '💾.md',
        slug: 'disk',
        from_path: '💽.md',
      },
    ]);
    const pages = await engine.executeRaw<{ slug: string; source_path: string | null }>(
      `SELECT slug, source_path FROM pages WHERE source_id = $1`,
      ['paired-fallback-rename'],
    );
    expect(pages).toContainEqual({ slug: 'disk', source_path: '💾.md' });
  });

  test('cross-kind renames update code corpus before/after counts', async () => {
    const {
      buildGBrainSyncEnvelope,
      performSync,
    } = await import('../src/commands/sync.ts');
    mkdirSync(join(repoPath, 'src'), { recursive: true });
    writeFileSync(join(repoPath, 'src/original.ts'), 'export const original = true;\n');
    execSync('git add -A && git commit -m "add initial code page"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ($1, $1, $2, '{}'::jsonb)`,
      ['paired-cross-kind', repoPath],
    );
    await performSync(engine, {
      sourceId: 'paired-cross-kind',
      repoPath,
      strategy: 'auto',
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    const rows = await engine.executeRaw<{ last_commit: string }>(
      `SELECT last_commit FROM sources WHERE id = $1`,
      ['paired-cross-kind'],
    );
    const bookmark = rows[0].last_commit;
    execSync('git mv people/alice.md src/alice.ts', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    execSync('git mv src/original.ts people/original.md', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    execSync('git commit -m "swap markdown and code kinds"', {
      cwd: repoPath,
      stdio: 'pipe',
    });
    const target = execSync('git rev-parse HEAD', {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    const paired = {
      sourceId: 'paired-cross-kind',
      repoPath,
      strategy: 'auto' as const,
      dryRun: true,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      expectedTarget: target,
      expectedBookmark: bookmark,
      requireClean: true,
    };

    const result = await performSync(engine, paired);
    const envelope = buildGBrainSyncEnvelope(result, paired);
    expect(envelope.corpus.code_pages_before).toBe(1);
    expect(envelope.corpus.code_pages_after).toBe(1);
    expect(envelope.corpus.code_deletions_applied).toBe(0);
    expect(envelope.operations.renamed).toBe(2);
    expect(result.planCorpus?.codeDeletions).toBe(1);
  });

  test('full-sync (--full) dry-run does NOT write to DB or advance the bookmark', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    // Seed the bookmark so we hit the full-sync-with-bookmark path when --full is set.
    await performSync(engine, { repoPath, noPull: true, noEmbed: true });
    // Clear DB so we can observe that a --full dry-run doesn't re-import.
    await (engine as any).db.exec(`DELETE FROM content_chunks; DELETE FROM pages;`);
    const bookmarkBefore = await engine.getConfig('sync.last_commit');
    expect(bookmarkBefore).not.toBeNull();

    const result = await performSync(engine, {
      repoPath,
      full: true,        // force full-sync path
      dryRun: true,
      noPull: true,
      noEmbed: true,
    });

    expect(result.status).toBe('dry_run');
    expect(result.added).toBe(2); // alice + bob would be imported
    expect(result.chunksCreated).toBe(0);

    // DB empty — full-sync dry-run did not reimport.
    expect(await engine.getPage('people/alice')).toBeNull();
    expect(await engine.getPage('people/bob')).toBeNull();

    // Bookmark unchanged.
    const bookmarkAfter = await engine.getConfig('sync.last_commit');
    expect(bookmarkAfter).toBe(bookmarkBefore);
  });

  test('SyncResult exposes embedded count field', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const result = await performSync(engine, {
      repoPath,
      dryRun: true,
      noPull: true,
      noEmbed: true,
    });
    // Structural assertion: the contract includes `embedded: number`.
    expect(typeof result.embedded).toBe('number');
  });

  test('--include-gitignored imports ignored files even when git HEAD is unchanged', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const first = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(first.status).toBe('first_sync');

    writeFileSync(join(repoPath, '.gitignore'), 'Meetings/\n');
    execSync('git add .gitignore && git commit -m "ignore generated meetings"', { cwd: repoPath, stdio: 'pipe' });
    const checkpoint = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(checkpoint.status).toBe('up_to_date');

    mkdirSync(join(repoPath, 'Meetings'), { recursive: true });
    writeFileSync(join(repoPath, 'Meetings/weekly.md'), [
      '---',
      'type: meeting',
      'title: Weekly',
      '---',
      '',
      'Generated meeting notes.',
    ].join('\n'));

    const withoutFlag = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(withoutFlag.status).toBe('up_to_date');
    expect(await engine.getPage('meetings/weekly')).toBeNull();

    const withFlag = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
      includeGitignored: true,
    });
    expect(withFlag.added).toBe(1);

    const page = await engine.getPage('meetings/weekly');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Weekly');
  });

  test('detached HEAD skips git pull and ingests local working-tree files', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const seeded = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(seeded.status).toBe('first_sync');

    execSync('git checkout --detach HEAD', { cwd: repoPath, stdio: 'pipe' });
    writeFileSync(join(repoPath, 'people/detached-local.md'), [
      '---',
      'type: person',
      'title: Detached Local',
      '---',
      '',
      'This file exists only in the detached working tree.',
    ].join('\n'));

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };

    try {
      const result = await performSync(engine, {
        repoPath,
        noEmbed: true,
        noExtract: true,
      });

      expect(result.status).toBe('synced');
      expect(result.added).toBe(1);
      expect(result.pagesAffected).toContain('people/detached-local');
    } finally {
      console.error = originalError;
    }

    expect(errors.join('\n')).toContain(`Detached HEAD on ${repoPath}; skipping git pull. Syncing from local working tree.`);
    expect(errors.join('\n')).not.toContain('git pull failed');

    const page = await engine.getPage('people/detached-local');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Detached Local');
  });

  test('detached HEAD with --no-pull also ingests local working-tree files', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const seeded = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });
    expect(seeded.status).toBe('first_sync');

    execSync('git checkout --detach HEAD', { cwd: repoPath, stdio: 'pipe' });
    writeFileSync(join(repoPath, 'people/detached-nopull.md'), [
      '---',
      'type: person',
      'title: Detached NoPull',
      '---',
      '',
      'Only in detached working tree, --no-pull caller.',
    ].join('\n'));

    const result = await performSync(engine, {
      repoPath,
      noPull: true,
      noEmbed: true,
      noExtract: true,
    });

    expect(result.status).toBe('synced');
    expect(result.added).toBe(1);
    expect(result.pagesAffected).toContain('people/detached-nopull');

    const page = await engine.getPage('people/detached-nopull');
    expect(page).not.toBeNull();
    expect(page!.title).toBe('Detached NoPull');
  });
});

describe('sync regression — #132 nested transaction deadlock', () => {
  test('src/commands/sync.ts does not wrap the add/modify loop in engine.transaction()', async () => {
    const source = await Bun.file(new URL('../src/commands/sync.ts', import.meta.url)).text();
    // Accept either of the historical loop shapes: the original inline
    // `for (const path of [...filtered.added, ...filtered.modified])` or
    // the v0.15.2 progress-wrapped variant where the list is hoisted into
    // a local `addsAndMods` variable first.
    const inlineIdx = source.indexOf('for (const path of [...filtered.added, ...filtered.modified]');
    const hoistedIdx = source.indexOf('const addsAndMods = [...filtered.added, ...filtered.modified]');
    const loopStart = inlineIdx !== -1 ? inlineIdx : hoistedIdx;
    expect(loopStart).toBeGreaterThan(-1);
    const prelude = source.slice(0, loopStart);
    const lastTxIdx = prelude.lastIndexOf('engine.transaction');
    if (lastTxIdx !== -1) {
      const lineStart = prelude.lastIndexOf('\n', lastTxIdx) + 1;
      const line = prelude.slice(lineStart, prelude.indexOf('\n', lastTxIdx));
      expect(line.trim().startsWith('//')).toBe(true);
    }
  });
});

describe('resolveSlugByPathOrSourcePath (CJK wave v0.32.7, codex F4)', () => {
  let pgEngine: PGLiteEngine;

  beforeAll(async () => {
    pgEngine = new PGLiteEngine();
    await pgEngine.connect({});
    await pgEngine.initSchema();
  });

  afterAll(async () => {
    await pgEngine.disconnect();
  });

  beforeEach(async () => {
    await (pgEngine as any).db.exec('DELETE FROM content_chunks');
    await (pgEngine as any).db.exec('DELETE FROM pages');
  });

  test('returns stored slug when source_path matches a row', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    // Seed a frontmatter-fallback page: slug doesn't derive from path (emoji)
    await pgEngine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, page_kind, source_path)
       VALUES ('projects/launch', 'project', 'Launch', 'body', 'markdown', '🚀.md')`,
    );
    const slug = await resolveSlugByPathOrSourcePath(pgEngine, '🚀.md');
    expect(slug).toBe('projects/launch');
  });

  test('falls back to resolveSlugForPath when no source_path matches', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    // No row seeded — fallback returns the path-derived slug.
    const slug = await resolveSlugByPathOrSourcePath(pgEngine, 'concepts/hello-world.md');
    expect(slug).toBe('concepts/hello-world');
  });

  test('scoped by source_id when provided', async () => {
    const { resolveSlugByPathOrSourcePath } = await import('../src/commands/sync.ts');
    // Same source_path under TWO sources — without source_id scope we'd
    // get either at random. With source_id we get the right one.
    await pgEngine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('source-a', 'A') ON CONFLICT DO NOTHING`,
    );
    await pgEngine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('source-b', 'B') ON CONFLICT DO NOTHING`,
    );
    await pgEngine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, source_path)
       VALUES ('source-a', 'slug-a/page', 'note', 'A', 'a', 'markdown', '🚀.md')`,
    );
    await pgEngine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, page_kind, source_path)
       VALUES ('source-b', 'slug-b/page', 'note', 'B', 'b', 'markdown', '🚀.md')`,
    );
    expect(await resolveSlugByPathOrSourcePath(pgEngine, '🚀.md', 'source-a')).toBe('slug-a/page');
    expect(await resolveSlugByPathOrSourcePath(pgEngine, '🚀.md', 'source-b')).toBe('slug-b/page');
  });
});

describe('git() helper invocation order (CJK wave v0.32.7)', () => {
  // The git CLI requires `-c key=val` to appear BEFORE the subcommand,
  // and `-C path` BEFORE the subcommand too. Pin the emit order so a future
  // refactor can't silently put `-c` after the subcommand and break CJK
  // path emission.

  test('core.quotepath=false is always emitted first', () => {
    const argv = buildGitInvocation('/repo', ['diff', '--name-status']);
    expect(argv).toEqual([
      '-c', 'core.quotepath=false',
      '-C', '/repo',
      'diff', '--name-status',
    ]);
  });

  test('extra configs append AFTER quotepath, BEFORE -C and subcommand', () => {
    const argv = buildGitInvocation('/repo', ['diff'], ['foo=bar', 'baz=qux']);
    expect(argv).toEqual([
      '-c', 'core.quotepath=false',
      '-c', 'foo=bar',
      '-c', 'baz=qux',
      '-C', '/repo',
      'diff',
    ]);
  });

  test('empty args produces a valid invocation', () => {
    const argv = buildGitInvocation('/repo', []);
    expect(argv).toEqual([
      '-c', 'core.quotepath=false',
      '-C', '/repo',
    ]);
  });
});

describe('sync auto-embed arguments', () => {
  test('scopes incremental source sync embedding to the same source', () => {
    expect(buildAutoEmbedArgs(['hello-js'], 'source-a')).toEqual([
      '--source',
      'source-a',
      '--slugs',
      'hello-js',
    ]);
  });

  test('keeps default-source sync embed arguments unchanged', () => {
    expect(buildAutoEmbedArgs(['people/alice'])).toEqual(['--slugs', 'people/alice']);
  });
});

// #1970: sync silently full-walks forever when last_commit is unreachable.
// The bookmark can point at a commit orphaned by a history rewrite (force-push,
// master→main consolidation, squash). The old guard sent BOTH "object missing"
// AND "not an ancestor" to a blind full re-walk that never advanced the bookmark.
// The fix: only a truly-absent object forces a full reconcile; a present-but-
// non-ancestor bookmark is diffed tree-to-tree directly (`git diff A..B` needs
// no ancestry). Plus F-A (full-sync delete reconcile), F-B (oversized-diff
// fallback), F-C (rename-to-unsyncable deletes the old page).
describe('#1970: unreachable last_commit bookmark recovery', () => {
  let engine: PGLiteEngine;
  const repos: string[] = [];

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  afterEach(() => {
    while (repos.length) {
      const d = repos.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function personMd(title: string, body: string): string {
    return ['---', 'type: person', `title: ${title}`, '---', '', body].join('\n');
  }

  /** Create a temp git repo seeded with the given files + an initial commit. */
  function mkRepo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-1970-'));
    repos.push(dir);
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
    return dir;
  }

  const SYNC_OPTS = { noPull: true, noEmbed: true, noExtract: true, sourceId: 'default' } as const;

  async function bookmark(): Promise<string | null> {
    const rows = await engine.executeRaw<{ last_commit: string | null }>(
      `SELECT last_commit FROM sources WHERE id = 'default'`,
    );
    return rows[0]?.last_commit ?? null;
  }

  async function captureLog<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      const result = await fn();
      return { result, out: lines.join('\n') };
    } finally {
      console.log = origLog;
    }
  }

  test('orphan-present (not an ancestor): diffs tree-to-tree, imports only the delta, advances bookmark', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'people/alice.md': personMd('Alice', 'Alice is a person.'),
      'people/bob.md': personMd('Bob', 'Bob is a person.'),
    });

    const first = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(first.status).toBe('first_sync');
    const orphan = await bookmark();
    expect(orphan).not.toBeNull();

    // Rewrite history: amend the only commit (adds delta.md). The previous tip
    // is now orphaned but still on disk — cat-file succeeds, is-ancestor fails.
    writeFileSync(join(repo, 'people/carol.md'), personMd('Carol', 'Carol joins.'));
    execSync('git add -A && git commit --amend -m "amended with carol"', { cwd: repo, stdio: 'pipe' });

    // Sanity: the stored bookmark is present but no longer an ancestor of HEAD.
    expect(execSync(`git cat-file -t ${orphan}`, { cwd: repo }).toString().trim()).toBe('commit');
    let isAncestor = true;
    try { execSync(`git merge-base --is-ancestor ${orphan} HEAD`, { cwd: repo, stdio: 'pipe' }); }
    catch { isAncestor = false; }
    expect(isAncestor).toBe(false);

    const { result, out } = await captureLog(() => performSync(engine, { repoPath: repo, ...SYNC_OPTS }));

    // Incremental diff path (status 'synced'), NOT a full re-walk ('first_sync').
    expect(result.status).toBe('synced');
    expect(result.added).toBe(1);
    expect(out).toContain('not an ancestor of HEAD');
    expect(await engine.getPage('people/carol')).not.toBeNull();
    // Bookmark advanced off the orphan onto the rewritten HEAD.
    const advanced = await bookmark();
    expect(advanced).not.toBe(orphan);
    expect(advanced).toBe(execSync('git rev-parse HEAD', { cwd: repo }).toString().trim());
  });

  test('orphan-absent (object gc\'d): falls back to a full reconcile', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alice.md': personMd('Alice', 'Alice is a person.') });

    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    // Simulate an orphaned-AND-pruned bookmark: a valid-shaped SHA with no object.
    await engine.executeRaw(
      `UPDATE sources SET last_commit = $1 WHERE id = 'default'`,
      ['deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
    );
    writeFileSync(join(repo, 'people/bob.md'), personMd('Bob', 'Bob is a person.'));
    execSync('git add -A && git commit -m "add bob"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    // Object absent → authoritative full reconcile.
    expect(result.status).toBe('first_sync');
    expect(await engine.getPage('people/bob')).not.toBeNull();
    expect(await engine.getPage('people/alice')).not.toBeNull();
  });

  test('divergence: a file present in the orphan tree but dropped from HEAD is deleted', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'people/alice.md': personMd('Alice', 'Alice is a person.'),
      'people/bob.md': personMd('Bob', 'Bob is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/bob')).not.toBeNull();

    // Rewrite the tip: drop bob, edit alice. Orphans the prior tip (still on disk).
    execSync('git rm people/bob.md', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'people/alice.md'), personMd('Alice', 'Alice was corrected.'));
    execSync('git add -A && git commit --amend -m "drop bob, edit alice"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('people/bob')).toBeNull();          // deleted
    const alice = await engine.getPage('people/alice');
    expect(alice!.compiled_truth).toContain('corrected');           // updated
  });

  test('F-C: a rename whose destination is unsyncable deletes the old page', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(await engine.getPage('people/carol')).not.toBeNull();

    // git mv keeps content identical → classified as a 100% rename (R100).
    // The destination .txt is unsyncable, so without the F-C fix the old page
    // would linger (the rename drops out of both `renamed` and `deleted`).
    execSync('git mv people/carol.md people/carol.txt', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol to txt"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('synced');
    expect(await engine.getPage('people/carol')).toBeNull();
  });

  test('F-A: full reconcile purges stale file-backed pages but spares manual + metafile pages', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'people/alice.md': personMd('Alice', 'Alice is a person.'),
      'people/bob.md': personMd('Bob', 'Bob is a person.'),
    });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // A manually-curated page (put_page) — source_path stays NULL.
    await engine.putPage('manual/note', {
      type: 'note', title: 'Manual Note', compiled_truth: 'Hand-authored, not from a file.',
    }, { sourceId: 'default' });
    // A metafile-backed page (e.g. an older import or direct put_page of log.md).
    // Its source_path is unsyncable, so the reconcile must NOT delete it (#1433).
    await engine.putPage('people/log', {
      type: 'note', title: 'Log', compiled_truth: 'metafile page', source_path: 'people/log.md',
    }, { sourceId: 'default' });

    // Delete bob's backing file, then force a full reconcile.
    execSync('git rm people/bob.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "remove bob"', { cwd: repo, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: repo, full: true, ...SYNC_OPTS });
    expect(result.status).toBe('first_sync');
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    expect(await engine.getPage('people/bob')).toBeNull();          // stale file-backed → purged
    expect(await engine.getPage('people/alice')).not.toBeNull();    // still present → kept
    expect(await engine.getPage('manual/note')).not.toBeNull();     // null source_path → spared
    expect(await engine.getPage('people/log')).not.toBeNull();      // metafile source_path → spared
  });

  test('F-B: an undiffable-but-present bookmark falls back to a full reconcile instead of throwing', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alice.md': personMd('Alice', 'Alice is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // A blob SHA: cat-file -t succeeds ("blob", so objectPresent=true), but
    // `git diff <blob>..HEAD` errors — the same failure shape as an oversized
    // post-rewrite diff hitting git()'s timeout/buffer limits. Must fall back,
    // not throw.
    const blob = execSync('git rev-parse HEAD:people/alice.md', { cwd: repo }).toString().trim();
    await engine.executeRaw(`UPDATE sources SET last_commit = $1 WHERE id = 'default'`, [blob]);

    const result = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(result.status).toBe('first_sync');                       // fell back cleanly
    expect(await engine.getPage('people/alice')).not.toBeNull();
  });

  test('convergence: after orphan recovery, a later commit syncs incrementally to up_to_date', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/alice.md': personMd('Alice', 'Alice is a person.') });
    await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // Orphan + recover.
    writeFileSync(join(repo, 'people/bob.md'), personMd('Bob', 'Bob is a person.'));
    execSync('git add -A && git commit --amend -m "amended with bob"', { cwd: repo, stdio: 'pipe' });
    const recovered = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(recovered.status).toBe('synced');

    // A subsequent ordinary commit now syncs incrementally (bookmark is sane).
    writeFileSync(join(repo, 'people/carol.md'), personMd('Carol', 'Carol joins.'));
    execSync('git add -A && git commit -m "add carol"', { cwd: repo, stdio: 'pipe' });
    const next = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(next.status).toBe('synced');
    expect(next.added).toBe(1);

    // No further changes → up_to_date (converged).
    const settled = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(settled.status).toBe('up_to_date');
  });
});

describe('v0.42.52.0: 0-changes sync bumps last_sync_at heartbeat (D4 invariant preserved)', () => {
  let engine: PGLiteEngine;
  const repos: string[] = [];

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  afterEach(() => {
    while (repos.length) {
      const d = repos.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function personMd(title: string, body: string): string {
    return ['---', 'type: person', `title: ${title}`, '---', '', body].join('\n');
  }

  function mkRepo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-heartbeat-'));
    repos.push(dir);
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), content);
    }
    execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
    return dir;
  }

  const SYNC_OPTS = { noPull: true, noEmbed: true, noExtract: true, sourceId: 'default' } as const;

  async function lastSyncAt(): Promise<string | null> {
    const rows = await engine.executeRaw<{ last_sync_at: string | null }>(
      `SELECT last_sync_at FROM sources WHERE id = 'default'`,
    );
    return rows[0]?.last_sync_at ?? null;
  }

  test('consecutive 0-changes syncs advance last_sync_at without advancing last_commit', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({
      'people/alice.md': personMd('Alice', 'Alice is a person.'),
    });

    const first = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(first.status).toBe('first_sync');
    const afterFirst = await lastSyncAt();
    expect(afterFirst).not.toBeNull();
    const firstRows = await engine.executeRaw<{ last_commit: string | null }>(
      `SELECT last_commit FROM sources WHERE id = 'default'`,
    );
    const lastCommit = firstRows[0]?.last_commit;
    expect(lastCommit).not.toBeNull();

    // Wait 1.1s so the DB clock will tick past `afterFirst`.
    await new Promise((r) => setTimeout(r, 1100));

    const second = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(second.status).toBe('up_to_date');
    const afterSecond = await lastSyncAt();
    expect(afterSecond).not.toBeNull();
    expect(afterSecond).not.toEqual(afterFirst); // heartbeat bumped

    // D4 invariant: last_commit is unchanged on 0-changes sync.
    const lastCommitRows = await engine.executeRaw<{ last_commit: string | null }>(
      `SELECT last_commit FROM sources WHERE id = 'default'`,
    );
    expect(lastCommitRows[0]?.last_commit).toEqual(lastCommit);
  });
});
