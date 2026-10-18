/**
 * A soft delete of a file-backed page over the single-string ceiling killed after its file was removed and before its
 * commit (Wave B, PR 2 fix lane D).
 *
 * 1. Protects: the delete's recovery record names the prior file's staged copy by path and SHA-256 (no embedded
 *    bytes, a record of a few hundred bytes); after SIGKILL at publication:after_publication or before_commit (file
 *    removed, nothing committed) the owner's recovery pass renames the copy back, so the canonical file holds the
 *    exact prior bytes, the page stays live, the request is requeued and its recovery bytes are released; a recovery
 *    killed right after the rename finishes on its next pass with the same bytes and no stage left.
 * 2. Fails when: the record embeds the prior file (base64, ~36 MB for 27 MiB), the copy is cleaned before recovery
 *    decides, or recovery restores anything but the recorded bytes.
 * 3. Existing coverage: persistence-skill-crash.slow.test.ts kills skill bundles (embedded before-images, 1 MiB files).
 * 4. Fault seams: the process-wide publication fault hook (fault-points.ts) and recoverPublication's fileBoundary.
 * Serial: SIGKILLs child processes that hold a brain. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { testBackends } from '../helpers/test-backends.ts';

const worker = join(import.meta.dir, '../fixtures/large-delete-crash-worker.ts');
const MiB = 1024 * 1024;

test('a large soft delete killed between file removal and commit recovers the exact prior bytes from its staged copy', async () => {
  for (const kind of testBackends()) {
    for (const seam of ['publication:after_publication', 'publication:before_commit']) {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-large-delete-crash-'));
      const configPath = join(home, 'worker.json');
      const database = `gbrain_test_large_delete_${randomUUID().replaceAll('-', '')}`;
      let admin: ReturnType<typeof postgres> | undefined;
      let databaseUrl: string | undefined;
      if (kind === 'postgres') {
        assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
        admin = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
        await admin.unsafe(`CREATE DATABASE ${database}`);
        const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${database}`; databaseUrl = url.toString();
      }
      writeFileSync(configPath, JSON.stringify({ engine: kind, database_path: join(home, 'db'), database_url: databaseUrl, root: join(home, 'root'),
        sourceId: 'crash-example', slug: 'notes/large', bytes: 27 * MiB }));
      const env = { ...process.env, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
        GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_BACKUP_CHECK: '0', GBRAIN_SWEEP: '0', OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
      const run = async (mode: string, boundary = ''): Promise<Record<string, any>> => {
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
          else expect({ code, stderr: code === 0 ? '' : await errors }).toEqual({ code: 0, stderr: '' });
          return JSON.parse(output.trim().split('\n').at(-1)!);
        } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } }
      };
      try {
        const initialized = await run('initialize');
        expect(initialized).toMatchObject({ initialized: 'imported', body_storage: 'segmented' });

        await run('delete', seam);
        const crashed = await run('inspect');
        // The file is gone (or about to be) and nothing committed; the record names the copy instead of embedding it.
        expect(crashed).toMatchObject({ before: null, before_hash: initialized.sha, page_deleted: false });
        expect(crashed.recovery_chars).toBeLessThan(4096);
        expect(crashed.file_sha).toBeNull();
        expect(crashed.before_stage).toMatchObject({ hash: initialized.sha, bytes: initialized.size });
        expect(crashed.stages).toEqual([{ path: crashed.before_stage.path, sha: initialized.sha }]);

        // A recovery killed right after it renamed the copy back finishes on its next pass.
        await run('recover', 'restoration_file_replaced');
        expect(await run('inspect')).toMatchObject({ file_sha: initialized.sha, stages: [] });
        expect(await run('recover')).toMatchObject({ recovered: 'queued', recovery: null, blocked_reason: null });
        expect(await run('inspect')).toMatchObject({ state: 'queued', file_sha: initialized.sha, stages: [], page_deleted: false, recovery_bytes: 0, counters_zero: true });
      } finally {
        if (admin) { await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`); await admin.end(); }
        rmSync(home, { recursive: true, force: true });
      }
    }
  }
}, 1_800_000);
