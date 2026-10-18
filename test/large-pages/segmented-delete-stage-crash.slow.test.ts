/**
 * A soft delete of a file-backed page over the single-string ceiling killed while its prior file was being copied to
 * its before stage, and recovery when that copy is incomplete (PR 2 fix lane G).
 *
 * 1. Protects: the copy is written under a temporary name and renamed only once complete and flushed, so a SIGKILL
 *    during the copy (`large_file:stage_copying`, the temporary copy then torn) or during the rename
 *    (`large_file:stage_flushed`) leaves the canonical file untouched and nothing recovery waits on: the next pass
 *    removes the temporary copy and requeues the request with the exact prior bytes and no recovery bytes held. A copy
 *    torn at the stage's own name (what a crash mid-copy left before the temporary name) while the file still holds
 *    its prior bytes is dropped the same way. When recovery truly cannot proceed (the file was removed and its copy is
 *    torn) the pass records `unexpected_staging_bytes` instead of throwing, and the `gbrain repair stuck-recovery`
 *    preview still runs: it counts that record, and lists a large-file record blocked on an edited file as a resolvable
 *    item (stuck-recovery-large.slow.test.ts resolves one) instead of aborting.
 * 2. Fails when: a torn copy at the stage name throws `unexpected_staging_bytes` on every pass without recording it (the
 *    worktree wedges), the copy is made in place, a temporary copy is left behind, or the preview aborts on a large-file
 *    record.
 * 3. Existing coverage: segmented-delete-crash.slow.test.ts kills after the file was removed (`publication:after_publication`,
 *    `before_commit`) with a whole copy, and recovery after the rename back.
 * 4. Fault seams: the process-wide fault hook (fault-points.ts), including the two `large_file:*` seams in stageBeforeCopy.
 * Serial: SIGKILLs child processes that hold a brain. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { testBackends } from '../helpers/test-backends.ts';

const worker = join(import.meta.dir, '../fixtures/large-delete-crash-worker.ts');
const MiB = 1024 * 1024;
const tear = (path: string) => truncateSync(path, Math.floor(statSync(path).size / 2));

type Run = (mode: string, boundary?: string) => Promise<Record<string, any>>;
interface Case {
  name: string; seam: string;
  /** After the kill: what is staged, then what the test does to the files. */
  crashed(crashed: Record<string, any>, initialized: Record<string, any>, file: string): void;
  /** The recovery pass and what follows it. */
  recover(run: Run, initialized: Record<string, any>): Promise<void>;
}

const requeued = async (run: Run, initialized: Record<string, any>) => {
  expect(await run('recover')).toMatchObject({ recovered: 'queued', recovery: null, blocked_reason: null });
  expect(await run('inspect')).toMatchObject({ state: 'queued', file_sha: initialized.sha, stages: [], page_deleted: false, recovery_bytes: 0, counters_zero: true });
};

const cases: Case[] = [
  { name: 'killed during the copy, the temporary copy torn', seam: 'large_file:stage_copying', crashed(crashed, initialized) {
    expect(crashed.file_sha).toBe(initialized.sha);
    expect(crashed.stages).toEqual([{ path: `${crashed.before_stage.path}.copying`, sha: initialized.sha }]);
    tear(crashed.stages[0].path);
  }, recover: requeued },
  { name: 'killed during the rename', seam: 'large_file:stage_flushed', crashed(crashed, initialized) {
    expect(crashed.file_sha).toBe(initialized.sha);
    expect(crashed.stages).toEqual([{ path: `${crashed.before_stage.path}.copying`, sha: initialized.sha }]);
  }, recover: requeued },
  { name: 'a copy torn at the stage name while the file holds its prior bytes', seam: 'publication:prepared', crashed(crashed, initialized) {
    expect(crashed.file_sha).toBe(initialized.sha);
    expect(crashed.stages).toEqual([{ path: crashed.before_stage.path, sha: initialized.sha }]);
    tear(crashed.before_stage.path);
  }, recover: requeued },
  { name: 'the file removed and its copy torn: blocked, recorded, and the preview counts it', seam: 'publication:before_commit', crashed(crashed, initialized) {
    expect(crashed.file_sha).toBeNull();
    expect(crashed.stages).toEqual([{ path: crashed.before_stage.path, sha: initialized.sha }]);
    tear(crashed.before_stage.path);
  }, async recover(run) {
    for (let pass = 0; pass < 2; pass++) expect(await run('recover')).toMatchObject({ recovered: 'recovering', recovery: 'set', blocked_reason: 'unexpected_staging_bytes' });
    expect(await run('scan')).toEqual({ items: 0, refused: [], residuals: { unexpected_staging_bytes: 1 } });
  } },
  { name: 'the file edited after its copy: the preview lists it as resolvable', seam: 'publication:prepared', crashed(crashed, initialized, file) {
    expect(crashed.file_sha).toBe(initialized.sha);
    appendFileSync(file, 'edited by hand\n');
  }, async recover(run) {
    expect(await run('recover')).toMatchObject({ recovered: 'recovering', recovery: 'set', blocked_reason: 'unexpected_file_bytes' });
    expect(await run('scan')).toEqual({ items: 1, refused: [], residuals: {} });
  } },
];

for (const c of cases) {
  test(`a large soft delete ${c.name}`, async () => {
    for (const kind of testBackends()) {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-large-stage-crash-'));
      const configPath = join(home, 'worker.json');
      const database = `gbrain_test_large_stage_${randomUUID().replaceAll('-', '')}`;
      let admin: ReturnType<typeof postgres> | undefined;
      let databaseUrl: string | undefined;
      if (kind === 'postgres') {
        assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
        admin = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
        await admin.unsafe(`CREATE DATABASE ${database}`);
        const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; databaseUrl = url.toString();
      }
      const root = join(home, 'root');
      writeFileSync(configPath, JSON.stringify({ engine: kind, database_path: join(home, 'db'), database_url: databaseUrl, root,
        sourceId: 'stage-crash-example', slug: 'notes/large', bytes: 25 * MiB }));
      const env = { ...process.env, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
        GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SWEEP: '0', OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
      const run: Run = async (mode, boundary = '') => {
        const child = Bun.spawn([process.execPath, worker, mode, configPath, boundary], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
        const errors = new Response(child.stderr).text();
        const timer = setTimeout(() => child.kill('SIGKILL'), 600_000);
        let output = '';
        try {
          for await (const bytes of child.stdout) {
            output += new TextDecoder().decode(bytes);
            if (boundary && output.includes(`"boundary":"${boundary}"`)) { child.kill('SIGKILL'); break; }
          }
          const code = await child.exited;
          if (boundary) expect({ output, code }).toMatchObject({ output: expect.stringContaining(`"boundary":"${boundary}"`) });
          else expect({ mode, code, stderr: code === 0 ? '' : (await errors).slice(-2000) }).toEqual({ mode, code: 0, stderr: '' });
          return JSON.parse(output.trim().split('\n').at(-1)!);
        } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } }
      };
      try {
        const initialized = await run('initialize');
        expect(initialized).toMatchObject({ initialized: 'imported', body_storage: 'segmented' });
        await run('delete', c.seam);
        const crashed = await run('inspect');
        expect(crashed).toMatchObject({ before: null, before_hash: initialized.sha, page_deleted: false });
        expect(crashed.before_stage).toMatchObject({ hash: initialized.sha, bytes: initialized.size });
        c.crashed(crashed, initialized, join(root, 'notes/large.md'));
        await c.recover(run, initialized);
      } finally {
        if (admin) { await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end(); }
        rmSync(home, { recursive: true, force: true });
      }
    }
  }, 1_800_000);
}
