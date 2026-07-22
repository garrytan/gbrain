/**
 * Tests for src/core/source-health.ts (v0.40 D12 + D9 + v0.41.32.0).
 *
 * Validates:
 *   - computeAllSourceMetrics: batched GROUP BY shape, vacuous truth for zero
 *     pages, and v0.41.32.0 commit-relative lag (probeContent local path +
 *     stored-column remote path).
 *   - resolvePriorityLabel: high/normal/low, unknown → normal + warn-once
 *   - newestCommitMs: HEAD committer time; null for non-git/missing.
 *   - lagFromContentMs: null/skew/null-content→wall-clock/caught-up→0/behind.
 *   - isSourceUnchangedSinceSync ignore-untracked: the commit-hash caught-up
 *     contract the local path relies on (incl. the codex old-dated-commit case).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  computeAllSourceMetrics,
  resolvePriorityLabel,
  resolvePriority,
  newestCommitMs,
  lagFromContentMs,
  _resetPriorityWarningsForTest,
} from '../src/core/source-health.ts';
import { isSourceUnchangedSinceSync } from '../src/core/git-head.ts';
import { loadAllSources } from '../src/core/sources-load.ts';

const HOUR = 3600_000;

/**
 * Create a throwaway git repo with one commit dated `commitDate`. Returns the
 * dir + its HEAD sha so tests can seed `sources.last_commit` to match.
 */
function makeGitRepo(commitDate: Date, registry: string[]): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-srchealth-'));
  registry.push(dir);
  const iso = commitDate.toISOString();
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  };
  const run = (args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], env });
  run(['init', '-q']);
  writeFileSync(join(dir, 'a.md'), '# a\n');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'seed']);
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { dir, head };
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  // Surgical reset: preserves config table (schema version).
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw(`DELETE FROM sources WHERE id != 'default'`);
  _resetPriorityWarningsForTest();
});

describe('resolvePriorityLabel', () => {
  test('recognized values', () => {
    expect(resolvePriorityLabel('s', { priority: 'high' })).toBe('high');
    expect(resolvePriorityLabel('s', { priority: 'normal' })).toBe('normal');
    expect(resolvePriorityLabel('s', { priority: 'low' })).toBe('low');
  });
  test('missing → normal silently', () => {
    expect(resolvePriorityLabel('s', {})).toBe('normal');
    expect(resolvePriorityLabel('s', null)).toBe('normal');
  });
  test('unknown values → normal with warn', () => {
    const orig = process.stderr.write.bind(process.stderr);
    let captured = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as never;
    try {
      expect(resolvePriorityLabel('zion-brain', { priority: 'urgent' })).toBe('normal');
      expect(captured).toContain('zion-brain');
      expect(captured).toContain('priority');
      expect(captured).toContain('normal');
    } finally {
      process.stderr.write = orig;
    }
  });
  test('warns once per source per process', () => {
    const orig = process.stderr.write.bind(process.stderr);
    let count = 0;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      if (s.includes('invalid config.priority')) count++;
      return true;
    }) as never;
    try {
      resolvePriorityLabel('s1', { priority: 'urgent' });
      resolvePriorityLabel('s1', { priority: 'urgent' });
      resolvePriorityLabel('s1', { priority: 42 });
      expect(count).toBe(1);
    } finally {
      process.stderr.write = orig;
    }
  });
});

describe('resolvePriority (numeric)', () => {
  test('maps labels to MinionQueue priority integers', () => {
    expect(resolvePriority('s', { priority: 'high' })).toBe(-10);
    expect(resolvePriority('s', { priority: 'normal' })).toBe(0);
    expect(resolvePriority('s', { priority: 'low' })).toBe(5);
    expect(resolvePriority('s', {})).toBe(0);
  });
});

