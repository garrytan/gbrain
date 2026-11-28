/**
 * GBRA-133 (PR 2b): a single-source CLI sync reads the rows that choose its route once, before the drain lease
 * (src/core/sync-dispatch-read.ts): the source resolver, the company profile, the persistence mode, the content-directory
 * anchor and the connector check share one routing row instead of reading the source and the mode in turn. Reads under
 * the lease stay live. Both backends; test/e2e/sync-dispatch-read-gbra133-postgres.test.ts runs the Postgres arm.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { runSync } from '../src/commands/sync.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { MANAGED_MODE_SQL } from '../src/core/persistence/managed-mode.ts';
import { freshBrainFactory } from './helpers/persistence-request-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { endSyncDispatchRead, syncDispatchRow, withSyncDispatchRead } from '../src/core/sync-dispatch-read.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The drain lease holder record write, as recorded: the typed member sends its statement below executeRaw. */
const LEASE_WRITE = 'writeDrainLeaseHolder()';

const TYPED_PROFILE_READS = ['readSourceIncarnation', 'hasCompanyBrainReceipt'] as const;

/**
 * The statements the engine's top-level executeRaw sends while `fn` runs, whitespace-normalized, with the drain lease's
 * holder record write (BrainEngine writeDrainLeaseHolder) recorded in its place as LEASE_WRITE, and each typed profile
 * read recorded by name.
 */
async function recordStatements(engine: BrainEngine, fn: () => Promise<unknown>): Promise<string[]> {
  const sent: string[] = [];
  const target = engine as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const original = target.executeRaw!, writeHolder = target.writeDrainLeaseHolder!;
  target.executeRaw = function (this: unknown, ...args: unknown[]) {
    sent.push(String(args[0]).replace(/\s+/g, ' ').trim());
    return original.apply(this, args);
  };
  target.writeDrainLeaseHolder = function (this: unknown, ...args: unknown[]) {
    sent.push(LEASE_WRITE);
    return writeHolder.apply(this, args);
  };
  // The company profile's own reads are typed members (company-brain/profile.ts), so each call is recorded by name.
  for (const name of TYPED_PROFILE_READS) {
    const typed = target[name]!;
    target[name] = function (this: unknown, ...args: unknown[]) { sent.push(name); return typed.apply(this, args); };
  }
  try { await fn(); return sent; }
  finally { delete target.executeRaw; delete target.writeDrainLeaseHolder; for (const name of TYPED_PROFILE_READS) delete target[name]; }
}

/** Each routing read the run sent before it took the drain lease (the lease holder record). */
function routingReads(sent: string[]) {
  const lease = sent.indexOf(LEASE_WRITE);
  const before = lease < 0 ? sent : sent.slice(0, lease), under = lease < 0 ? [] : sent.slice(lease);
  const count = (match: (sql: string) => boolean) => before.filter(match).length;
  return {
    leaseTaken: lease >= 0,
    modeReadLiveUnderLease: under.some(sql => sql.startsWith('SELECT') && sql.endsWith('FROM persistence_brain WHERE singleton=1')),
    resolver: count(sql => sql === 'SELECT id FROM sources WHERE id = $1 AND archived = false'),
    profile: count(sql => sql === 'SELECT config,incarnation FROM sources WHERE id=$1' || (TYPED_PROFILE_READS as readonly string[]).includes(sql)),
    mode: count(sql => sql === MANAGED_MODE_SQL),
    anchor: count(sql => sql === 'SELECT local_path AS value FROM sources WHERE id = $1'),
    connector: count(sql => sql === 'SELECT local_path,config FROM sources WHERE id=$1'),
    routingRow: count(sql => sql.includes('FROM (SELECT $1::text AS want) w LEFT JOIN sources s')),
  };
}

const databaseUrl = process.env.DATABASE_URL;

for (const kind of testBackends()) {
  describe('GBRA-133 routing reads of a CLI sync (' + kind + ')', () => {
    let factory: Awaited<ReturnType<typeof freshBrainFactory>>;
    let home: string;
    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'gbrain-dispatch-read-'));
      factory = await freshBrainFactory(kind, databaseUrl);
    }, 120_000);
    afterAll(async () => {
      await factory?.dispose();
      if (home) rmSync(home, { recursive: true, force: true });
    });

    async function managedSource(engine: BrainEngine): Promise<string> {
      const id = 'route-' + randomUUID().slice(0, 12), root = join(home, id);
      mkdirSync(root); git(root, 'init', '-q');
      for (const name of ['alice-example', 'acme-example']) writeFileSync(join(root, name + '.md'), '---\ntitle: ' + name + '\n---\nA durable observation about ' + name + '.\n');
      git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
      await claimWorktree(engine, id, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await performSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, drain: true, drainHolder: { kind: 'cli', id: null } });
      return id;
    }

    test('one routing row answers the resolver, the profile, the mode, the anchor and the connector check before the lease, and the mode stays a live read under it', async () => {
      const engine = await factory.fresh();
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, GBRAIN_SYNC_NO_DELEGATE: '1' }, async () => {
        try {
          const id = await managedSource(engine);
          const sent = await recordStatements(engine, () => runSync(engine, ['--source', id, '--no-pull', '--no-embed']));
          expect(routingReads(sent)).toEqual({ leaseTaken: true, modeReadLiveUnderLease: true, resolver: 0, profile: 0, mode: 0, anchor: 0, connector: 0, routingRow: 1 });
          const [row] = await engine.executeRaw<{ synced: boolean }>('SELECT last_sync_at IS NOT NULL AS synced FROM sources WHERE id=$1', [id]);
          expect(row?.synced).toBe(true);
        } finally { await disposePersistenceConsumer(engine); }
      });
    }, 180_000);

    test('the scope shares one read per source until it ends, and every read after the end is live', async () => {
      const engine = await factory.fresh();
      const sent = await recordStatements(engine, () => withSyncDispatchRead(engine, async () => {
        const [first, again] = await Promise.all([syncDispatchRow(engine, 'default'), syncDispatchRow(engine, 'default')]);
        expect(first).toBe(again);
        expect(first?.id).toBe('default');
        endSyncDispatchRead();
        expect(syncDispatchRow(engine, 'default')).toBeUndefined();
      }));
      expect(sent.filter(sql => sql.includes('LEFT JOIN sources s'))).toHaveLength(1);
      expect(syncDispatchRow(engine, 'default')).toBeUndefined();
    }, 60_000);
  });
}
