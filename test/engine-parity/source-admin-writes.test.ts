/**
 * BrainEngine parity — the source admin writes that ran as raw SQL (batch 2 of the repair-on-Rust plan, push 4):
 * `gbrain sources set-cr-mode`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1), `sources set-cr-mode`
 *    stores a source's contextual-retrieval override, clears it with `unset`, leaves the other sources alone, and
 *    exits 4 for an unknown id with nothing written; `getSource` and the engine-migration source read
 *    (`readMigrationRows('sources')`) return the stored override.
 *  - Regression: the command checked the id with `SELECT id FROM sources` and wrote with `UPDATE sources` through
 *    `executeRaw`, which a Rust brain refuses, so the override could not be set there; the Rust store also kept no
 *    override, so `getSource` and a migration off a Rust brain read null.
 *  - Why existing coverage misses it: test/sources-set-cr-mode.test.ts runs on PGLite only and reads the column back
 *    with raw SQL.
 *  - Seam: `process.exit` is stubbed to record the exit code. Real engines otherwise.
 */
import { afterAll, describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runSources } from '../../src/commands/sources.ts';
import { renderCliError } from '../../src/core/agent-output.ts';

const { parityTest } = parityArms(testBackends());

/** Runs `gbrain sources <args>` with output silenced; returns the exit code it asked for, or null. */
async function cli(engine: BrainEngine, args: string[]): Promise<number | null> {
  const exit = process.exit;
  const { log, error } = console;
  let code: number | null = null;
  (process as unknown as { exit: (n: number) => never }).exit = ((n: number) => {
    code = n;
    throw new Error(`exit ${n}`);
  }) as never;
  console.log = () => {};
  console.error = () => {};
  try {
    await runSources(engine, args);
  } catch (e) {
    if (code === null) throw e;
  } finally {
    process.exit = exit;
    console.log = log;
    console.error = error;
  }
  return code;
}

