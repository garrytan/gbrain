/**
 * E2E (Postgres): parallel import-worker completion under a caller abort
 * (refactor wave 1, W4 sync, Eng contract "Sync": worker completion, assert
 * durable state after restart).
 *
 * PGLite forces the serial drain, so the worker pool only runs here. One
 * worker's import is held in flight (a latch on the first per-file engine
 * read, `getPage(slug, {includeDeleted: true})`, patched on
 * PostgresEngine.prototype so it reaches the worker engines the drain
 * constructs). The caller aborts while it is held; the other workers stop at
 * their next check, the held worker's file finishes and is banked, and the run
 * returns partial without advancing the bookmark. A fresh engine then reads
 * the durable state: every imported page is banked, the bookmark is
 * unchanged, and the resumed run imports only the unbanked files.
 *
 * Run: DATABASE_URL=... bun test test/e2e/sync-run-workers-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { loadOpCheckpoint, syncFingerprint } from '../../src/core/op-checkpoint.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { getConn, getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;
const SOURCE = 'e2e-syncrun-workers';

describeE2E('E2E SyncRun: parallel worker completion under abort (W4 sync)', () => {
  let repoPath: string;

  beforeAll(async () => {
    await setupDB();
  }, 60_000);

  afterAll(async () => {
    if (repoPath) rmSync(repoPath, { recursive: true, force: true });
    delete process.env.GBRAIN_SYNC_CHECKPOINT_EVERY;
    await teardownDB();
  });

  test('the held worker finishes and banks its file; resume imports only what was not banked', async () => {
    const { performSync } = await import('../../src/commands/sync.ts');
    const engine = getEngine();
    const conn = getConn();
    const git = (args: string) => execSync(`git ${args}`, { cwd: repoPath, stdio: 'pipe' }).toString().trim();
    const commit = (names: string[], msg: string) => {
      mkdirSync(join(repoPath, 'notes'), { recursive: true });
      for (const n of names) writeFileSync(join(repoPath, 'notes', `${n}.md`), `---\ntype: concept\ntitle: ${n}\n---\n\nBody for ${n}.\n`);
      git('add -A');
      git(`commit -q -m ${JSON.stringify(msg)}`);
      return git('rev-parse HEAD');
    };
    const anchor = async () =>
      ((await conn.unsafe(`SELECT last_commit FROM sources WHERE id = $1`, [SOURCE])) as Array<{ last_commit: string | null }>)[0]?.last_commit ?? null;

    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-e2e-syncrun-workers-'));
    execSync('git init -q', { cwd: repoPath });
    git('config user.email "test@example.com"');
    git('config user.name "Test"');
    commit(['base'], 'initial');
    await conn.unsafe(
      `INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
      [SOURCE, repoPath],
    );
    const opts = { repoPath, sourceId: SOURCE, noPull: true, noEmbed: true, noExtract: true } as const;
    await performSync(engine, { ...opts, full: true });
    const c0 = (await anchor())!;
    expect(c0).toBeTruthy();

    const names = Array.from({ length: 12 }, (_, i) => `w${String(i).padStart(2, '0')}`);
    const c1 = commit(names, 'twelve');
    process.env.GBRAIN_SYNC_CHECKPOINT_EVERY = '1';

    const proto = PostgresEngine.prototype as unknown as { getPage: BrainEngine['getPage'] };
    const orig = proto.getPage;
    const started: string[] = [];
    let release!: () => void;
    let reach!: (slug: string) => void;
    const held = new Promise<void>((r) => { release = r; });
    const reached = new Promise<string>((r) => { reach = r; });
    proto.getPage = async function (this: BrainEngine, slug: string, o?: Parameters<BrainEngine['getPage']>[1]) {
      if (o && (o as { includeDeleted?: boolean }).includeDeleted === true && slug.startsWith('notes/w') && !started.includes(slug)) {
        started.push(slug);
        if (started.length === 3) { reach(slug); await held; }
      }
      return orig.call(this, slug, o);
    } as BrainEngine['getPage'];

    const ac = new AbortController();
    let heldSlug = '';
    let res;
    try {
      const running = performSync(engine, { ...opts, concurrency: 3, signal: ac.signal });
      heldSlug = await reached;
      ac.abort();
      release();
      res = await running;
    } finally {
      proto.getPage = orig;
    }
    expect(res.status).toBe('partial');
    expect(res.reason).toBe('timeout');
    expect(res.filesImported).toBeGreaterThanOrEqual(1);
    expect(res.filesImported).toBeLessThan(names.length);

    // Durable state, read through a fresh engine (restart).
    const fresh = new PostgresEngine();
    await fresh.connect({ database_url: process.env.DATABASE_URL! });
    try {
      expect(await anchor()).toBe(c0);
      const bankedPaths = (await loadOpCheckpoint(fresh, { op: 'sync', fingerprint: syncFingerprint({ sourceId: SOURCE, lastCommit: c0 }) })).sort();
      const pageRows = (await conn.unsafe(
        `SELECT slug FROM pages WHERE source_id = $1 AND slug LIKE 'notes/w%' AND deleted_at IS NULL ORDER BY slug`,
        [SOURCE],
      )) as Array<{ slug: string }>;
      const importedPaths = pageRows.map((r) => `${r.slug}.md`).sort();
      expect(importedPaths).toContain(`${heldSlug}.md`); // the held worker completed its file
      expect(bankedPaths).toEqual(importedPaths); // every persisted file is banked, nothing more
      expect(bankedPaths.length).toBe(res.filesImported ?? -1);

      const resumeStarted: string[] = [];
      proto.getPage = async function (this: BrainEngine, slug: string, o?: Parameters<BrainEngine['getPage']>[1]) {
        if (o && (o as { includeDeleted?: boolean }).includeDeleted === true && slug.startsWith('notes/w') && !resumeStarted.includes(slug)) resumeStarted.push(slug);
        return orig.call(this, slug, o);
      } as BrainEngine['getPage'];
      let resumed;
      try {
        resumed = await performSync(fresh, { ...opts, concurrency: 3 });
      } finally {
        proto.getPage = orig;
      }
      expect(resumed.status).toBe('synced');
      expect(resumeStarted.sort()).toEqual(names.map((n) => `notes/${n}`).filter((s) => !bankedPaths.includes(`${s}.md`)));
      expect(await anchor()).toBe(c1);
      expect(await loadOpCheckpoint(fresh, { op: 'sync', fingerprint: syncFingerprint({ sourceId: SOURCE, lastCommit: c0 }) })).toEqual([]);
    } finally {
      await fresh.disconnect();
    }
  }, 120_000);
});
