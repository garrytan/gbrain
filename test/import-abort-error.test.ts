/**
 * W0 fix-wave (Tier-1 #5) — runImport must THROW a typed ImportAbortError on
 * preflight/argv failures, never process.exit(1).
 *
 * runImport is invoked in-process by the sync_brain MCP op (performFullSync),
 * the autopilot daemon, and the minion sync handler. Pre-fix, a first sync
 * against a brain with unusable embedding credentials TERMINATED the calling
 * process — the stdio MCP server just vanished mid-tool-call. The CLI dispatch
 * site maps the typed error back to exit(1), keeping CLI behavior identical.
 */

import { test, expect, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImport, ImportAbortError } from '../src/commands/import.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// The abort sites fire before any WRITE; the preamble runs a couple of
// read-only lookups (sources, config), so the stub answers those with
// empty sets.
const engineStub = {
  kind: 'pglite',
  executeRaw: async () => [],
  getConfig: async () => null,
} as unknown as BrainEngine;

// cli.ts exits on any ImportAbortError without printing, so every abort must
// write its reason to stderr first.
async function expectAbort(
  args: string[],
  reasonFragment: string,
  stderrFragments: string[] = [],
  engine: BrainEngine = engineStub,
): Promise<ImportAbortError> {
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  let thrown: unknown;
  let printed = '';
  try {
    await runImport(engine, args);
  } catch (e) {
    thrown = e;
  } finally {
    printed = stderr.mock.calls.map(call => call.join(' ')).join('\n');
    stderr.mockRestore();
  }
  expect(thrown).toBeInstanceOf(ImportAbortError);
  const err = thrown as ImportAbortError;
  expect(err.exitCode).toBe(1);
  expect(err.alreadyReported).toBe(true);
  expect(err.message).toContain(reasonFragment);
  expect(printed).not.toBe('');
  for (const fragment of stderrFragments) expect(printed).toContain(fragment);
  return err;
}

test('missing dir arg → typed abort, not process death', async () => {
  await expectAbort(['--no-embed'], 'no import directory');
});

test('invalid --workers → typed abort', async () => {
  await expectAbort(['--no-embed', '--workers', '0', '/tmp'], 'invalid --workers');
});

test('unreadable import target → typed abort', async () => {
  await expectAbort(['--no-embed', '/definitely/not/a/real/dir-w0-test'], 'not readable');
});

// Sites that refuse a real directory: each case builds its fixture under a
// canonical temp root and names what the user must see on stderr.
const answering = (match: string, rows: unknown[] | Error): BrainEngine => ({
  ...engineStub,
  executeRaw: async (sql: string) => {
    if (!sql.includes(match)) return [];
    if (rows instanceof Error) throw rows;
    return rows;
  },
}) as unknown as BrainEngine;

const directoryCases: Array<{
  name: string;
  setup: (root: string) => string;
  engine?: BrainEngine;
  reason: string;
  stderr: (root: string) => string[];
  cause?: string;
}> = [
  {
    name: 'lock admission refused by a managed-worktree marker (#5487)',
    setup: root => {
      writeFileSync(join(root, '.gbrain-managed'), '');
      return join(root, 'notes');
    },
    reason: 'writer_coordinator_required',
    stderr: root => [
      'source filesystem lock admission failed.',
      'Error [writer_coordinator_required]: This path belongs to a managed canonical worktree.',
      'Fix: Submit the change through the persistence coordinator.',
      `Marker: ${join(root, '.gbrain-managed')}`,
    ],
  },
  {
    name: 'lock admission fails on a non-operation error',
    setup: root => join(root, 'notes'),
    engine: answering("local_path <> ''", new Error('synthetic sources lookup failure')),
    reason: 'synthetic sources lookup failure',
    stderr: () => ['Error: synthetic sources lookup failure'],
    cause: 'synthetic sources lookup failure',
  },
  {
    name: 'managed brain refuses a symlinked input root',
    setup: root => {
      symlinkSync(join(root, 'notes'), join(root, 'notes-link'));
      return join(root, 'notes-link');
    },
    engine: answering('FROM persistence_brain', [{ enabled: true }]),
    reason: 'symlinked input root',
    stderr: () => ['symlinked input root', 'notes-link'],
  },
];

for (const c of directoryCases) {
  test(`${c.name} → typed abort that prints the reason`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'import-abort-')));
    try {
      mkdirSync(join(root, 'notes'));
      writeFileSync(join(root, 'notes', 'alpha-example.md'), '# Alpha example\n');
      const err = await expectAbort(['--no-embed', c.setup(root)], c.reason, c.stderr(root), c.engine);
      if (c.cause) expect((err.cause as Error).message).toBe(c.cause);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('the calling process survives the abort (the actual Tier-1 bug)', async () => {
  // Trivially true if we got here after the aborts above, but assert it
  // explicitly: the process is alive and can keep dispatching.
  expect(process.pid).toBeGreaterThan(0);
});
