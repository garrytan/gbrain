/**
 * Shared fixture for the #7630 relative-anchor suites (test/sync-relative-anchor-refusal-7630.test.ts,
 * test/sync-relative-anchor-sources-doctor-7630.test.ts, test/sync-relative-anchor-readers-7630.test.ts).
 *
 * `describe7630` registers one describe per backend (PGLite always; Postgres when DATABASE_URL is set or under
 * registerPostgresTests). Each test gets a fresh isolated engine, a GBRAIN_HOME, and an unrelated folder holding a
 * markdown note and a private file, made the cwd for the test so a relative anchor of "." would resolve to it.
 */
import { afterEach, beforeEach, describe, spyOn } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { isolatedSharedSkillsEngine } from './shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends, type TestBackend } from './test-backends.ts';
import { withEnv } from './with-env.ts';

const SYNC = { noPull: true, noEmbed: true, noExtract: true, full: true };

type SyncRefusal = { code?: string; fix?: { argv?: string[]; ask_user?: boolean } } | null;
type CliRun = { lines: string[]; exit: number | undefined };

export interface Anchor7630 {
  engine: BrainEngine;
  home: string;
  folder: string;
  pageCount(): Promise<number>;
  pagesOf(sourceId: string): Promise<number>;
  sync(opts: Record<string, unknown>): Promise<SyncRefusal>;
  cli(run: () => Promise<unknown>): Promise<CliRun>;
  runSyncCli(args: string[]): Promise<CliRun & { refused: { code?: string } | undefined }>;
}

export function describe7630(topic: string, register: (t: Anchor7630, backend: TestBackend) => void): void {
  for (const backend of testBackends()) {
    const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

    describe(`#7630 [${backend}]: a relative stored anchor never makes the cwd the brain${topic ? `: ${topic}` : ''}`, () => {
      let close: () => Promise<void>, previousCwd: string;

      const cli = async (run: () => Promise<unknown>): Promise<CliRun> => {
        const lines: string[] = [];
        let exit: number | undefined;
        const push = (...a: unknown[]) => { lines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
        const spies = [spyOn(console, 'log').mockImplementation(push), spyOn(console, 'error').mockImplementation(push),
          spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as never),
          spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code; throw new Error(`__exit__${code}`); }) as never)];
        try {
          await withEnv({ GBRAIN_HOME: t.home, GBRAIN_SYNC_FAILURES_DIR: t.home, GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined }, run);
        } catch (error) {
          if (!String(error).includes('__exit__')) throw error;
        } finally {
          for (const spy of spies) spy.mockRestore();
        }
        return { lines, exit };
      };

      const t: Anchor7630 = {
        engine: undefined as never,
        home: '',
        folder: '',
        pageCount: async () => (await t.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages'))[0]!.n,
        pagesOf: async (sourceId: string) =>
          (await t.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [sourceId]))[0]!.n,
        sync: async (opts: Record<string, unknown>) => withEnv({ GBRAIN_HOME: t.home }, async () => {
          const { performSync } = await import('../../src/commands/sync.ts');
          return performSync(t.engine, { ...SYNC, ...opts }).then(() => null, (error: unknown) => error as SyncRefusal);
        }),
        cli,
        runSyncCli: async (args: string[]) => {
          let refused: { code?: string } | undefined;
          const result = await cli(async () => {
            const { runSync } = await import('../../src/commands/sync.ts');
            await runSync(t.engine, args).catch((error: { code?: string }) => {
              if (String(error).includes('__exit__')) throw error;
              refused = error;
            });
          });
          return { ...result, refused };
        },
      };

      beforeEach(async () => {
        t.home = mkdtempSync(join(tmpdir(), 'gbrain-7630-home-'));
        t.folder = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-7630-unrelated-')));
        writeFileSync(join(t.folder, 'notes.md'), '---\ntype: note\ntitle: Notes\n---\n\nA note that is not part of any brain.\n');
        writeFileSync(join(t.folder, 'private.txt'), 'not for any brain\n');
        ({ engine: t.engine, close } = await isolatedSharedSkillsEngine(databaseUrl));
        previousCwd = process.cwd();
        process.chdir(t.folder);
      }, 120_000);

      afterEach(async () => {
        process.chdir(previousCwd);
        await close();
        rmSync(t.folder, { recursive: true, force: true });
        rmSync(t.home, { recursive: true, force: true });
      });

      register(t, backend);
    });
  }
}