// ── v0.41.32.0 commit-relative staleness ──────────────────────────────
describe('newestCommitMs', () => {
  const repos: string[] = [];
  afterAll(() => {
    for (const d of repos) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('null for null / non-git / missing paths', () => {
    expect(newestCommitMs(null)).toBeNull();
    expect(newestCommitMs('/tmp/gbrain-does-not-exist-' + Date.now())).toBeNull();
  });

  test('returns the HEAD committer time in ms', () => {
    const when = new Date(Date.now() - 50 * HOUR);
    const { dir } = makeGitRepo(when, repos);
    const ms = newestCommitMs(dir);
    expect(ms).not.toBeNull();
    expect(Math.abs((ms as number) - when.getTime())).toBeLessThan(2000);
  });
});

describe('lagFromContentMs (pure remote/column comparator)', () => {
  const now = 1_000_000_000_000;
  test('null last sync → null', () => {
    expect(lagFromContentMs(now - HOUR, null, now)).toBeNull();
  });
  test('future last sync (skew) → negative passthrough', () => {
    expect(lagFromContentMs(now, now + 10_000, now)).toBe(-10);
  });
  test('null content → wall-clock fallback', () => {
    expect(lagFromContentMs(null, now - 100 * HOUR, now)).toBe(360_000); // 100h in s
  });
  test('content at/before last sync → caught up (0)', () => {
    expect(lagFromContentMs(now - 200 * HOUR, now - 100 * HOUR, now)).toBe(0);
  });
  test('content after last sync → wall-clock since sync', () => {
    expect(lagFromContentMs(now - 10 * HOUR, now - 100 * HOUR, now)).toBe(360_000);
  });
});

describe('isSourceUnchangedSinceSync (ignore-untracked) — local caught-up contract', () => {
  const repos: string[] = [];
  afterAll(() => {
    for (const d of repos) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });

  test('HEAD == last_commit, clean → caught up', () => {
    const { dir, head } = makeGitRepo(new Date(Date.now() - 200 * HOUR), repos);
    expect(isSourceUnchangedSinceSync(dir, head, { requireCleanWorkingTree: 'ignore-untracked' })).toBe(true);
  });

  test('HEAD == last_commit WITH untracked dirs → still caught up (the headline bug)', () => {
    const { dir, head } = makeGitRepo(new Date(Date.now() - 200 * HOUR), repos);
    // Stray untracked dirs (the `?? companies/`, `?? media/` shape).
    writeFileSync(join(dir, 'companies'), 'x'); // file is fine; untracked either way
    execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }); // sanity: dirty by default
    expect(isSourceUnchangedSinceSync(dir, head, { requireCleanWorkingTree: 'ignore-untracked' })).toBe(true);
    // Strict mode (pre-v0.41.30 behavior) would have called it dirty:
    expect(isSourceUnchangedSinceSync(dir, head, { requireCleanWorkingTree: true })).toBe(false);
  });

  test('tracked uncommitted edit → NOT caught up (sync would re-walk the commit)', () => {
    const { dir, head } = makeGitRepo(new Date(Date.now() - 200 * HOUR), repos);
    writeFileSync(join(dir, 'a.md'), '# a edited\n'); // a.md is TRACKED
    expect(isSourceUnchangedSinceSync(dir, head, { requireCleanWorkingTree: 'ignore-untracked' })).toBe(false);
  });

  test('HEAD moved to an OLD-dated commit → NOT caught up (codex: hash, not timestamp)', () => {
    const { dir, head } = makeGitRepo(new Date(Date.now() - 200 * HOUR), repos);
    // Add a SECOND commit with an even OLDER committer date. A timestamp
    // comparison (newest content <= last sync) would falsely say "caught up";
    // the hash check correctly sees HEAD != last_commit.
    const olderIso = new Date(Date.now() - 500 * HOUR).toISOString();
    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: olderIso, GIT_COMMITTER_DATE: olderIso,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    };
    writeFileSync(join(dir, 'b.md'), '# b\n');
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: ['ignore', 'pipe', 'ignore'], env });
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'old-dated'], { stdio: ['ignore', 'pipe', 'ignore'], env });
    // `head` is still the FIRST commit's sha (the recorded last_commit).
    expect(isSourceUnchangedSinceSync(dir, head, { requireCleanWorkingTree: 'ignore-untracked' })).toBe(false);
  });

  test('NULL last_commit → not provably caught up (false)', () => {
    const { dir } = makeGitRepo(new Date(Date.now() - 10 * HOUR), repos);
    expect(isSourceUnchangedSinceSync(dir, null, { requireCleanWorkingTree: 'ignore-untracked' })).toBe(false);
  });
});

