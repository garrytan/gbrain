/**
 * Shadow replay end to end: a real PGLite brain under a temporary GBRAIN_HOME, capture through the engine factory,
 * the nightly command seeding real PGLite and Rust copies, and the real `__replay-child` process. Postgres joins as a
 * third arm when GBRAIN_TEST_REPLAY_POSTGRES_URL names a local scratch database.
 *
 * Protects: capture is off by default (the factory returns the bare engine); the first night only seeds; the second
 * replays and writes a report and a summary that hold no input string; the child never writes the live brain files
 * or config; two replays of the same epoch write byte-identical reports.
 * Serial because it sets GBRAIN_HOME. The Rust arm needs `bun run rust:build`; without it the file skips
 * (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { nightlyDeps } from '../src/commands/engine-shadow-replay.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { appendPurgeIntent } from '../src/core/belief/purge-mirror.ts';
import { viewedEngine } from '../src/core/persistence/switches.ts';
import { constructEngine } from '../src/core/engine-construct.ts';
import type { EngineConfig } from '../src/core/types.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { captureDir } from '../src/shadow/capture-state.ts';
import { runNightlyReplay } from '../src/shadow/replay-run.ts';
import { hmacKey } from '../src/shadow/replay.ts';
import { shadowBrainKey, shadowDirFor } from '../src/shadow/state.ts';

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; run bun run rust:build`);
const PG = process.env.GBRAIN_TEST_REPLAY_POSTGRES_URL;
const CLI = [process.execPath, join(import.meta.dir, '..', 'src', 'cli.ts')];
const SECRET = { slug: 'people/zelda-secretname', title: 'Zelda Secretname', body: 'quarterly plan for project nightjar' };

/** Hash of every file under `root` except the shadow directory, keyed by relative path. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (relative(root, p).startsWith(join('.gbrain', 'shadow'))) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

/** GBRAIN_TEST_REPLAY_POSTGRES_URL names a database this test owns: start each run from an empty schema. */
async function emptyScratch(url: string): Promise<void> {
  const cfg = { engine: 'postgres', database_url: url } as EngineConfig;
  const e = await constructEngine(cfg);
  await e.connect(cfg);
  try { await e.executeRaw('DROP SCHEMA IF EXISTS public CASCADE'); await e.executeRaw('CREATE SCHEMA public'); } finally { await e.disconnect(); }
}

