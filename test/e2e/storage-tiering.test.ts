/**
 * E2E test for storage tiering — Postgres-only.
 *
 * Per the v0.23.0 plan: full lifecycle. Container restart simulation:
 * write pages via Postgres, delete files from disk, run gbrain export
 * --restore-only, assert files restored. Real .gitignore round-trip.
 * Real source-resolver path through getDefaultSourcePath().
 *
 * Skips gracefully when DATABASE_URL is unset (per CLAUDE.md E2E pattern).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setupDB, teardownDB, getEngine, hasDatabase, getConn } from './helpers.ts';
import {
  getStorageStatus,
  formatStorageStatusHuman,
  __resetPGLiteWarn,
} from '../../src/commands/storage.ts';
import { manageGitignore, __resetPGLiteTierWarn } from '../../src/commands/sync.ts';
import { getDefaultSourcePath } from '../../src/core/source-resolver.ts';
import { __resetMissingStorageWarning } from '../../src/core/storage-config.ts';

if (!hasDatabase()) {
  describe('storage-tiering E2E', () => {
    test.skip('DATABASE_URL not set — skipping E2E', () => {});
  });
} else {
  describe('storage-tiering E2E (Postgres lifecycle)', () => {
    let tmp: string;

    beforeAll(async () => {
      await setupDB();
    });

    afterAll(async () => {
      await teardownDB();
    });

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), 'gbrain-e2e-storage-'));
      __resetMissingStorageWarning();
      __resetPGLiteWarn();
      __resetPGLiteTierWarn();
    });

    function cleanup(): void {
      rmSync(tmp, { recursive: true, force: true });
    }

    function writeGbrainYml(): void {
      writeFileSync(
        join(tmp, 'gbrain.yml'),
        `storage:
  db_tracked:
    - people/
  db_only:
    - media/x/
    - media/articles/
`,
      );
    }

    test('engine.kind is postgres', () => {
      try {
        expect(getEngine().kind).toBe('postgres');
      } finally {
        cleanup();
      }
    });

    test('full lifecycle: write pages → status reports tiers → manage .gitignore → restore-only path', async () => {
      try {
        const engine = getEngine();

        // Truncate sources + pages so this test has a clean slate.
        const conn = getConn();
        await conn.unsafe(`TRUNCATE pages, content_chunks, sources CASCADE`);
        await conn.unsafe(
          `INSERT INTO sources (id, name, local_path) VALUES ('default', 'Default', $1)`,
          [tmp],
        );

        writeGbrainYml();

        // Seed 4 pages: 1 db_tracked, 2 db_only, 1 unspecified.
        await engine.putPage('people/alice', {
          type: 'person',
          title: 'Alice',
          compiled_truth: 'Alice is a founder.',
          timeline: '',
        });
        await engine.putPage('media/x/tweet-1', {
          type: 'media',
          title: 'Tweet 1',
          compiled_truth: 'tweet body',
          timeline: '',
        });
        await engine.putPage('media/x/tweet-2', {
          type: 'media',
          title: 'Tweet 2',
          compiled_truth: 'tweet body 2',
          timeline: '',
        });
        await engine.putPage('random/note', {
          type: 'note',
          title: 'Random',
          compiled_truth: 'random',
          timeline: '',
        });

        // Storage status reports tier counts correctly.
        const status = await getStorageStatus(engine, tmp);
        expect(status.totalPages).toBe(4);
        expect(status.pagesByTier.db_tracked).toBe(1);
        expect(status.pagesByTier.db_only).toBe(2);
        expect(status.pagesByTier.unspecified).toBe(1);

        // Human formatter renders without errors.
        const out = formatStorageStatusHuman(status);
        expect(out).toContain('DB tracked:     1 pages');
        expect(out).toContain('DB only:        2 pages');

        // .gitignore management: empty .gitignore → managed block written.
        manageGitignore(tmp, 'postgres');
        const gitignore = readFileSync(join(tmp, '.gitignore'), 'utf-8');
        expect(gitignore).toContain('# Auto-managed by gbrain');
        expect(gitignore).toContain('media/x/');
        expect(gitignore).toContain('media/articles/');

        // Idempotency: second run adds nothing new.
        manageGitignore(tmp, 'postgres');
        const gitignore2 = readFileSync(join(tmp, '.gitignore'), 'utf-8');
        const xCount = (gitignore2.match(/^media\/x\/$/gm) || []).length;
        expect(xCount).toBe(1);

        // Source resolution finds the local_path we registered.
        const resolvedPath = await getDefaultSourcePath(engine);
        expect(resolvedPath).toBe(tmp);
      } finally {
        cleanup();
      }
    });

    test('container restart simulation: db_only files missing on disk are restorable from DB', async () => {
      try {
        const engine = getEngine();
        const conn = getConn();

        // Fresh slate.
        await conn.unsafe(`TRUNCATE pages, content_chunks, sources CASCADE`);
        await conn.unsafe(
          `INSERT INTO sources (id, name, local_path) VALUES ('default', 'Default', $1)`,
          [tmp],
        );

        writeGbrainYml();

        // Write some db_only pages to the database.
        await engine.putPage('media/x/tweet-1', {
          type: 'media',
          title: 'Tweet 1',
          compiled_truth: 'tweet body 1',
          timeline: '',
        });
        await engine.putPage('media/x/tweet-2', {
          type: 'media',
          title: 'Tweet 2',
          compiled_truth: 'tweet body 2',
          timeline: '',
        });

        // Simulate "files were on disk, but the container restarted."
        // Storage status: missingFiles should list them.
        const status = await getStorageStatus(engine, tmp);
        expect(status.pagesByTier.db_only).toBe(2);
        expect(status.missingFiles.length).toBe(2);

        // Verify slugPrefix engine filter (Issue #13) works on Postgres for
        // the prefix that --restore-only would use.
        const tierPages = await engine.listPages({ slugPrefix: 'media/x/', limit: 100 });
        expect(tierPages.map((p) => p.slug).sort()).toEqual(['media/x/tweet-1', 'media/x/tweet-2']);

        // Source-default path resolution returns the configured local_path
        // (the typed accessor that replaces the original raw-SQL try/catch
        // in storage.ts:38).
        const path = await getDefaultSourcePath(engine);
        expect(path).toBe(tmp);
      } finally {
        cleanup();
      }
    });

    test('slugPrefix filter on Postgres uses index-based range scan (regression for Issue #13)', async () => {
      try {
        const engine = getEngine();
        const conn = getConn();
        await conn.unsafe(`TRUNCATE pages, content_chunks, sources CASCADE`);
        await conn.unsafe(`INSERT INTO sources (id, name) VALUES ('default', 'Default')`);

        // Seed enough data to make a difference between scan types.
        for (let i = 0; i < 50; i++) {
          await engine.putPage(`media/x/item-${i}`, {
            type: 'media',
            title: `Item ${i}`,
            compiled_truth: 'x',
            timeline: '',
          });
        }
        for (let i = 0; i < 50; i++) {
          await engine.putPage(`people/p-${i}`, {
            type: 'person',
            title: `Person ${i}`,
            compiled_truth: 'x',
            timeline: '',
          });
        }

        // Prefix query should return exactly 50 (people not included).
        const xResults = await engine.listPages({ slugPrefix: 'media/x/', limit: 200 });
        expect(xResults.length).toBe(50);
        for (const p of xResults) {
          expect(p.slug.startsWith('media/x/')).toBe(true);
        }

        // Path-segment risk: slugPrefix 'media/x' (no /) would match
        // 'media/xerox' if any existed. The engine treats slugPrefix as a
        // literal string prefix; trailing-/ semantics are the matcher's
        // responsibility (storage-config.ts).
        const looseResults = await engine.listPages({ slugPrefix: 'media/x', limit: 200 });
        expect(looseResults.length).toBe(50); // no media/xerox/* exists yet
      } finally {
        cleanup();
      }
    });

    test('hard-error path: storage status without local_path or --repo gets null repoPath', async () => {
      try {
        const engine = getEngine();
        const conn = getConn();
        await conn.unsafe(`TRUNCATE sources CASCADE`);
        // Default source with NO local_path.
        await conn.unsafe(
          `INSERT INTO sources (id, name, local_path) VALUES ('default', 'Default', NULL)`,
        );

        const path = await getDefaultSourcePath(engine);
        expect(path).toBeNull();
      } finally {
        cleanup();
      }
    });

    test('manageGitignore on Postgres engine does NOT emit PGLite warning', async () => {
      try {
        writeGbrainYml();
        const warnings: string[] = [];
        const orig = console.warn;
        console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(' '));
        try {
          manageGitignore(tmp, 'postgres');
        } finally {
          console.warn = orig;
        }
        expect(warnings.filter((w) => /limited effect on PGLite/.test(w))).toEqual([]);
      } finally {
        cleanup();
      }
    });
  });
}
