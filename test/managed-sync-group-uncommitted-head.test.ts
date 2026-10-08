/**
 * #6252: a bulk managed-sync group whose head ends without committing while
 * its members are still queued (the head cancelled with cancel_write_request,
 * or settled on its own before its followers published). The members after it
 * never publish ahead of it: they are cancelled, the run reports the head, and
 * the pages are imported once the head is resolved. Runs on PGLite (bulk
 * forced) and, with DATABASE_URL, on Postgres. Synthetic content only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { cancelWriteRequest } from '../src/core/persistence/control.ts';
import { requestPrincipal, type WriteRequest } from '../src/core/persistence/model.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-group-head-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const BULK = { enabled: true, reason: null, size: 4, maxTxnMs: 15_000 };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation.\n`;

beforeAll(async () => {
  if (backends.includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function source(engine: BrainEngine, slugs: string[]) {
  const id = `head-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of slugs) writeFileSync(join(root, `${slug}.md`), note(slug));
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, sync: (extra: Partial<SyncOpts> = {}) => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, ...extra }) };
}

test.each([['one group', false], ['a group admitted ahead in a drain', true]] as const)(
  'a group head cancelled while queued (%s): nothing after it publishes, and the retry imports every page once', (_label, drain) => withEnv(env, async () => {
    for (const engine of engines) {
      try {
        const slugs = Array.from({ length: drain ? 8 : 4 }, (_, i) => `notes/n${i}`);
        const s = await source(engine, slugs);
        const lock = (await acquireWorktree((await getWorktreeBinding(engine, s.id))!))!;
        const stop = new AbortController();
        try {
          await s.sync({ bulk: BULK, ...(drain ? { drainStartedAt: Date.now(), signal: stop.signal,
            onProgress: p => { if (p.phase === 'managed_sync.group_ahead') stop.abort(); } } : {}) });
        } finally { await disposePersistenceConsumer(engine); await lock.release(); }
        const members = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id=$1 AND intent ? 'group' ORDER BY sequence", [s.id]);
        expect(members.length).toBeGreaterThanOrEqual(drain ? 4 : 2);
        expect(members.every(member => member.state === 'queued')).toBe(true);
        expect(await cancelWriteRequest(engine, requestPrincipal(members[0]!), members[0]!.request_id)).toMatchObject({ state: 'cancelled' });
        const blocked = await s.sync({ bulk: BULK });
        expect(blocked).toMatchObject({ status: 'blocked_by_failures', added: 0, managedWrite: { slug: 'notes/n0' } });
        const after = await engine.executeRaw<{ slug: string; state: string }>('SELECT slug,state FROM persistence_requests WHERE id=ANY($1::uuid[]) ORDER BY sequence', [members.map(member => member.id)]);
        expect(after.filter(row => row.state !== 'cancelled').map(row => `${row.slug} ${row.state}`)).toEqual([]);
        for (const member of members) expect(await engine.getPage(member.slug, { sourceId: s.id })).toBeNull();
        const retried = await s.sync({ bulk: BULK, retryFailed: true });
        expect(retried.added).toBeGreaterThanOrEqual(members.length);
        for (const slug of slugs) expect(await engine.getPage(slug, { sourceId: s.id })).not.toBeNull();
      } finally { await disposePersistenceConsumer(engine); }
    }
  }), 180_000);
