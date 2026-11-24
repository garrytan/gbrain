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
import { basesDir, epochDir, readEpoch } from '../src/shadow/capture.ts';
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
  const cfg = { engine: 'postgres', database_url: url, poolSize: 1 } as EngineConfig;
  const e = await constructEngine(cfg);
  await e.connect(cfg);
  try { await e.executeRaw('DROP SCHEMA IF EXISTS public CASCADE'); await e.executeRaw('CREATE SCHEMA public'); } finally { await e.disconnect(); }
}

async function scratchTables(url: string): Promise<number> {
  const cfg = { engine: 'postgres', database_url: url, poolSize: 1 } as EngineConfig;
  const e = await constructEngine(cfg);
  await e.connect(cfg);
  try { return (await e.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'"))[0]!.n; } finally { await e.disconnect(); }
}

describe('shadow replay end to end', () => {
  test('capture is off by default, and turning it on makes engines record (real PGLite, no Rust addon needed)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-replay-off-'));
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_SHADOW_CHILD: undefined, GBRAIN_SHADOW_CAPTURE: undefined }, async () => {
        const config = { engine: 'pglite', database_path: join(home, 'brain.pglite') } as EngineConfig;
        const { saveConfig } = await import('../src/core/config.ts');
        saveConfig(config as never);
        const bare = await createEngine(config);
        await bare.connect(config);
        await bare.initSchema();
        expect(viewedEngine(bare)).toBe(bare);
        await bare.disconnect();
        const key = shadowBrainKey(config)!;
        expect(existsSync(captureDir(shadowDirFor(key)))).toBe(false);
        expect(await runEngineShadow(['capture', 'on', '--yes'], { out: () => {}, err: () => {}, config: () => config })).toBe(0);
        const recording = await createEngine(config);
        await recording.connect(config);
        expect(viewedEngine(recording)).not.toBe(recording);
        await recording.disconnect();
        await withEnv({ GBRAIN_SHADOW_CAPTURE: 'off' }, async () => {
          const killed = await createEngine(config);
          await killed.connect(config);
          expect(viewedEngine(killed)).toBe(killed);
          await killed.disconnect();
        });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);

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
        await live.disconnect();

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
        // The replayed epoch is retired; the next recording epoch stays in place.
        expect(existsSync(epochDir(cap, readEpoch(cap)!.id))).toBe(true);
        expect(after).toEqual(before);
        const report = readFileSync(second.report!.replace(/report\.md$/, 'report.json'), 'utf8');
        const summary = readFileSync(second.summary!, 'utf8');
        for (const s of [SECRET.slug, SECRET.title, SECRET.body, 'nightjar', 'zelda']) {
          expect(report.toLowerCase()).not.toContain(s.toLowerCase());
          expect(summary.toLowerCase()).not.toContain(s.toLowerCase());
        }
        expect(JSON.parse(report).counts.replayed).toBeGreaterThan(0);

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
    const cfg = { engine: 'postgres', database_url: PG, poolSize: 1 } as EngineConfig;
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

  test.skipIf(!PG)('a purge drops the scratch copy through its own connection, even when this process holds the brain on Postgres', async () => {
    const { captureDir: capDir } = await import('../src/shadow/capture-state.ts');
    const { dropScratchPostgres, scratchRecordPath } = await import('../src/shadow/capture.ts');
    const { writePrivateJson } = await import('../src/shadow/capture-state.ts');
    const primaryUrl = PG!.replace(/\/[^/?]+(\?|$)/, '/replay_primary_probe$1');
    const admin = { engine: 'postgres', database_url: PG, poolSize: 1 } as EngineConfig;
    const a = await constructEngine(admin);
    await a.connect(admin);
    await a.executeRaw('DROP DATABASE IF EXISTS replay_primary_probe').catch(() => undefined);
    await a.executeRaw('CREATE DATABASE replay_primary_probe');
    await a.disconnect();
    const primaryCfg = { engine: 'postgres', database_url: primaryUrl } as EngineConfig;
    const primary = await constructEngine(primaryCfg); // the module singleton, as a Postgres brain uses it
    await primary.connect(primaryCfg);
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-replay-pg-'));
    try {
      await primary.executeRaw('CREATE TABLE brain_rows (id int)');
      await emptyScratch(PG!);
      const s = { engine: 'postgres', database_url: PG, poolSize: 1 } as EngineConfig;
      const sc = await constructEngine(s);
      await sc.connect(s);
      await sc.executeRaw('CREATE TABLE gbrain_shadow_replay_owner (brain TEXT PRIMARY KEY)');
      await sc.executeRaw("INSERT INTO gbrain_shadow_replay_owner VALUES ('pglite-abc')");
      await sc.executeRaw('CREATE TABLE copy_rows (id int)');
      await sc.disconnect();
      const cap = capDir(dir);
      writePrivateJson(scratchRecordPath(cap), { url: PG, brain: 'pglite-abc', verified: true });
      expect(await dropScratchPostgres(cap)).toBe(true);
      const [row] = await primary.executeRaw<{ present: boolean }>("SELECT to_regclass('public.brain_rows') IS NOT NULL AS present");
      expect(row?.present).toBe(true);
      expect(await scratchTables(PG!)).toBe(0);
    } finally {
      await primary.disconnect();
      rmSync(dir, { recursive: true, force: true });
      const c = await constructEngine(admin);
      await c.connect(admin);
      await c.executeRaw('DROP DATABASE IF EXISTS replay_primary_probe').catch(() => undefined);
      await c.disconnect();
    }
  });

  test.skipIf(!PG)('the replay child refuses a Postgres arm that is not this brain\'s seeded copy', async () => {
    const { openReplayArm } = await import('../src/commands/engine-shadow-replay.ts');
    await emptyScratch(PG!);
    await withEnv({ GBRAIN_SHADOW_REPLAY_POSTGRES_URL: PG }, async () => {
      const spec = { brain_key: 'pglite-abc', arms: { pglite: '', rust: '', postgres: { url_env: 'GBRAIN_SHADOW_REPLAY_POSTGRES_URL' } } } as never;
      await expect(openReplayArm('postgres', spec)).rejects.toThrow(/shadow_replay_postgres_not_owned/);
    });
  });

  test.skipIf(!PG)('a scratch database that holds only a materialized view is still refused and left as it was', async () => {
    const { resetScratchPostgres } = await import('../src/shadow/replay-copy.ts');
    await emptyScratch(PG!);
    const cfg = { engine: 'postgres', database_url: PG, poolSize: 1 } as EngineConfig;
    const e = await constructEngine(cfg);
    await e.connect(cfg);
    try {
      await e.executeRaw('CREATE MATERIALIZED VIEW someone_elses_view AS SELECT 1 AS n');
      await expect(resetScratchPostgres(e, 'pglite-abc')).rejects.toThrow(/shadow_replay_postgres_not_owned/);
      const [row] = await e.executeRaw<{ present: boolean }>("SELECT to_regclass('public.someone_elses_view') IS NOT NULL AS present");
      expect(row?.present).toBe(true);
    } finally {
      await e.disconnect();
      await emptyScratch(PG!);
    }
  });

  test.skipIf(!HAVE_ADDON)('copies get the brain\'s own embedding layout, not this process\'s default', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-replay-dims-'));
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: BUILT, GBRAIN_SHADOW_CHILD: undefined, GBRAIN_SHADOW_CAPTURE: undefined, GBRAIN_SHADOW_REPLAY_POSTGRES_URL: undefined }, async () => {
        const config = { engine: 'pglite', database_path: join(home, 'brain.pglite') } as EngineConfig;
        const { saveConfig } = await import('../src/core/config.ts');
        saveConfig(config as never);
        const bare = await constructEngine(config);
        await bare.connect(config);
        await (bare.initSchema as (o: object) => Promise<void>).call(bare, { embedding: { dimensions: 768, model: 'example-embedding-768' } });
        await bare.putPage('notes/vector-example', { type: 'note', title: 'Vector example', compiled_truth: 'One chunk with a 768 vector.', timeline: '' });
        await bare.upsertChunks('notes/vector-example', [{ chunk_index: 0, chunk_text: 'One chunk with a 768 vector.', chunk_source: 'compiled_truth',
          embedding: new Float32Array(768).fill(0.01), model: 'example-embedding-768', token_count: 6 }]);
        await bare.disconnect();
        const key = shadowBrainKey(config)!;
        const shadowDir = shadowDirFor(key);
        const io = { out: () => {}, err: () => {}, config: () => config };
        expect(await runEngineShadow(['capture', 'on', '--yes'], io)).toBe(0);
        const deps = nightlyDeps({ ...io, now: () => new Date(), brain: { key, dir: shadowDir, engine: 'pglite' }, openPrimary: async () => {
          const e = await constructEngine(config); await e.connect(config); return e;
        } });
        expect((await runNightlyReplay(deps)).status).toBe('seeded_only');
        const copyPath = join(basesDir(captureDir(shadowDir), readEpoch(captureDir(shadowDir))!.id), 'pglite');
        const copyCfg = { engine: 'pglite', database_path: copyPath } as EngineConfig;
        const copy = await constructEngine(copyCfg);
        await copy.connect(copyCfg);
        try {
          const { readStoredEmbeddingIdentity } = await import('../src/core/stored-embedding-identity.ts');
          expect((await readStoredEmbeddingIdentity(copy))?.dimensions).toBe(768);
          const [col] = await copy.executeRaw<{ t: string }>("SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a WHERE a.attrelid = 'content_chunks'::regclass AND a.attname = 'embedding'");
          expect(col?.t).toBe('vector(768)');
          const [n] = await copy.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM content_chunks WHERE embedding IS NOT NULL');
          expect(n?.n).toBe(1);
        } finally { await copy.disconnect(); }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);

  test.skipIf(!PG)('a scratch database with objects in another schema is refused, and a purge never cascades into them', async () => {
    const { resetScratchPostgres } = await import('../src/shadow/replay-copy.ts');
    const { dropScratchPostgres, scratchRecordPath, scratchPendingPath } = await import('../src/shadow/capture.ts');
    const { writePrivateJson, captureDir: capDir } = await import('../src/shadow/capture-state.ts');
    await emptyScratch(PG!);
    const cfg = { engine: 'postgres', database_url: PG, poolSize: 1 } as EngineConfig;
    const e = await constructEngine(cfg);
    await e.connect(cfg);
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-replay-schema-'));
    try {
      await e.executeRaw('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
      await e.executeRaw('CREATE SCHEMA IF NOT EXISTS other_app');
      await e.executeRaw('CREATE TABLE other_app.documents (id int, embedding public.vector(3))');
      await e.executeRaw("INSERT INTO other_app.documents VALUES (1, '[1,2,3]')");
      await expect(resetScratchPostgres(e, 'pglite-abc')).rejects.toThrow(/shadow_replay_postgres_not_owned/);
      // Even with this brain's owner marker, neither the nightly reset nor a purge cascades into other_app.
      await e.executeRaw('CREATE TABLE gbrain_shadow_replay_owner (brain TEXT PRIMARY KEY)');
      await e.executeRaw("INSERT INTO gbrain_shadow_replay_owner VALUES ('pglite-abc')");
      await expect(resetScratchPostgres(e, 'pglite-abc')).rejects.toThrow(/shadow_replay_postgres_not_owned/);
      const cap = capDir(dir);
      writePrivateJson(scratchRecordPath(cap), { url: PG, brain: 'pglite-abc', verified: true });
      expect(await dropScratchPostgres(cap)).toBe(false);
      const [row] = await e.executeRaw<{ n: number }>('SELECT count(embedding)::int AS n FROM other_app.documents');
      expect(row?.n).toBe(1);
      void scratchPendingPath;
    } finally {
      await e.executeRaw('DROP SCHEMA IF EXISTS other_app CASCADE').catch(() => undefined);
      await e.disconnect();
      rmSync(dir, { recursive: true, force: true });
      await emptyScratch(PG!);
    }
  });

  test.skipIf(!PG)('a domain in another schema that depends on public is refused, and a purge never cascades into it', async () => {
    const { resetScratchPostgres } = await import('../src/shadow/replay-copy.ts');
    const { dropScratchPostgres, scratchRecordPath } = await import('../src/shadow/capture.ts');
    const { writePrivateJson, captureDir: capDir } = await import('../src/shadow/capture-state.ts');
    await emptyScratch(PG!);
    const cfg = { engine: 'postgres', database_url: PG, poolSize: 1 } as EngineConfig;
    const e = await constructEngine(cfg);
    await e.connect(cfg);
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-replay-domain-'));
    try {
      await e.executeRaw('CREATE EXTENSION IF NOT EXISTS vector SCHEMA public');
      await e.executeRaw('CREATE SCHEMA IF NOT EXISTS other_app');
      await e.executeRaw('CREATE DOMAIN other_app.embedding AS public.vector(3)');
      await expect(resetScratchPostgres(e, 'pglite-abc')).rejects.toThrow(/shadow_replay_postgres_not_owned/);
      await e.executeRaw('CREATE TABLE gbrain_shadow_replay_owner (brain TEXT PRIMARY KEY)');
      await e.executeRaw("INSERT INTO gbrain_shadow_replay_owner VALUES ('pglite-abc')");
      const cap = capDir(dir);
      writePrivateJson(scratchRecordPath(cap), { url: PG, brain: 'pglite-abc', verified: true });
      expect(await dropScratchPostgres(cap)).toBe(false);
      const [row] = await e.executeRaw<{ present: boolean }>("SELECT to_regtype('other_app.embedding') IS NOT NULL AS present");
      expect(row?.present).toBe(true);
    } finally {
      await e.executeRaw('DROP SCHEMA IF EXISTS other_app CASCADE').catch(() => undefined);
      await e.disconnect();
      rmSync(dir, { recursive: true, force: true });
      await emptyScratch(PG!);
    }
  });
});
