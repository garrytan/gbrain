/**
 * Persistent per-source sync strategy CLI and PGLite contract.
 *
 * Covers add-time storage, atomic set/unset semantics, stable list JSON, and
 * loud validation/not-found exits. The execution-time precedence contract is
 * exercised separately by sync-source-strategy.serial.test.ts.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSources } from '../src/commands/sources.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let repoPath: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-source-strategy-'));
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), '# Strategy fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'fixture'], {
    cwd: repoPath,
    stdio: 'pipe',
  });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(repoPath, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function captureSources(args: string[]): Promise<{
  logs: string[];
  errs: string[];
  exit: number | null;
}> {
  const logs: string[] = [];
  const errs: string[] = [];
  let exit: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation(
    (...values: unknown[]) => {
      logs.push(values.join(' '));
    },
  );
  const errSpy = spyOn(console, 'error').mockImplementation(
    (...values: unknown[]) => {
      errs.push(values.join(' '));
    },
  );
  const exitSpy = spyOn(process, 'exit').mockImplementation(((
    code?: number,
  ) => {
    exit = code ?? 0;
    throw new Error(`EXIT:${code ?? 0}`);
  }) as never);
  try {
    await runSources(engine, args);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('EXIT:'))
      throw error;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs, errs, exit };
}

async function sourceConfig(
  id: string,
): Promise<Record<string, unknown> | null> {
  const rows = await engine.executeRaw<{ config: Record<string, unknown> }>(
    'SELECT config FROM sources WHERE id = $1',
    [id],
  );
  return rows[0]?.config ?? null;
}

describe('sources add --strategy', () => {
  test('stores a validated strategy and reports the effective policy', async () => {
    const { logs, exit } = await captureSources([
      'add',
      'codebase',
      '--path',
      repoPath,
      '--strategy',
      'code',
    ]);
    expect(exit).toBeNull();
    expect(await sourceConfig('codebase')).toEqual({ strategy: 'code' });
    expect(logs.join('\n')).toContain('sync strategy: code (stored)');
  });

  test('rejects an invalid value before writing a source row', async () => {
    const { errs, exit } = await captureSources([
      'add',
      'invalid-policy',
      '--path',
      repoPath,
      '--strategy',
      'all-files',
    ]);
    expect(exit).toBe(2);
    expect(errs.join('\n')).toContain('Valid options: markdown | code | auto');
    expect(await sourceConfig('invalid-policy')).toBeNull();
  });
});

describe('sources set-sync-strategy', () => {
  beforeEach(async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('wiki', 'Wiki', '{"federated":true,"ttl_days":90,"strategy":"auto"}'::jsonb)`,
    );
  });

  test('atomically sets a strategy while preserving unrelated config', async () => {
    const first = await captureSources(['set-sync-strategy', 'wiki', 'code']);
    expect(first.exit).toBeNull();
    expect(first.logs.join('\n')).toContain(
      'existing indexed content was not reprocessed',
    );
    expect(await sourceConfig('wiki')).toEqual({
      federated: true,
      ttl_days: 90,
      strategy: 'code',
    });

    // Idempotent repeat stays successful and leaves the same object shape.
    const second = await captureSources(['set-sync-strategy', 'wiki', 'code']);
    expect(second.exit).toBeNull();
    expect(await sourceConfig('wiki')).toEqual({
      federated: true,
      ttl_days: 90,
      strategy: 'code',
    });
  });

  test('default/unset removes only strategy and restores default provenance', async () => {
    const cleared = await captureSources([
      'set-sync-strategy',
      'wiki',
      'default',
    ]);
    expect(cleared.exit).toBeNull();
    expect(await sourceConfig('wiki')).toEqual({
      federated: true,
      ttl_days: 90,
    });

    const listed = await captureSources(['list', '--json']);
    const envelope = JSON.parse(listed.logs.join('\n')) as {
      schema_version: number;
      sources: Array<Record<string, unknown>>;
    };
    const wiki = envelope.sources.find((source) => source.id === 'wiki');
    expect(envelope.schema_version).toBe(1);
    expect(wiki).toMatchObject({
      sync_strategy: 'markdown',
      sync_strategy_origin: 'default',
    });
  });

  test('set and unset repair a historical string-shaped config without dropping keys', async () => {
    await engine.executeRaw(
      `UPDATE sources
          SET config = $2::jsonb
        WHERE id = $1`,
      [
        'wiki',
        JSON.stringify(JSON.stringify({ federated: true, ttl_days: 90 })),
      ],
    );

    expect((await captureSources([
      'set-sync-strategy',
      'wiki',
      'code',
    ])).exit).toBeNull();
    expect(await sourceConfig('wiki')).toEqual({
      federated: true,
      ttl_days: 90,
      strategy: 'code',
    });

    expect((await captureSources([
      'set-sync-strategy',
      'wiki',
      'unset',
    ])).exit).toBeNull();
    expect(await sourceConfig('wiki')).toEqual({
      federated: true,
      ttl_days: 90,
    });
  });

  test('invalid values and unknown sources fail loudly with stable exit codes', async () => {
    const invalid = await captureSources([
      'set-sync-strategy',
      'wiki',
      'everything',
    ]);
    expect(invalid.exit).toBe(2);
    expect(invalid.errs.join('\n')).toContain(
      'Valid options: markdown | code | auto | default',
    );

    const missing = await captureSources([
      'set-sync-strategy',
      'missing',
      'auto',
    ]);
    expect(missing.exit).toBe(4);
    expect(missing.errs.join('\n')).toContain('gbrain sources list');
  });
});

describe('sources list strategy observability', () => {
  test('human output shows the effective strategy and provenance', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('codebase', 'Codebase', '{"strategy":"code"}'::jsonb)`,
    );
    const { logs, exit } = await captureSources(['list']);
    expect(exit).toBeNull();
    expect(logs.join('\n')).toContain('strategy=code (stored)');
  });

  test('marks invalid stored config as markdown fallback and emits a repair command', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('broken', 'Broken', '{"strategy":"everything"}'::jsonb)`,
    );
    const { logs, errs, exit } = await captureSources(['list', '--json']);
    expect(exit).toBeNull();
    const envelope = JSON.parse(logs.join('\n')) as {
      schema_version: number;
      sources: Array<Record<string, unknown>>;
    };
    expect(envelope.schema_version).toBe(1);
    expect(
      envelope.sources.find((source) => source.id === 'broken'),
    ).toMatchObject({
      sync_strategy: 'markdown',
      sync_strategy_origin: 'invalid_fallback',
    });
    expect(errs.join('\n')).toContain(
      'gbrain sources set-sync-strategy broken markdown',
    );
  });
});
