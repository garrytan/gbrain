/**
 * Shadow replay end to end: a real PGLite brain under a temporary GBRAIN_HOME, capture through the engine factory,
 * the nightly command seeding real PGLite and Rust copies, and the real `__replay-child` process.
 *
 * Protects: the replay child never reads the parent's working directory (`.env`, `.env.local`, `bunfig.toml` and its
 * preloads), so a provider key there never reaches it (real processes, no Rust addon needed); the first night only seeds; the second seals the recording (the recorder that wrote it has retired) and
 * replays it, and writes a report and a summary that hold no input string; the child never writes the live brain
 * files or config; two replays of the same epoch write byte-identical reports; a purge deletes the recording at once.
 * Serial because it sets GBRAIN_HOME. The Rust arm needs `bun run rust:build`; without it the file skips
 * (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { nightlyDeps, spawnReplayChild } from '../src/commands/engine-shadow-replay.ts';
import { bunSpawn } from '../src/core/spawn.ts';
import { childEnv } from '../src/shadow/replay.ts';
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

describe('shadow replay end to end', () => {
  test('the replay child never loads .env, .env.local or bunfig.toml from the parent\'s working directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-replay-cwd-'));
    try {
      const parentDir = join(root, 'parent');
      const runDir = join(root, 'run');
      mkdirSync(parentDir, { recursive: true });
      mkdirSync(join(runDir, 'home'), { recursive: true });
      // Invented values only: a provider key in each env file, and a preload that marks the process.
      writeFileSync(join(parentDir, '.env'), 'OPENAI_API_KEY=sk-example-not-a-real-key-env\n');
      writeFileSync(join(parentDir, '.env.local'), 'ANTHROPIC_API_KEY=sk-example-not-a-real-key-local\n');
      writeFileSync(join(parentDir, 'preload-marker.ts'), 'process.env.GBRAIN_TEST_PRELOAD_RAN = "1";\n');
      writeFileSync(join(parentDir, 'bunfig.toml'), 'preload = ["./preload-marker.ts"]\n');
      const probe = join(root, 'probe.ts');
      writeFileSync(probe, `import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2]!, JSON.stringify({ env: process.env.OPENAI_API_KEY ?? null, local: process.env.ANTHROPIC_API_KEY ?? null, preload: process.env.GBRAIN_TEST_PRELOAD_RAN ?? null, cwd: process.cwd() }));\n`);
      const out = join(runDir, 'probe.json');
      // The parent runs in the planted directory, as a nightly job started from a project folder would.
      const parent = join(root, 'parent.ts');
      writeFileSync(parent, `import { spawnReplayChild } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'commands', 'engine-shadow-replay.ts'))};
import { bunSpawn } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'core', 'spawn.ts'))};
import { childEnv } from ${JSON.stringify(join(import.meta.dir, '..', 'src', 'shadow', 'replay.ts'))};
const child = spawnReplayChild([process.execPath, ${JSON.stringify(probe)}, ${JSON.stringify(out)}], ${JSON.stringify(runDir)}, childEnv(process.env, ${JSON.stringify(join(runDir, 'home'))}), bunSpawn);
process.exit(await child.exited);\n`);
      const proc = bunSpawn([process.execPath, parent], { cwd: parentDir, env: { PATH: process.env.PATH ?? '' }, stdout: 'pipe', stderr: 'pipe' });
      expect(await proc.exited).toBe(0);
      const seen = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string | null>;
      expect(seen).toMatchObject({ env: null, local: null, preload: null });
      expect(seen.cwd).toBe(join(runDir, 'cwd'));
      void spawnReplayChild; void childEnv;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test.skipIf(!HAVE_ADDON)('off by default; first night seeds; second night replays on PGLite and Rust without touching the brain', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-replay-e2e-'));
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: BUILT, GBRAIN_SHADOW_CHILD: undefined, GBRAIN_SHADOW_CAPTURE: undefined, GBRAIN_SHADOW_REPLAY_POSTGRES_URL: undefined }, async () => {
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
          spawnChild: (runDir: string, env: Record<string, string>) => spawnReplayChild([...CLI, 'engine', 'shadow', '__replay-child', runDir], runDir, env, bunSpawn),
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
            const child = spawnReplayChild([...CLI, 'engine', 'shadow', '__replay-child', runDir], runDir, env, bunSpawn);
            return { exited: child.exited.then(c => { after = tree(home); return c; }), kill: child.kill };
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
        expect(parsed.arms).toEqual(['pglite', 'rust']);
        rmSync(cap, { recursive: true, force: true });
        cpSync(backup, cap, { recursive: true });
        const third = await runNightlyReplay(deps());
        expect(third.status).toBe('replayed');
        expect(readFileSync(third.report!.replace(/report\.md$/, 'report.json'), 'utf8')).toBe(report);

        // A purge from a process with capture off and the env kill switch set still deletes the recording at once.
        const liveEpoch = readEpoch(cap)!.id;
        expect(existsSync(epochDir(cap, liveEpoch))).toBe(true);
        expect(await runEngineShadow(['capture', 'off'], io)).toBe(0);
        await withEnv({ GBRAIN_SHADOW_CAPTURE: 'off' }, async () => {
          const purger = await createEngine(config);
          await purger.connect(config);
          appendPurgeIntent({ request: 'r1', request_id: 'q1', source_id: 'default', source_incarnation: 'i', scope: 'page', purge_epoch: 1, facts: [], takes: [], lifetimes: [] });
          await purger.disconnect();
        });
        expect(existsSync(epochDir(cap, liveEpoch))).toBe(false);
        expect(existsSync(basesDir(cap, liveEpoch))).toBe(false);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 300_000);


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
});
