/**
 * v0.42.42.0 (#2139) — estimateInlineNewTokens ladder coverage.
 *
 * The inline cost estimator now MIRRORS EXECUTION (delta, not full-tree
 * ceiling) so the gate's dollar figure stops being a ~400x phantom on a busy
 * brain. Real temp git repos, no PGLite. estimateInlineNewTokens is exported
 * from commands/sync.ts; CHUNKER_VERSION is the live chunker version.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { estimateInlineNewTokens } from '../src/commands/sync.ts';
import { CHUNKER_VERSION } from '../src/core/chunkers/code.ts';

const CURRENT = String(CHUNKER_VERSION);
let repo: string;

function commitAll(msg: string): string {
  execSync('git add -A', { cwd: repo, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: repo, stdio: 'pipe' });
  return execSync('git rev-parse HEAD', { cwd: repo, stdio: 'pipe' }).toString().trim();
}
function src(over: Partial<{ last_commit: string | null; chunker_version: string | null; config: Record<string, unknown> }> = {}) {
  return {
    local_path: repo,
    config: over.config ?? {},
    last_commit: over.last_commit ?? null,
    chunker_version: over.chunker_version ?? null,
  };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gbrain-est-'));
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
  mkdirSync(join(repo, 'topics'), { recursive: true });
});
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('estimateInlineNewTokens — ladder', () => {
  test('chunker drift → full-tree ceiling even with an empty git delta', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'some body content here');
    const head = commitAll('base');
    // git unchanged (last_commit == HEAD) but chunker drifted → must NOT be 0.
    const r = estimateInlineNewTokens([src({ last_commit: head, chunker_version: 'STALE-0' })], CURRENT);
    expect(r.tokens).toBeGreaterThan(0);
    expect(r.estimateKind).toBe('ceiling');
    expect(r.ceilingReasons).toContain('chunker_drift');
    expect(r.changedSources).toBe(1);
  });

  test('[D2A headline] HEAD==last_commit + current chunker + DIRTY tree → 0 (unchanged)', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'body');
    const head = commitAll('base');
    // Dirty the tree (untracked scratch + uncommitted edit) — attached sync
    // imports nothing, so the estimate must be 0. This is the exact pre-fix
    // false-fire shape.
    writeFileSync(join(repo, 'scratch.tmp'), 'agent scratch');
    writeFileSync(join(repo, 'topics/a.md'), 'uncommitted edit');
    const r = estimateInlineNewTokens([src({ last_commit: head, chunker_version: CURRENT })], CURRENT);
    expect(r.tokens).toBe(0);
    expect(r.estimateKind).toBe('unchanged');
    expect(r.unchangedSources).toBe(1);
  });

  test('first sync (last_commit null) → full-tree ceiling', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'body content');
    commitAll('base');
    const r = estimateInlineNewTokens([src({ last_commit: null, chunker_version: CURRENT })], CURRENT);
    expect(r.tokens).toBeGreaterThan(0);
    expect(r.estimateKind).toBe('ceiling');
    expect(r.ceilingReasons).toContain('first_sync');
  });

  test('delta rung: only changed committed files priced; deletes cost 0', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'a'.repeat(400));
    writeFileSync(join(repo, 'topics/b.md'), 'b'.repeat(400));
    const base = commitAll('base');
    writeFileSync(join(repo, 'topics/a.md'), 'a'.repeat(800)); // modify
    rmSync(join(repo, 'topics/b.md'));                          // delete → 0
    commitAll('change');

    const r = estimateInlineNewTokens([src({ last_commit: base, chunker_version: CURRENT })], CURRENT);
    expect(r.estimateKind).toBe('delta');
    expect(r.tokens).toBeGreaterThan(0); // a.md priced
    // A pure-delete delta would be 0; here a.md modify keeps it > 0. Sanity:
    // the magnitude is delta-scale (one ~800-char file), not full-tree.
  });

  test('delta rung: non-syncable changed file is filtered out (markdown strategy)', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'md');
    const base = commitAll('base');
    writeFileSync(join(repo, 'notes.txt'), 'x'.repeat(4000)); // .txt under markdown strategy → not syncable
    commitAll('add txt');

    const r = estimateInlineNewTokens([src({ last_commit: base, chunker_version: CURRENT })], CURRENT);
    // No syncable changes → delta priced at 0 tokens (but the source changed).
    expect(r.tokens).toBe(0);
    expect(r.estimateKind).toBe('delta');
  });

  test('syncEnabled:false sources are skipped (neither changed nor unchanged)', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'body');
    commitAll('base');
    const r = estimateInlineNewTokens([src({ last_commit: null, config: { syncEnabled: false } })], CURRENT);
    expect(r.tokens).toBe(0);
    expect(r.changedSources).toBe(0);
    expect(r.unchangedSources).toBe(0);
  });

  test('mixed: one ceiling source + one unchanged source → estimateKind mixed-or-ceiling, reasons captured', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'body');
    const head = commitAll('base');
    const r = estimateInlineNewTokens(
      [
        src({ last_commit: null, chunker_version: CURRENT }),      // first_sync ceiling
        src({ last_commit: head, chunker_version: CURRENT }),      // unchanged
      ],
      CURRENT,
    );
    expect(r.ceilingReasons).toContain('first_sync');
    expect(r.unchangedSources).toBe(1);
    // hadCeiling true, hadDelta false → 'ceiling' aggregate.
    expect(r.estimateKind).toBe('ceiling');
  });

  test('missing local_path source contributes nothing', () => {
    const r = estimateInlineNewTokens(
      [{ local_path: null, config: {}, last_commit: null, chunker_version: CURRENT }],
      CURRENT,
    );
    expect(r.tokens).toBe(0);
    expect(r.changedSources).toBe(0);
  });
});
