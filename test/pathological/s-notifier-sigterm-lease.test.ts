/**
 * GBRA-133 2b-d2: a resident stopped by SIGTERM hands the host's commit notifier over at once.
 *
 * Before: stdio `foresights serve` on SIGTERM ran the generic cleanup pass and exited 143 while its own graceful shutdown
 * (which stops the notifier and releases the lease) was still starting, so the Postgres lease row stayed live until it
 * expired (two heartbeats, 20 s by default) and the next resident neither owned the notifier nor synced a commit until
 * then. Now the notifier registers a cleanup that releases the lease first. A SIGKILL still waits for expiry; lease
 * TTLs are unchanged.
 *
 * Protects (real `foresights serve` processes): after a SIGTERM the lease is released (Postgres; PGLite has no lease row,
 * its lock holder owns), and a second resident owns the notifier and syncs a new commit while the first resident's
 * lease, stretched to 120 s here, would still be live. PGLite always, Postgres when DATABASE_URL is set (e2e twin).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { EngineConfig } from '../../src/core/types.ts';
import { createEngine } from '../../src/core/engine-factory.ts';
import { performSync } from '../../src/commands/sync.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';
import { record } from './s-blockers-fixture.ts';

const CLI = resolve(import.meta.dir, '../../src/cli.ts');
const SOURCE = 'leasecase';
const HEARTBEAT_MS = 60_000;
const md = (title: string) => '---\ntitle: ' + title + '\ntype: note\n---\nThe ' + title + ' note.\n';

interface Resident { pid: number; spawnedAt: number; lines: Array<{ at: number; text: string }>; exited: Promise<number>; kill(signal: NodeJS.Signals): void }

function startServe(env: Record<string, string>): Resident {
  const spawnedAt = performance.now();
  const child = Bun.spawn([process.execPath, CLI, 'serve'], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const lines: Resident['lines'] = [];
  void (async () => {
    let buf = '';
    for await (const chunk of child.stderr) {
      buf += new TextDecoder().decode(chunk);
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { lines.push({ at: performance.now(), text: buf.slice(0, i) }); buf = buf.slice(i + 1); }
    }
  })();
  return { pid: child.pid, spawnedAt, lines, exited: child.exited, kill: signal => child.kill(signal) };
}

async function waitLine(r: Resident, pattern: RegExp, timeoutMs: number, after = 0): Promise<number | null> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const hit = r.lines.find(line => line.at >= after && pattern.test(line.text));
    if (hit) return hit.at;
    if (performance.now() > deadline) return null;
    await Bun.sleep(50);
  }
}

describe('GBRA-133 2b-d2: SIGTERM releases the commit notifier lease', () => {
  for (const { backend, databaseUrl } of pathologicalArms()) {
    test(`a second resident owns the notifier and syncs a commit right after the first gets SIGTERM (${backend})`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-sigterm-lease-'));
      const repo = join(home, 'repo');
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args], { encoding: 'utf8' }).trim();
      const pg = databaseUrl ? await isolatedPersistencePostgres(databaseUrl) : null;
      const dbConfig: EngineConfig = pg ? { engine: 'postgres', database_url: pg.databaseUrl } : { engine: 'pglite', database_path: join(home, 'brain.pglite') };
      // The residents' own config, through the production factory; each handle is disconnected where it is opened.
      const open = async (): Promise<BrainEngine> => {
        const engine = await createEngine(dbConfig);
        await engine.connect(dbConfig);
        return engine;
      };
      const residents: Resident[] = [];
      try {
        if (pg) await pg.engine.disconnect();
        mkdirSync(join(home, '.gbrain'), { recursive: true });
        writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify(dbConfig));
        mkdirSync(join(repo, 'notes'), { recursive: true });
        git('init', '-q', '-b', 'main');
        writeFileSync(join(repo, 'notes/first.md'), md('first'));
        git('add', '-A'); git('commit', '-qm', 'first');
        const env: Record<string, string> = { ...process.env as Record<string, string>, GBRAIN_HOME: home, GBRAIN_NOTIFIER_CLASSIC_SOURCES: SOURCE,
          GBRAIN_NOTIFIER_HEARTBEAT_MS: String(HEARTBEAT_MS), GBRAIN_NOTIFIER_POLL_MS: '1000', GBRAIN_NOTIFIER_QUIET_MS: '0' };
        for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'GEMINI_API_KEY']) delete env[key];

        await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const engine = await open();
          try {
            await engine.initSchema();
            await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [SOURCE, repo]);
            await engine.setConfig('sync.on_commit', 'true');
            await performSync(engine, { sourceId: SOURCE, repoPath: repo, noPull: true, noEmbed: true, noExtract: true });
          } finally { await engine.disconnect(); }
        });

        const first = startServe(env); residents.push(first);
        expect(await waitLine(first, /owner of this host's notifier/, 60_000)).not.toBeNull();
        first.kill('SIGTERM');
        await first.exited;

        const lease = await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const engine = await open();
          try { return await engine.executeRaw<{ pid: number; live: boolean }>('SELECT pid, expires_at > now() AS live FROM sync_notifier_leases'); }
          finally { await engine.disconnect(); }
        });
        // Postgres: the SIGTERMed owner's row is released. PGLite writes no lease row (the lock holder owns).
        expect(lease.map(row => ({ pid: Number(row.pid), live: row.live }))).toEqual(pg ? [{ pid: first.pid, live: false }] : []);

        const second = startServe(env); residents.push(second);
        // The first resident's lease (two 60 s heartbeats) would still be live for two minutes; owning within one
        // means the SIGTERM handed it over.
        const ownedAt = await waitLine(second, /owner of this host's notifier/, 60_000);
        expect(ownedAt).not.toBeNull();
        writeFileSync(join(repo, 'notes/second.md'), md('second'));
        git('add', '-A'); git('commit', '-qm', 'second');
        const committedAt = performance.now();
        const syncedAt = await waitLine(second, /done job=\S+ status=synced/, 60_000, committedAt);
        record({ case: '2b-d2-sigterm-lease', backend, owner_ms: ownedAt === null ? null : Math.round(ownedAt - second.spawnedAt),
          commit_to_synced_ms: syncedAt === null ? null : Math.round(syncedAt - committedAt) });
        expect(syncedAt).not.toBeNull();
        second.kill('SIGTERM');
        await second.exited;

        const page = await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
          const engine = await open();
          try { return await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND slug='notes/second' AND deleted_at IS NULL", [SOURCE]); }
          finally { await engine.disconnect(); }
        });
        expect(page).toHaveLength(1);
      } finally {
        for (const r of residents) { try { r.kill('SIGKILL'); } catch { /* exited */ } await r.exited.catch(() => undefined); }
        if (pg) await pg.close().catch(() => undefined);
        rmSync(home, { recursive: true, force: true });
      }
    }, 240_000);
  }
});
