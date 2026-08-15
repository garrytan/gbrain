import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

/**
 * #3068 regression: a failed internal `git pull` (warn-and-continue class,
 * e.g. a local-filesystem-path origin rejected by the SSRF flag
 * `protocol.file.allow=never`) combined with a zero-import run must NOT be
 * reported as a clean `up_to_date` sync:
 *
 *   - status must be `partial` with reason `pull_failed` (not `up_to_date`),
 *   - `last_commit` (the sync anchor) must not move,
 *   - `last_sync_at` (the freshness heartbeat doctor/sources-status read)
 *     must not be bumped — otherwise a permanently-failing pull keeps the
 *     source looking fresh forever while it silently goes stale.
 *
 * The fall-through-to-working-tree design is unchanged: local commits still
 *  import when the remote is unreachable, and once the operator repairs the
 * checkout (e.g. a manual `git pull`, which does not carry the SSRF flags)
 * the next sync imports the missed content from the untouched anchor.
 *
 * The local-path-origin topology below reproduces the pull failure
 * deterministically: `pullRepo` always passes `-c protocol.file.allow=never`,
 * so its internal pull fails on every cycle while plain `git pull` succeeds.
 */
describe('#3068: failed git pull + zero imports must not report up_to_date', () => {
  let engine: PGLiteEngine;
  const dirs: string[] = [];
  // Hermetic GBRAIN_HOME: performFullSync (first sync) reads/writes the
  // sync-failure ledger under the gbrain home — never touch the real one.
  let isolatedHome: string;
  let origGbrainHome: string | undefined;

  beforeAll(async () => {
    origGbrainHome = process.env.GBRAIN_HOME;
    isolatedHome = mkdtempSync(join(tmpdir(), 'gbrain-3068-home-'));
    process.env.GBRAIN_HOME = isolatedHome;
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    if (origGbrainHome !== undefined) process.env.GBRAIN_HOME = origGbrainHome;
    else delete process.env.GBRAIN_HOME;
    rmSync(isolatedHome, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  function personMd(title: string, body: string): string {
    return ['---', 'type: person', `title: ${title}`, '---', '', body].join('\n');
  }

  function mkUpstream(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-3068-upstream-'));
    dirs.push(dir);
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

  /** Clone `upstream` to a sibling temp dir — origin is a local filesystem path. */
  function mkMirror(upstream: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-3068-mirror-'));
    dirs.push(dir);
    rmSync(dir, { recursive: true, force: true });
    execSync(`git clone ${JSON.stringify(upstream)} ${JSON.stringify(dir)}`, { stdio: 'pipe' });
    return dir;
  }

  async function sourceRow(): Promise<{ last_commit: string | null; last_sync_at: string | null }> {
    const rows = await engine.executeRaw<{ last_commit: string | null; last_sync_at: string | null }>(
      `SELECT last_commit, last_sync_at FROM sources WHERE id = 'default'`,
    );
    return rows[0] ?? { last_commit: null, last_sync_at: null };
  }

  // Pull ENABLED (no noPull) — the internal pull must actually run and fail.
  const SYNC_OPTS = { noEmbed: true, noExtract: true, sourceId: 'default' } as const;

  test('zero-import sync after failed pull reports partial/pull_failed; anchor and heartbeat frozen; manual pull recovers', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const upstream = mkUpstream({ 'people/alice.md': personMd('Alice', 'Alice is a person.') });
    const mirror = mkMirror(upstream);

    // First sync: the internal pull already fails (local-path origin), but the
    // fall-through imports the working tree — unchanged behavior.
    const first = await performSync(engine, { repoPath: mirror, ...SYNC_OPTS });
    expect(first.status).toBe('first_sync');
    const afterFirst = await sourceRow();
    expect(afterFirst.last_commit).not.toBeNull();
    expect(afterFirst.last_sync_at).not.toBeNull();

    // New content lands upstream; the mirror's internal pull can never fetch it.
    writeFileSync(join(upstream, 'people/bob.md'), personMd('Bob', 'zzuniquetoken99 new content.'));
    execSync('git add -A && git commit -m "new page"', { cwd: upstream, stdio: 'pipe' });

    // Wait so a (buggy) heartbeat bump would be observable as a changed timestamp.
    await new Promise((r) => setTimeout(r, 1100));

    // Pre-fix this reported `up_to_date`, bumped last_sync_at, and exited clean
    // forever — the #3068 silent wedge.
    const wedged = await performSync(engine, { repoPath: mirror, ...SYNC_OPTS });
    expect(wedged.status).toBe('partial');
    expect(wedged.reason).toBe('pull_failed');
    expect(wedged.added + wedged.modified + wedged.deleted + wedged.renamed).toBe(0);
    expect(wedged.fromCommit).toBe(afterFirst.last_commit);
    expect(wedged.toCommit).toBe(afterFirst.last_commit ?? '');

    const afterWedged = await sourceRow();
    expect(afterWedged.last_commit).toBe(afterFirst.last_commit); // anchor unchanged
    expect(afterWedged.last_sync_at).toEqual(afterFirst.last_sync_at); // heartbeat NOT bumped

    // Recovery: a manual pull (no SSRF flags) fast-forwards the mirror; the
    // next sync imports the missed content from the untouched anchor.
    execSync('git pull', { cwd: mirror, stdio: 'pipe' });
    const recovered = await performSync(engine, { repoPath: mirror, ...SYNC_OPTS });
    expect(recovered.status).toBe('synced');
    expect(recovered.added).toBe(1);
    expect(await engine.getPage('people/bob')).not.toBeNull();

    const afterRecovered = await sourceRow();
    expect(afterRecovered.last_commit).not.toBe(afterFirst.last_commit); // anchor advanced with the import
  });

  test('failed pull with local syncable commits still imports them (fall-through preserved)', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const upstream = mkUpstream({ 'people/alice.md': personMd('Alice', 'Alice is a person.') });
    const mirror = mkMirror(upstream);

    const first = await performSync(engine, { repoPath: mirror, ...SYNC_OPTS });
    expect(first.status).toBe('first_sync');

    // A local commit in the mirror itself — importable without any pull.
    execSync('git config user.email "test@test.com"', { cwd: mirror, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: mirror, stdio: 'pipe' });
    writeFileSync(join(mirror, 'people/carol.md'), personMd('Carol', 'Carol is local.'));
    execSync('git add -A && git commit -m "local carol"', { cwd: mirror, stdio: 'pipe' });

    // The internal pull still fails, but there is real local work — the
    // warn-and-continue design imports it and advances the anchor over the
    // commits that were actually imported.
    const synced = await performSync(engine, { repoPath: mirror, ...SYNC_OPTS });
    expect(synced.status).toBe('synced');
    expect(synced.added).toBe(1);
    expect(await engine.getPage('people/carol')).not.toBeNull();
  });

  test('local no-syncable-content commit after failed pull also reports partial without advancing the anchor', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const upstream = mkUpstream({ 'people/alice.md': personMd('Alice', 'Alice is a person.') });
    const mirror = mkMirror(upstream);

    const first = await performSync(engine, { repoPath: mirror, ...SYNC_OPTS });
    expect(first.status).toBe('first_sync');
    const anchor = (await sourceRow()).last_commit;

    // A local commit with no syncable content (non-markdown file).
    execSync('git config user.email "test@test.com"', { cwd: mirror, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: mirror, stdio: 'pipe' });
    writeFileSync(join(mirror, 'notes.txt'), 'not syncable');
    execSync('git add -A && git commit -m "local txt"', { cwd: mirror, stdio: 'pipe' });

    const result = await performSync(engine, { repoPath: mirror, ...SYNC_OPTS });
    expect(result.status).toBe('partial');
    expect(result.reason).toBe('pull_failed');
    expect((await sourceRow()).last_commit).toBe(anchor); // anchor unchanged
  });
});
