/**
 * #2830 — the `sync_brain` MCP op must thread ctx.sourceId into performSync,
 * mirroring the D7 pattern already applied to revert_version / put_page.
 *
 * Pre-fix: the handler called performSync with no sourceId, so a call with
 * no explicit `repo` argument (the normal MCP usage) resolved the sync
 * anchor of the DEFAULT source instead of the caller's own source — on a
 * multi-source brain that silently syncs (or reports "up to date" against)
 * the wrong repo's history.
 *
 * Behavioral pin: with a source whose local_path is a committed git repo,
 * calling sync_brain with ctx.sourceId = that source and NO repo param must
 * import that repo's pages into that source. On master the anchor lookup
 * runs against `default` (no local_path) and the sync errors out — zero
 * pages land in the source.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

const SOURCE = 'srcb-2830';

let engine: PGLiteEngine;
let repoPath: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-syncop-'));
  execSync('git init', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: repoPath, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: repoPath, stdio: 'pipe' });
  mkdirSync(join(repoPath, 'topics'), { recursive: true });
  writeFileSync(join(repoPath, 'topics/anchor-check.md'), [
    '---',
    'type: concept',
    'title: Anchor Check',
    '---',
    '',
    'Body long enough to import cleanly for the sync-op source test.',
    '',
  ].join('\n'));
  execSync('git add -A && git commit -m seed', { cwd: repoPath, stdio: 'pipe' });

  await runSources(engine, ['add', SOURCE, '--path', repoPath, '--no-federated']);
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (repoPath) rmSync(repoPath, { recursive: true, force: true });
}, 60_000);

describe('sync_brain op threads ctx.sourceId (#2830)', () => {
  test('no-repo call syncs the caller source own anchor, not default', async () => {
    const op = operationsByName['sync_brain']!;
    const ctx = {
      engine,
      config: {},
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: false,
      sourceId: SOURCE,
    } as unknown as OperationContext;

    // No `repo` param — the anchor must resolve from ctx.sourceId.
    let result: unknown;
    let error: unknown;
    try {
      result = await op.handler(ctx, { no_embed: true, no_pull: true });
    } catch (e) {
      error = e;
    }

    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1`,
      [SOURCE],
    );
    // Pre-fix: performSync resolved the DEFAULT anchor (no local_path) and
    // errored — nothing landed in the source. Post-fix: the repo imports
    // into the caller's source.
    expect({ imported: rows[0]!.n > 0, error: error ? String(error) : null })
      .toEqual({ imported: true, error: null });
    expect(result).toBeDefined();
  }, 60_000);
});
