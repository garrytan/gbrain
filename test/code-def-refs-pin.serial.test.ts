/**
 * #4747 — code-def / code-refs CLI source resolution.
 *
 * The sibling of test/code-callers-pin.serial.test.ts, for the two commands
 * that newly adopted the shared resolver. Serial for the same reason: these
 * drive the real runCodeDef / runCodeRefs through process.cwd()-based
 * resolution, and process.cwd() is process-global.
 *
 * Asserts the CLI surface the library-level tests cannot reach:
 *   - a .gbrain-source pin resolves on a multi-source brain (no exit 2)
 *   - no pin + no flag + multi-source still errors (exit 2)
 *   - explicit --source overrides the pin
 *   - the JSON envelope carries source_id + scope; --all-sources → null/'all'
 *   - --source with --all-sources is a usage error, not a silent precedence win
 *   - an unregistered --source errors instead of returning an empty result
 *   - a flag-shaped --source value errors instead of becoming the source id
 *   - a value flag's argument is not consumed as the positional symbol
 *   - a zero-result implicit scope names the source and suggests --all-sources
 *   - an implicitly-resolved code-less source widens instead of answering zero
 *
 * PGLite in-memory, no DATABASE_URL.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { runCodeDef } from '../src/commands/code-def.ts';
import { runCodeRefs } from '../src/commands/code-refs.ts';

let engine: PGLiteEngine;
let origCwd: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  origCwd = process.cwd();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterEach(() => {
  process.chdir(origCwd);
});

async function addSource(id: string, localPath: string | null): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ($1, $1, $2, '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
    [id, localPath],
  );
}

function pinnedDir(sourceId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-defrefs-pin-'));
  writeFileSync(join(dir, '.gbrain-source'), `${sourceId}\n`);
  return dir;
}

/** Run fn with process.exit + console.log/error spied. */
async function capture(fn: () => Promise<void>): Promise<{ logs: string[]; errs: string[]; exitCode: number | null }> {
  const logs: string[] = [];
  const errs: string[] = [];
  let exitCode: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
  const errSpy = spyOn(console, 'error').mockImplementation((m?: unknown) => { errs.push(String(m)); });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error('EXIT');
  }) as never);
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error) || e.message !== 'EXIT') throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs, errs, exitCode };
}

function envelope(logs: string[]): Record<string, unknown> {
  return JSON.parse(logs.join('\n')) as Record<string, unknown>;
}

const COMMANDS: Array<[string, (e: PGLiteEngine, a: string[]) => Promise<void>]> = [
  ['code-def', runCodeDef],
  ['code-refs', runCodeRefs],
];

