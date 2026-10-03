/**
 * Writers of `sources.config.strategy`. Every sync path reads the key when its
 * caller passes no --strategy (#4899; the reader is pinned by
 * test/sync-index-matches-tree.serial.test.ts), and an unset key means
 * 'markdown', under which a code source deletes its own changed code pages.
 *
 * Protects: `sources add --strategy` persists the key on a new --path source
 * and when attaching a path to an existing path-less row (other config keys
 * survive); `sources set-strategy` writes it as a single-key merge; `sources
 * list --json` reports it; the managed add input and its CLI parser carry it;
 * an unknown strategy, or one on a connector kind, is refused and writes
 * nothing. The --url path and the `sources_add` op are covered in
 * test/sources-mcp.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSources } from '../src/commands/sources.ts';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';
import { managedSourceAddInput } from '../src/core/persistence/managed-sources.ts';
import { addSource } from '../src/core/sources-ops.ts';

let engine: PGLiteEngine;
const repo = mkdtempSync(join(tmpdir(), 'gbrain-sources-strategy-'));

beforeAll(async () => {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'index.ts'), 'export const x = 1;\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'init'], { cwd: repo });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(repo, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Run `gbrain sources <args>`; a process.exit becomes `exit` instead of ending the runner. */
async function cli(args: string[]): Promise<{ exit: number | null; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const original = { log: console.log, error: console.error, exit: process.exit };
  console.log = (...parts: unknown[]) => { out.push(parts.map(String).join(' ')); };
  console.error = (...parts: unknown[]) => { err.push(parts.map(String).join(' ')); };
  let exit: number | null = null;
  (process as unknown as { exit: (code: number) => never }).exit = ((code: number) => {
    exit = code;
    throw new Error(`__exit_${code}__`);
  }) as never;
  try {
    await runSources(engine, args);
  } catch (e) {
    if (exit === null) throw e;
  } finally {
    console.log = original.log;
    console.error = original.error;
    process.exit = original.exit;
  }
  return { exit, out: out.join('\n'), err: err.join('\n') };
}

async function configOf(id: string): Promise<Record<string, unknown> | null> {
  const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id = $1', [id]);
  if (!row) return null;
  return (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as Record<string, unknown>;
}

async function listed(id: string): Promise<Record<string, unknown> | undefined> {
  const { out } = await cli(['list', '--json']);
  return (JSON.parse(out) as { sources: Array<Record<string, unknown>> }).sources.find((s) => s.id === id);
}

describe('sources add --strategy', () => {
  test('persists config.strategy on a new --path source and list --json reports it', async () => {
    const r = await cli(['add', 'code-src', '--path', repo, '--strategy', 'code', '--federated']);
    expect(r.exit).toBeNull();
    expect(await configOf('code-src')).toEqual({ federated: true, strategy: 'code' });
    expect(await listed('code-src')).toMatchObject({ strategy: 'code', federated: true });
  });

  test('without --strategy nothing is persisted and list --json reports null', async () => {
    expect((await cli(['add', 'plain-src', '--path', repo])).exit).toBeNull();
    expect(await configOf('plain-src')).toEqual({});
    expect(await listed('plain-src')).toMatchObject({ strategy: null });
  });

  test('attaching a path to a path-less row merges the strategy and keeps every other key', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('attach-src', 'attach-src', '{"tracked_branch":"main","federated":true}'::jsonb)`,
    );
    expect((await cli(['add', 'attach-src', '--path', repo, '--strategy', 'auto'])).exit).toBeNull();
    expect(await configOf('attach-src')).toEqual({ tracked_branch: 'main', federated: true, strategy: 'auto' });
  });

  test('an unknown strategy exits 2 and registers nothing', async () => {
    const r = await cli(['add', 'bad-src', '--path', repo, '--strategy', 'everything']);
    expect(r.exit).toBe(2);
    expect(r.err).toContain('--strategy must be one of: markdown, code, auto');
    expect(await configOf('bad-src')).toBeNull();
  });

  test('a strategy on a connector kind is refused before anything is created', async () => {
    await expect(addSource(engine, {
      id: 'gh-src', strategy: 'code',
      github: { tokenEnv: 'GH_TOKEN', handle: '', scope: 'auto', repos: [], dir: join(repo, 'gh'), involvement: true },
    })).rejects.toMatchObject({ code: 'invalid_strategy' });
    expect(await configOf('gh-src')).toBeNull();
  });
});

describe('sources set-strategy', () => {
  test('writes config.strategy as a single-key merge over the existing config', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, local_path, config)
       VALUES ('set-src', 'set-src', $1, '{"remote_url":"https://example.com/r.git","federated":false}'::jsonb)`,
      [repo],
    );
    const first = await cli(['set-strategy', 'set-src', 'code']);
    expect(first.exit).toBeNull();
    expect(first.out).toContain('now syncs with strategy code');
    expect(await configOf('set-src')).toEqual({ remote_url: 'https://example.com/r.git', federated: false, strategy: 'code' });
    expect((await cli(['set-strategy', 'set-src', 'markdown'])).exit).toBeNull();
    expect(await configOf('set-src')).toMatchObject({ strategy: 'markdown', remote_url: 'https://example.com/r.git' });
    expect(await listed('set-src')).toMatchObject({ strategy: 'markdown' });
  });

  test('an unknown strategy exits 2, a missing source exits 4, a connector source exits 2; none writes', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('keep-src', 'keep-src', '{}'::jsonb)`);
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('gh-src', 'gh-src', '{"kind":"github"}'::jsonb)`);
    expect((await cli(['set-strategy', 'keep-src', 'everything'])).exit).toBe(2);
    expect((await cli(['set-strategy', 'keep-src'])).exit).toBe(2);
    expect((await cli(['set-strategy', 'no-such-src', 'code'])).exit).toBe(4);
    expect((await cli(['set-strategy', 'gh-src', 'code'])).exit).toBe(2);
    expect(await configOf('keep-src')).toEqual({});
    expect(await configOf('gh-src')).toEqual({ kind: 'github' });
  });
});

describe('managed source add', () => {
  test('the CLI parser and the add input carry the strategy into the source config', () => {
    const parsed = parseSourceLifecycleArgs(['add', 'managed-src', '--path', repo, '--strategy', 'auto']);
    const options = (parsed.params as { options: Parameters<typeof managedSourceAddInput>[0] }).options;
    expect(options.strategy).toBe('auto');
    expect(managedSourceAddInput(options).config).toEqual({ strategy: 'auto' });
  });

  test('an unknown strategy, a connector kind, or another verb is refused', () => {
    expect(() => parseSourceLifecycleArgs(['add', 'managed-src', '--path', repo, '--strategy', 'everything']))
      .toThrow(/Unknown sync strategy/);
    expect(() => parseSourceLifecycleArgs(['add', 'managed-src', '--kind', 'github', '--strategy', 'code']))
      .toThrow(/Git-backed sources/);
    expect(() => parseSourceLifecycleArgs(['archive', 'managed-src', '--strategy', 'code']))
      .toThrow(/does not apply/);
    expect(() => managedSourceAddInput({ id: 'managed-src', localPath: repo, strategy: 'everything' as never }))
      .toThrow(/Unknown sync strategy/);
  });
});
