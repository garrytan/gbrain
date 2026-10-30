/**
 * #7243 item 6: a serve-owned managed pass printed no phase line before its import walk, so a long walk looked dead.
 * The resident notifier's background run (notifier/resident.ts runnerStart, the path serve, serve-http, jobs work and the
 * autopilot daemon take) ran with its human lines routed to the job's line buffer only, and the pass emitted nothing
 * between its start and the first committed page. Now each round prints "[sync] pass round N: read ..." after its level
 * read and "... importing N file(s) ..." before its import walk, and a run nobody polls also writes its lines to the
 * serve log ("[serve-sync] job=<id> ..."). Red on master, on PGLite and on Postgres (test/postgres-unit-arms.txt).
 * Serial: the delegated-sync runner is process-wide.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { runnerStart } from '../src/core/notifier/resident.ts';
import { __resetDelegatedSyncForTests, getDelegatedSyncStatus, isDelegatedSyncRunning } from '../src/core/serve-sync-runner.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-phase-7243-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (name: string) => `---\ntitle: ${name}\n---\n${name} keeps the acme-example ledger.\n`;

beforeAll(async () => {
  __resetDelegatedSyncForTests();
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterEach(() => { __resetDelegatedSyncForTests(); });
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function until(what: string, fn: () => Promise<boolean> | boolean, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

test('a resident-started managed pass prints its round phase lines before the import walk, in the job lines and the serve log', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const id = `ph-${randomUUID().replace(/-/g, '').slice(0, 16)}`, root = join(home, id);
    mkdirSync(root); git(root, 'init', '-q');
    writeFileSync(join(root, 'alice-example.md'), note('Alice'));
    git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'fixture');
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
    await claimWorktree(engine, id, root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect((await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true })).status).toBe('first_sync');
    for (const name of ['bob-example', 'carol-example', 'dave-example']) writeFileSync(join(root, `${name}.md`), note(name));
    git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'three more');

    const logged: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { logged.push(String(chunk)); return (write as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
    let jobId: string;
    try {
      const started = await runnerStart(engine).startSync(id, { intent: 'freshness' } as never);
      jobId = (started as { jobId?: string }).jobId!;
      expect(typeof jobId).toBe('string');
      await until('the resident run to end', () => !isDelegatedSyncRunning());
    } finally { process.stderr.write = write; }
    const status = getDelegatedSyncStatus(jobId!);
    expect(status).toMatchObject({ ok: true, state: 'done' });
    const lines = (status.lines ?? []).map(line => line.text);
    const level = lines.findIndex(line => /^\[sync\] pass round 1: read \d+ path\(s\) at [0-9a-f]{8} in /.test(line));
    const admit = lines.findIndex(line => line.startsWith('[sync] pass round 1: importing 3 file(s) and deleting 0 page(s)'));
    expect(level).toBeGreaterThanOrEqual(0);
    expect(admit).toBeGreaterThan(level);
    // Both phase lines come before the first line of the import walk itself.
    const walk = lines.findIndex(line => line.startsWith('[sync] managed catch-up:') || /^\[sync\] \d+\/\d+ processed/.test(line));
    if (walk >= 0) expect(walk).toBeGreaterThan(admit);
    // Nobody polls a resident's run: its lines also reach the serve log.
    const serveLog = logged.join('');
    expect(serveLog).toContain(`[serve-sync] job=${jobId!} [sync] pass round 1: read `);
    expect(serveLog).toContain(`[serve-sync] job=${jobId!} [sync] pass round 1: importing 3 file(s)`);
  }
}), 300_000);