describe('code-def / code-refs — CLI source resolution (#4747)', () => {
  for (const [name, run] of COMMANDS) {
    test(`${name}: pin resolves on a multi-source brain, envelope names it`, async () => {
      await addSource('repo-a', '/fake/a');
      await addSource('repo-b', '/fake/b');
      const dir = pinnedDir('repo-a');
      process.chdir(dir);
      try {
        const { logs, exitCode } = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
          capture(() => run(engine, ['someSym', '--json'])));
        expect(exitCode).toBeNull();
        const env = envelope(logs);
        expect(env.source_id).toBe('repo-a');
        expect(env.scope).toBe('single');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${name}: no pin + no flag + multi-source → exit 2`, async () => {
      await addSource('repo-a', '/fake/a');
      await addSource('repo-b', '/fake/b');
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-defrefs-nopin-'));
      process.chdir(dir);
      try {
        const { errs, exitCode } = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
          capture(() => run(engine, ['someSym', '--no-json'])));
        expect(exitCode).toBe(2);
        expect(errs.join('\n')).toContain('--source');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${name}: explicit --source overrides a conflicting pin`, async () => {
      await addSource('repo-a', '/fake/a');
      await addSource('repo-b', '/fake/b');
      const dir = pinnedDir('repo-a');
      process.chdir(dir);
      try {
        const { logs, exitCode } = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
          capture(() => run(engine, ['someSym', '--source', 'repo-b', '--json'])));
        expect(exitCode).toBeNull();
        expect(envelope(logs).source_id).toBe('repo-b');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${name}: the --source=<id> inline spelling scopes the lookup (review fix)`, async () => {
      // Exact-token parseFlag silently ignored '--source=repo-b', so a user
      // who explicitly named a source got the pin's scope instead — a
      // wrong-scope answer with no error.
      await addSource('repo-a', '/fake/a');
      await addSource('repo-b', '/fake/b');
      const dir = pinnedDir('repo-a');
      process.chdir(dir);
      try {
        const { logs, exitCode } = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
          capture(() => run(engine, ['someSym', '--source=repo-b', '--json'])));
        expect(exitCode).toBeNull();
        expect(envelope(logs).source_id).toBe('repo-b');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${name}: --all-sources reports source_id null and scope all`, async () => {
      await addSource('repo-a', '/fake/a');
      await addSource('repo-b', '/fake/b');
      const { logs, exitCode } = await capture(() => run(engine, ['someSym', '--all-sources', '--json']));
      expect(exitCode).toBeNull();
      const env = envelope(logs);
      expect(env.source_id).toBeNull();
      expect(env.scope).toBe('all');
    });

    test(`${name}: --source together with --all-sources is a usage error`, async () => {
      await addSource('repo-a', '/fake/a');
      const { logs, exitCode } = await capture(() =>
        run(engine, ['someSym', '--source', 'repo-a', '--all-sources', '--json']));
      expect(exitCode).toBe(2);
      expect((envelope(logs).error as Record<string, unknown>).code).toBe('conflicting_source_scope');
    });

    test(`${name}: an unregistered --source errors instead of returning empty`, async () => {
      await addSource('repo-a', '/fake/a');
      const { logs, exitCode } = await capture(() =>
        run(engine, ['someSym', '--source', 'repo-typo', '--json']));
      expect(exitCode).toBe(2);
      expect((envelope(logs).error as Record<string, unknown>).code).toBe('unknown_source');
    });

    test(`${name}: a flag-shaped --source value errors instead of becoming the id`, async () => {
      await addSource('repo-a', '/fake/a');
      const { logs, exitCode } = await capture(() => run(engine, ['someSym', '--source', '--json']));
      expect(exitCode).toBe(2);
      expect((envelope(logs).error as Record<string, unknown>).code).toBe('missing_source_value');
    });

    test(`${name}: a value flag's argument is not taken as the symbol`, async () => {
      await addSource('repo-a', '/fake/a');
      await addSource('repo-b', '/fake/b');
      const { logs, exitCode } = await capture(() =>
        run(engine, ['--source', 'repo-b', 'mySymbol', '--json']));
      expect(exitCode).toBeNull();
      const env = envelope(logs);
      expect(env.symbol).toBe('mySymbol');
      expect(env.source_id).toBe('repo-b');
    });

    test(`${name}: a zero-result implicit scope names the source and suggests --all-sources`, async () => {
      await addSource('repo-a', '/fake/a');
      await addSource('repo-b', '/fake/b');
      const dir = pinnedDir('repo-a');
      process.chdir(dir);
      try {
        const { logs } = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
          capture(() => run(engine, ['nothingMatchesThis', '--no-json'])));
        const out = logs.join('\n');
        expect(out).toContain("repo-a");
        expect(out).toContain('--all-sources');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test(`${name}: an implicitly-resolved code-less source widens instead of answering zero`, async () => {
      // The vault+code shape: the pinned source carries no code, a sibling does.
      await addSource('vault', '/fake/vault');
      await addSource('code-src', '/fake/code');
      await importCodeFile(engine, 'src/widen.ts', `export function widenTarget(seed: number): number {
  const scaled = seed * 5 + 11;
  console.log('widen target computing', scaled);
  if (scaled > 5_000) throw new Error('widenTarget overflow');
  return scaled;
}
`, { noEmbed: true, sourceId: 'code-src' });

      const dir = pinnedDir('vault');
      process.chdir(dir);
      try {
        const { logs, errs, exitCode } = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
          capture(() => run(engine, ['widenTarget', '--json'])));
        expect(exitCode).toBeNull();
        const env = envelope(logs);
        expect(env.scope).toBe('all');
        expect(env.source_id).toBeNull();
        expect(Number(env.count)).toBeGreaterThan(0);
        // The widening is announced, not silent.
        expect(errs.join('\n')).toContain('holds no code');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