async function scratchTables(url: string): Promise<number> {
  const cfg = { engine: 'postgres', database_url: url } as EngineConfig;
  const e = await constructEngine(cfg);
  await e.connect(cfg);
  try { return (await e.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'"))[0]!.n; } finally { await e.disconnect(); }
}

describe('shadow replay end to end', () => {
  test.skipIf(!HAVE_ADDON)('off by default; first night seeds; second night replays on PGLite and Rust without touching the brain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-replay-e2e-'));
    if (PG) await emptyScratch(PG);
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: BUILT, GBRAIN_SHADOW_CHILD: undefined, GBRAIN_SHADOW_CAPTURE: undefined, GBRAIN_SHADOW_REPLAY_POSTGRES_URL: PG }, async () => {
        const config = { engine: 'pglite', database_path: join(home, 'brain.pglite') } as EngineConfig;
        const { saveConfig } = await import('../src/core/config.ts');
        saveConfig(config as never);
        const bare = await createEngine(config);
        await bare.connect(config);
        await bare.initSchema();
        await bare.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'Acme makes widgets.', timeline: '' });
        expect(viewedEngine(bare)).toBe(bare);
        await bare.disconnect();
        const key = shadowBrainKey(config)!;
        const shadowDir = shadowDirFor(key);
        expect(existsSync(captureDir(shadowDir))).toBe(false);

        const lines: string[] = [];
        const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), config: () => config };
        expect(await runEngineShadow(['capture', 'on', '--yes'], io)).toBe(0);
        const deps = (overrides: Partial<Parameters<typeof runNightlyReplay>[0]> = {}) => ({
          ...nightlyDeps({ ...io, now: () => new Date(), brain: { key, dir: shadowDir, engine: 'pglite' }, openPrimary: async () => {
            const e = await constructEngine(config); await e.connect(config); return e;
          } }),
          spawnChild: (runDir: string, env: Record<string, string>) => {
            const proc = Bun.spawn([...CLI, 'engine', 'shadow', '__replay-child', runDir], { env, stdout: 'ignore', stderr: 'inherit' });
            return { exited: proc.exited, kill: () => proc.kill('SIGKILL') };
          },
          ...overrides,
        });
        const first = await runNightlyReplay(deps());
        expect(first.status).toBe('seeded_only');

        const live = await createEngine(config);
        await live.connect(config);
        expect(viewedEngine(live)).not.toBe(live);
        await live.putPage(SECRET.slug, { type: 'person', title: SECRET.title, compiled_truth: SECRET.body, timeline: '' });
        await live.addTag(SECRET.slug, 'nightjar');
        await live.getPage(SECRET.slug);
        await live.searchKeyword('nightjar');
        await live.getTags(SECRET.slug);
        const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');
        await dispatchToolCall(live, 'get_page', { slug: SECRET.slug }, { remote: false, transport: 'stdio' });
        await live.disconnect();
        const cli = Bun.spawnSync([...CLI, 'get', SECRET.slug], { env: { ...process.env, GBRAIN_HOME: home } });
        expect(cli.exitCode).toBe(0);

        const cap = captureDir(shadowDir);
        hmacKey(cap);
        const backup = join(home, 'capture-backup');
        cpSync(cap, backup, { recursive: true });
        let before: Record<string, string> = {};
        let after: Record<string, string> = {};
        const watched = deps({
          spawnChild: (runDir: string, env: Record<string, string>) => {
            before = tree(home);
            const proc = Bun.spawn([...CLI, 'engine', 'shadow', '__replay-child', runDir], { env, stdout: 'ignore', stderr: 'inherit' });
            return { exited: proc.exited.then(c => { after = tree(home); return c; }), kill: () => proc.kill('SIGKILL') };
          },
        });
        const second = await runNightlyReplay(watched);
        expect(second.status).toBe('replayed');
        expect(after).toEqual(before);
        const report = readFileSync(second.report!.replace(/report\.md$/, 'report.json'), 'utf8');
        const summary = readFileSync(second.summary!, 'utf8');
        for (const s of [SECRET.slug, SECRET.title, SECRET.body, 'nightjar', 'zelda']) {
          expect(report.toLowerCase()).not.toContain(s.toLowerCase());
          expect(summary.toLowerCase()).not.toContain(s.toLowerCase());
        }
        expect(JSON.parse(report).counts.replayed).toBeGreaterThan(0);
        expect(JSON.parse(report).counts.ops).toBeGreaterThanOrEqual(2);

        const parsed = JSON.parse(report);
        expect(parsed.arms).toEqual(PG ? ['pglite', 'postgres', 'rust'] : ['pglite', 'rust']);
        expect(parsed.by_class.ts_disagree ?? 0).toBe(0);
        if (PG) {
          // A purge from a process with capture off and the env kill switch set still drops the scratch copy at once.
          expect(await runEngineShadow(['capture', 'off'], io)).toBe(0);
          await withEnv({ GBRAIN_SHADOW_CAPTURE: 'off' }, async () => {
            const purger = await createEngine(config);
            await purger.connect(config);
            expect(await scratchTables(PG)).toBeGreaterThan(0);
            appendPurgeIntent({ request: 'r1', request_id: 'q1', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] });
            await purger.disconnect();
          });
          expect(await scratchTables(PG)).toBe(0);
          return;
        }
        rmSync(cap, { recursive: true, force: true });
        cpSync(backup, cap, { recursive: true });
        const third = await runNightlyReplay(deps());
        expect(third.status).toBe('replayed');
        expect(readFileSync(third.report!.replace(/report\.md$/, 'report.json'), 'utf8')).toBe(report);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);

  test.skipIf(!PG)('a scratch Postgres database that holds tables a replay did not create is refused and left as it was', async () => {
    const { resetScratchPostgres } = await import('../src/shadow/replay-copy.ts');
    const cfg = { engine: 'postgres', database_url: PG } as EngineConfig;
    const e = await constructEngine(cfg);
    await e.connect(cfg);
    try {
      await e.executeRaw('DROP TABLE IF EXISTS gbrain_shadow_replay_owner');
      await e.executeRaw('CREATE TABLE IF NOT EXISTS someone_elses_table (id int)');
      await expect(resetScratchPostgres(e, 'pglite-abc')).rejects.toThrow(/shadow_replay_postgres_not_owned/);
      const [row] = await e.executeRaw<{ present: boolean }>("SELECT to_regclass('public.someone_elses_table') IS NOT NULL AS present");
      expect(row?.present).toBe(true);
    } finally {
      await e.executeRaw('DROP TABLE IF EXISTS someone_elses_table').catch(() => undefined);
      await e.disconnect();
    }
  });
});