describe('computeAllSourceMetrics', () => {
  test('empty input returns empty', async () => {
    const result = await computeAllSourceMetrics(engine, []);
    expect(result).toEqual([]);
  });

  test('zero-page source → embed_coverage_pct=100 (vacuous truth)', async () => {
    const sources = await loadAllSources(engine);
    const result = await computeAllSourceMetrics(engine, sources);
    const dflt = result.find((m) => m.source_id === 'default')!;
    expect(dflt.total_pages).toBe(0);
    expect(dflt.total_chunks).toBe(0);
    expect(dflt.embed_coverage_pct).toBe(100);
  });

  test('aggregates pages + chunks + embedding coverage per source', async () => {
    await engine.putPage('a', { type: 'note', title: 'a', compiled_truth: 'a' });
    await engine.putPage('b', { type: 'note', title: 'b', compiled_truth: 'b' });
    await engine.upsertChunks('a', [
      { chunk_index: 0, chunk_text: 'one', chunk_source: 'compiled_truth', token_count: 1, embedding: new Float32Array(1536) },
      { chunk_index: 1, chunk_text: 'two', chunk_source: 'compiled_truth', token_count: 1, embedding: undefined },
    ]);
    await engine.upsertChunks('b', [
      { chunk_index: 0, chunk_text: 'three', chunk_source: 'compiled_truth', token_count: 1, embedding: undefined },
    ]);

    const sources = await loadAllSources(engine);
    const result = await computeAllSourceMetrics(engine, sources);
    const dflt = result.find((m) => m.source_id === 'default')!;
    expect(dflt.total_pages).toBe(2);
    expect(dflt.total_chunks).toBe(3);
    expect(dflt.embedded_chunks).toBe(1);
    expect(dflt.embed_coverage_pct).toBeCloseTo(33.3, 1);
  });

  test('lag_seconds is null when last_sync_at is null', async () => {
    const sources = await loadAllSources(engine);
    const result = await computeAllSourceMetrics(engine, sources);
    const dflt = result.find((m) => m.source_id === 'default')!;
    expect(dflt.lag_seconds).toBeNull();
  });

  test('multi-source isolation: each source gets its own counts', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{"federated":true}') ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('a', { type: 'note', title: 'a', compiled_truth: 'a' });
    await engine.putPage('b', { type: 'note', title: 'b', compiled_truth: 'b' }, { sourceId: 'other' });

    const sources = await loadAllSources(engine);
    const result = await computeAllSourceMetrics(engine, sources);
    expect(result.find((m) => m.source_id === 'default')!.total_pages).toBe(1);
    expect(result.find((m) => m.source_id === 'other')!.total_pages).toBe(1);
  });

  test('v0.41.31: embed-backfill active/queued counts per source (CLI BACKFILL column)', async () => {
    // 2 queued + 1 active embed-backfill for default; a non-backfill 'sync'
    // job must NOT inflate the backfill counts (only the generic queue_depth).
    await engine.executeRaw(
      `INSERT INTO minion_jobs (name, status, data) VALUES
         ('embed-backfill', 'waiting', '{"sourceId":"default"}'::jsonb),
         ('embed-backfill', 'waiting', '{"sourceId":"default"}'::jsonb),
         ('embed-backfill', 'active',  '{"sourceId":"default"}'::jsonb),
         ('sync',           'waiting', '{"sourceId":"default"}'::jsonb)`,
    );
    const sources = await loadAllSources(engine);
    const dflt = (await computeAllSourceMetrics(engine, sources)).find((m) => m.source_id === 'default')!;
    expect(dflt.backfill_active).toBe(1);
    expect(dflt.backfill_queued).toBe(2);
    // generic queue_depth includes the sync job too (4 total waiting/active).
    expect(dflt.queue_depth).toBe(4);
  });

  test('webhook_configured reflects config.webhook_secret presence', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('webhooky', 'webhooky', '{"federated":true,"webhook_secret":"x","github_repo":"a/b"}'::jsonb)`,
    );
    const sources = await loadAllSources(engine);
    const result = await computeAllSourceMetrics(engine, sources);
    const w = result.find((m) => m.source_id === 'webhooky')!;
    expect(w.webhook_configured).toBe(true);
    const d = result.find((m) => m.source_id === 'default')!;
    expect(d.webhook_configured).toBe(false);
  });

  // v0.41.32.0: commit-relative lag — local (probeContent) vs remote (column).
  describe('commit-relative lag', () => {
    const repos: string[] = [];
    afterAll(() => {
      for (const d of repos) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
    });

    test('LOCAL (probeContent): caught-up repo synced 100h ago → lag 0', async () => {
      const { dir, head } = makeGitRepo(new Date(Date.now() - 200 * HOUR), repos);
      const syncIso = new Date(Date.now() - 100 * HOUR).toISOString();
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, last_commit, last_sync_at, config)
         VALUES ('quiet', 'quiet', $1, $2, $3, '{"federated":true}'::jsonb)`,
        [dir, head, syncIso],
      );
      const sources = await loadAllSources(engine);
      const metrics = await computeAllSourceMetrics(engine, sources, { probeContent: true });
      expect(metrics.find((m) => m.source_id === 'quiet')!.lag_seconds).toBe(0);
    });

    test('LOCAL (probeContent): HEAD moved (behind) → wall-clock lag', async () => {
      const { dir } = makeGitRepo(new Date(Date.now() - 100 * HOUR), repos);
      const staleCommit = 'b'.repeat(40); // last_commit no longer matches HEAD
      const syncIso = new Date(Date.now() - 200 * HOUR).toISOString();
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, last_commit, last_sync_at, config)
         VALUES ('behind', 'behind', $1, $2, $3, '{"federated":true}'::jsonb)`,
        [dir, staleCommit, syncIso],
      );
      const sources = await loadAllSources(engine);
      const metrics = await computeAllSourceMetrics(engine, sources, { probeContent: true });
      expect(metrics.find((m) => m.source_id === 'behind')!.lag_seconds!).toBeGreaterThan(72 * 3600);
    });

    test('REMOTE (default): reads newest_content_at column, NO git probe → quiet repo lag 0', async () => {
      const contentIso = new Date(Date.now() - 200 * HOUR).toISOString(); // content predates sync
      const syncIso = new Date(Date.now() - 100 * HOUR).toISOString();
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, last_commit, last_sync_at, newest_content_at, config)
         VALUES ('remote', 'remote', '/nonexistent/not-a-repo', 'x', $1, $2, '{"federated":true}'::jsonb)`,
        [syncIso, contentIso],
      );
      const sources = await loadAllSources(engine);
      // probeContent OFF (remote): even though local_path is bogus, no git runs.
      const metrics = await computeAllSourceMetrics(engine, sources);
      expect(metrics.find((m) => m.source_id === 'remote')!.lag_seconds).toBe(0);
    });

    test('REMOTE (default): NULL column → wall-clock fallback', async () => {
      const syncIso = new Date(Date.now() - 100 * HOUR).toISOString();
      await engine.executeRaw(
        `INSERT INTO sources (id, name, local_path, last_commit, last_sync_at, config)
         VALUES ('nocol', 'nocol', '/nonexistent', 'x', $1, '{"federated":true}'::jsonb)`,
        [syncIso],
      );
      const sources = await loadAllSources(engine);
      const metrics = await computeAllSourceMetrics(engine, sources);
      expect(metrics.find((m) => m.source_id === 'nocol')!.lag_seconds!).toBeGreaterThan(99 * 3600);
    });
  });
});