describe('engine parity: source admin writes', () => {
  parityTest('sources set-cr-mode sets, clears and refuses an unknown source; getSource and the migration read see it', {
    methods: ['setSourceContextualMode', 'getSource', 'readMigrationRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'wiki');
    await createSource(engine, backend, 'side');
    const modes = async () => ({
      wiki: (await engine.getSource('wiki'))?.contextual_retrieval_mode ?? null,
      side: (await engine.getSource('side'))?.contextual_retrieval_mode ?? null,
    });
    const migrated = async () => Object.fromEntries((await engine.readMigrationRows('sources'))!.rows
      .map(r => [r.id as string, (r.contextual_retrieval_mode as string | null) ?? null]));
    const steps: Record<string, unknown> = {};
    steps.set = { exit: await cli(engine, ['set-cr-mode', 'wiki', 'per_chunk_synopsis']), modes: await modes(), migrated: await migrated() };
    steps.reset = { exit: await cli(engine, ['set-cr-mode', 'wiki', 'title']), modes: await modes() };
    steps.missing = { exit: await cli(engine, ['set-cr-mode', 'missing', 'none']), found: await engine.getSource('missing') };
    steps.cleared = { exit: await cli(engine, ['set-cr-mode', 'wiki', 'unset']), modes: await modes(), migrated: await migrated() };
    expect(steps).toEqual({
      set: { exit: null, modes: { wiki: 'per_chunk_synopsis', side: null }, migrated: { default: null, side: null, wiki: 'per_chunk_synopsis' } },
      reset: { exit: null, modes: { wiki: 'title', side: null } },
      missing: { exit: 4, found: null },
      cleared: { exit: null, modes: { wiki: null, side: null }, migrated: { default: null, side: null, wiki: null } },
    });
    return steps;
  });
});

/** One Git checkout every arm uses, so the paths the command prints are the same bytes on each arm. */
const ROOT = mkdtempSync(join(tmpdir(), 'gbrain-api-source-add-'));
execFileSync('git', ['init', '-q', join(ROOT, 'repo')]);
const TOKEN_FILE = join(ROOT, 'token.json');
writeFileSync(TOKEN_FILE, '{"accessToken":"not-a-real-token"}\n', { mode: 0o600 });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/**
 * Runs `gbrain sources <args>` the way the CLI does: its stdout and stderr lines, and its exit code (0 when it returns,
 * the code it asked for, or the code and stderr text `renderCliError` gives a thrown error, as cli.ts prints it).
 */
async function cliOutput(engine: BrainEngine, args: string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  const exit = process.exit;
  const { log, error } = console;
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let stdout = '';
  let stderr = '';
  let code: number | null = null;
  (process as unknown as { exit: (n: number) => never }).exit = ((n: number) => {
    code = n;
    throw new Error(`exit ${n}`);
  }) as never;
  console.log = (...a: unknown[]) => { stdout += `${a.join(' ')}\n`; };
  console.error = (...a: unknown[]) => { stderr += `${a.join(' ')}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    await runSources(engine, args);
  } catch (e) {
    if (code === null) {
      const rendered = renderCliError(e, { json: false, command: 'sources', tty: false });
      stderr += rendered.stderr ?? '';
      code = rendered.exitCode;
    }
  } finally {
    process.exit = exit;
    console.log = log;
    console.error = error;
    process.stdout.write = out;
    process.stderr.write = err;
  }
  return { exit: code ?? 0, stdout, stderr };
}

describe('engine parity: sources add for an API-backed kind', () => {
  parityTest('listSourcePathRows lists every source with a local path, archived ones included, and no other', {
    methods: ['listSourcePathRows'],
  }, async (engine, backend) => {
    await createSource(engine, backend, 'ab', {}, '/var/tmp/paths-ab');
    await createSource(engine, backend, 'a-z', {}, '/var/tmp/paths-a-z');
    await createSource(engine, backend, 'loose');
    await archiveSource(engine, backend, 'a-z');
    const rows = (await engine.listSourcePathRows()).map(r => [r.id, r.local_path]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
    expect(rows).toEqual([['a-z', '/var/tmp/paths-a-z'], ['ab', '/var/tmp/paths-ab']]);
    return rows;
  });

  // `sources add --kind apple-contacts` (the meetings and slack kinds share the path) checked a --dir against the other
  // sources' directories with raw SQL, which a Rust brain refuses, so no such source could be registered there.
  parityTest('sources add --kind apple-contacts registers a git and a database record, refuses an overlapping --dir, and lists them', {
    methods: ['listSourcePathRows', 'readTopologyChangeDigest', 'insertSource'],
  }, async (engine) => {
    rmSync(join(ROOT, 'repo', 'contacts'), { recursive: true, force: true });
    const base = ['--kind', 'apple-contacts', '--helper-host', 'mac-example', '--token-file', TOKEN_FILE];
    const git = await cliOutput(engine, ['add', 'contacts-git', ...base, '--record', 'git', '--dir', join(ROOT, 'repo', 'contacts')]);
    const database = await cliOutput(engine, ['add', 'contacts-db', ...base, '--record', 'database']);
    // The overlap check compares real paths, so the nested directory must exist for it to be seen.
    mkdirSync(join(ROOT, 'repo', 'contacts', 'nested'), { recursive: true });
    const overlap = await cliOutput(engine, ['add', 'contacts-nested', ...base, '--record', 'git', '--dir', join(ROOT, 'repo', 'contacts', 'nested')]);
    const steps = { git, database, overlap, list: await cliOutput(engine, ['list', '--json']) };
    const dir = join(ROOT, 'repo', 'contacts');
    expect(steps.git).toEqual({ exit: 0, stderr: '', stdout: `Created apple-contacts source "contacts-git" (record: git) → ${dir}\n  federated: true\n`
      + '  sync: run `gbrain sync --source contacts-git` once; after its first sync, autopilot keeps it synced on its own interval.\n' });
    expect(steps.database.exit).toBe(0);
    expect({ exit: steps.overlap.exit, stdout: steps.overlap.stdout }).toEqual({ exit: 1, stdout: '' });
    // The CLI renders the SourceOpError (code overlapping_path) as internal_error on every engine today.
    expect(steps.overlap.stderr).toStartWith(`Error [internal_error]: ${join(dir, 'nested')} overlaps source "contacts-git" at ${dir}; its pages would be imported by both sources.`);
    expect((JSON.parse(steps.list.stdout) as { sources: Array<{ id: string; local_path: string | null }> }).sources.map(s => [s.id, s.local_path]))
      .toEqual([['default', null], ['contacts-db', null], ['contacts-git', dir]]);
    return steps;
  });
});
