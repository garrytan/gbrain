/**
 * The page purge's engine surface is one explicit list (src/core/persistence/purge-path-members.ts), and the pre-write
 * check is derived only from it. This test runs the purge through a recording engine proxy and fails when
 *   - the purge calls an engine member that is not on the list (a new purge-path call cannot slip past the check),
 *   - the purge reaches a raw-SQL site that is not on the list,
 *   - a listed member is not served on all three engines and the list does not mark it as a known stop with an owner,
 *   - an entry still marked as a stop is in fact served now (the lane that serves it removes the mark).
 * It runs on PGLite: the proxy records what the purge calls, which does not depend on the engine.
 *
 * Scenarios (each purges through delete_page --purge, or the retention purge): a page with a link and an alias; a page
 * with a facts fence, a take, a take proposal, an open loop, a core edit notice, a file and a version; a page with a
 * belief ledger; a retention purge of an expired tombstone in a worktree-bound source; an origin whose derived page it
 * labelled private and one it could not (the parked, held branch).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';
import { rustMemberCapability } from '../src/core/rust-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { purgeDeletedPagesCoordinated } from '../src/core/persistence/purge-deleted.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { PURGE_OWNERS, PURGE_PATH, purgeEntryName, purgePathStops, requirePurgePathServed, type PurgePathEntry } from '../src/core/persistence/purge-path-members.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';
import { beliefBrain, beliefPage } from './helpers/belief-ledger.ts';

const RAW_PRIMITIVES = ['executeRaw', 'executeRawDirect', 'withReservedConnection', 'keywordBoundedRead'];
const members = new Set<string>();
const sites = new Set<string>();

/** Wraps `engine` (and the transaction handles it hands out) so every member call and every raw-SQL call site is recorded. */
function recording<T extends object>(engine: T): T {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        if (RAW_PRIMITIVES.includes(prop)) sites.add(rawSite(new Error().stack ?? ''));
        else members.add(prop);
        if ((prop === 'transaction' || prop === 'transactionDirect') && typeof args[0] === 'function') {
          const fn = args[0] as (tx: object) => unknown;
          args = [(tx: object) => fn(recording(tx)), ...args.slice(1)];
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** The first frame in src/ that is not an engine file, as `function (file under src/core)`. */
function rawSite(stack: string): string {
  const frame = stack.split('\n').find(line => line.includes('/src/') && !/\/(pglite|postgres)-engine/.test(line)) ?? '';
  const match = /at (?:async )?(.*?) ?\(?[^\s()]*\/src\/core\/([^:]+):\d+:\d+\)?$/.exec(frame.trim());
  return match ? `${match[1] || '<anonymous>'} (${match[2]})` : frame.trim();
}

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const page = (title: string, frontmatter: string[], body: string) => ['---', `title: ${title}`, 'type: note', ...frontmatter, '---', `# ${title}`, '', body].join('\n');
const contextOf = (engine: object, extra: Record<string, unknown> = {}) =>
  ({ engine, config: { engine: 'pglite', embedding_disabled: true }, logger: quiet, dryRun: false, remote: false, sourceId: 'default', ...extra }) as unknown as OperationContext;
// One engine per scenario that opens one (four), made up front so each scenario starts on an empty brain.
const engines: PGLiteEngine[] = [];
const unused: PGLiteEngine[] = [];
beforeAll(async () => {
  for (let i = 0; i < 4; i++) {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    engines.push(engine);
    unused.push(engine);
  }
}, 120_000);
afterAll(async () => { for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined); });
const freshEngine = async () => unused.shift()!;

describe('the purge path calls only what the list names', () => {
  test('a page with a link and an alias, and a page with every purged store', async () => {
    const home = mkdtempSync(join(tmpdir(), 'purge-path-'));
    const storage = join(home, 'storage');
    mkdirSync(storage);
    const base = await freshEngine();
    const ctx = contextOf(base, { config: { engine: 'pglite', embedding_disabled: true, storage: { backend: 'local', bucket: 'b', localPath: storage } } });
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await operationsByName.put_page!.handler(ctx, { slug: 'notes/keeper', content: page('keeper', [], 'Keeper.'), request_id: randomUUID() });
        await operationsByName.put_page!.handler(ctx, { slug: 'notes/doomed', content: page('doomed', ['aliases: [Old Harbor]'], 'First.'), request_id: randomUUID() });
        await base.addLink('notes/doomed', 'notes/keeper', 'x', 'mentions');
        const doomed = await base.readPageSnapshot('notes/doomed', { sourceId: 'default' });
        await disposePersistenceConsumer(base);
        const basic = await operationsByName.delete_page!.handler({ ...ctx, engine: recording(base) } as OperationContext, { slug: 'notes/doomed', purge: true, request_id: randomUUID(), expected_revision: doomed?.revision }) as { status: string };
        expect(basic.status).toBe('purged');
        await disposePersistenceConsumer(base);

        const slug = 'notes/leaked-key';
        const content = `---\ntitle: Leaked key\ntype: note\n---\n# Leaked key\n\nThe key is AKIA-EXAMPLE-NOT-REAL.\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|-------------|-------------|--------|---------|\n| 1 | Deploy key lives in vault-a | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |\n<!--- gbrain:facts:end -->\n`;
        await importFromContent(base, slug, content, { noEmbed: true, sourceId: 'default' });
        await runExtractFacts(base, { slugs: [slug] });
        const [row] = await base.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1', [slug]);
        mkdirSync(join(storage, 'notes'), { recursive: true });
        writeFileSync(join(storage, 'notes/leaked.png'), 'blob-bytes');
        await base.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
          await tx.createVersion(slug, { sourceId: 'default' });
          await tx.executeRaw(`INSERT INTO takes(page_id,row_num,claim,kind,holder) VALUES ($1,1,'A take on the key','take','brain')`, [row!.id]);
        }, TEST_WRITE_ATTRIBUTION));
        await base.executeRaw(`INSERT INTO take_proposals(source_id,page_slug,content_hash,prompt_version,wave_version,proposal_run_id,claim_text,kind,holder,weight,status,model_id) VALUES ('default',$1,'h','p','w','run-1','Proposed take','take','brain',0.5,'pending','m')`, [slug]);
        await base.executeRaw(`INSERT INTO open_loops(source_id,dedup_key,loop_type,summary,page_slug,status,detector,confidence) VALUES ('default','k1','commitment_owed_by_me','Rotate the key',$1,'open','manual',0.9)`, [slug]);
        await base.executeRaw(`INSERT INTO core_edit_notices(source_id,slug,base_text,actor) VALUES ('default',$1,'old body','agent')`, [slug]);
        await base.executeRaw(`INSERT INTO files(source_id,page_slug,page_id,filename,storage_path,mime_type,size_bytes,content_hash) VALUES ('default',$1,$2,'leaked.png','notes/leaked.png','image/png',10,'fh')`, [slug, row!.id]);
        const leaked = await base.readPageSnapshot(slug, { sourceId: 'default', includeDeleted: true });
        await disposePersistenceConsumer(base);
        const rich = await operationsByName.delete_page!.handler({ ...ctx, engine: recording(base) } as OperationContext, { slug, purge: true, request_id: randomUUID(), expected_revision: leaked?.revision }) as { status: string };
        expect(rich.status).toBe('purged');
        await disposePersistenceConsumer(base);
      });
    } finally {
      await base.disconnect();
      rmSync(home, { recursive: true, force: true });
    }
  }, 120000);

  test('a page with a belief ledger', async () => {
    await beliefBrain(async (brain) => {
      // A fact claim on a ledger brain: the receipt then probes the recorded values and the fact contexts for it.
      await brain.put('notes/ledger', beliefPage({ facts: ['Door code is 4417'] }));
      await brain.put('notes/other', page('other', [], 'Other.'));
      await disposePersistenceConsumer(brain.engine);
      const snapshot = await brain.engine.readPageSnapshot('notes/ledger', { sourceId: brain.sourceId });
      const result = await operationsByName.delete_page!.handler({ ...brain.ctx, engine: recording(brain.engine) } as OperationContext, { slug: 'notes/ledger', purge: true, request_id: randomUUID(), expected_revision: snapshot?.revision }) as { status: string };
      expect(result.status).toBe('purged');
      await disposePersistenceConsumer(brain.engine);
    }, { managed: false });
  }, 120000);

  test('a retention purge of an expired tombstone in a worktree-bound source', async () => {
    const SOURCE = 'ret-src';
    const home = mkdtempSync(join(tmpdir(), 'purge-path-ret-'));
    const root = join(home, 'brain');
    mkdirSync(root);
    const base = await freshEngine();
    const ctx = contextOf(base, { sourceId: SOURCE });
    try {
      await withEnv({ GBRAIN_HOME: join(home, 'home'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        await base.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [SOURCE, root]);
        await base.setConfig('sync.write_through', 'true');
        await claimWorktree(base, SOURCE, root);
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'notes/expired', content: '---\ntitle: Expired\ntype: note\n---\nGone soon.', request_id: randomUUID() } });
        const snapshot = await base.readPageSnapshot('notes/expired', { sourceId: SOURCE });
        await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'notes/expired', expected_revision: snapshot!.revision, request_id: randomUUID() } });
        await base.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id=$1 AND slug=$2", [SOURCE, 'notes/expired']);
        await base.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await disposePersistenceConsumer(base);
        const result = await purgeDeletedPagesCoordinated(recording(base), 72);
        expect(result.count).toBe(1);
        await disposePersistenceConsumer(base);
      });
    } finally {
      await base.disconnect();
      rmSync(home, { recursive: true, force: true });
    }
  }, 120000);

  test('an automatic retention purge of an expired tombstone on a brain without managed persistence', async () => {
    // The unmanaged expiry: the rebuild-held concept read, the expired-page reads of the purge transaction (the `only`
    // filter's and the recheck's), then the engine purge.
    const base = await freshEngine();
    const ctx = contextOf(base);
    try {
      await operationsByName.put_page!.handler(ctx, { slug: 'notes/stale', content: page('stale', [], 'Stale.'), request_id: randomUUID() });
      const snapshot = await base.readPageSnapshot('notes/stale', { sourceId: 'default' });
      await operationsByName.delete_page!.handler(ctx, { slug: 'notes/stale', request_id: randomUUID(), expected_revision: snapshot?.revision });
      await base.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE slug=$1", ['notes/stale']);
      await disposePersistenceConsumer(base);
      const result = await purgeDeletedPagesCoordinated(recording(base), 72, { automatic: true, only: () => true });
      expect(result.slugs).toEqual(['notes/stale']);
      await disposePersistenceConsumer(base);
    } finally {
      await base.disconnect();
    }
  }, 120000);

  test('an origin whose derived page could not be labelled: the parked, held purge', async () => {
    const base = await freshEngine();
    const ctx = contextOf(base);
    try {
      await operationsByName.put_page!.handler(ctx, { slug: 'notes/origin', content: page('origin', ['visibility: private'], 'Origin.'), request_id: randomUUID() });
      await operationsByName.put_page!.handler(ctx, { slug: 'notes/digest', content: page('digest', ['derived_from: notes/origin.md'], 'Digest.'), request_id: randomUUID() });
      const digest = await base.readPageSnapshot('notes/digest', { sourceId: 'default' });
      await operationsByName.delete_page!.handler(ctx, { slug: 'notes/digest', request_id: randomUUID(), expected_revision: digest?.revision });
      await disposePersistenceConsumer(base);
      const origin = await base.readPageSnapshot('notes/origin', { sourceId: 'default' });
      const held = await operationsByName.delete_page!.handler({ ...ctx, engine: recording(base) } as OperationContext, { slug: 'notes/origin', purge: true, request_id: randomUUID(), expected_revision: origin?.revision }) as { purge_held?: { code: string } };
      expect(held.purge_held?.code).toBe('derived_origin_parked');
      await disposePersistenceConsumer(base);
    } finally {
      await base.disconnect();
    }
  }, 120000);

  const listed = new Set(PURGE_PATH.map(purgeEntryName));
  const memberEntries = PURGE_PATH.filter((entry): entry is Extract<PurgePathEntry, { member: string }> => 'member' in entry);

  test('every member the purge called is on the list', () => {
    expect(members.size).toBeGreaterThan(50);
    expect([...members].filter(name => !RAW_PRIMITIVES.includes(name) && !listed.has(name)).sort()).toEqual([]);
  });

  test('every raw-SQL site the purge reached is on the list', () => {
    expect(sites.size).toBeGreaterThan(5);
    expect([...sites].filter(site => !listed.has(site)).sort()).toEqual([]);
  });

  test('every stop on the list was observed (a stop names a call the purge makes)', () => {
    const unobserved = PURGE_PATH.filter(entry => ('stop' in entry && entry.stop) || ('refuses' in entry && entry.refuses))
      .filter(entry => !(('member' in entry ? members : sites).has(purgeEntryName(entry))));
    expect(unobserved.map(purgeEntryName)).toEqual([]);
  });

  test('a listed member exists on PGLite, Postgres and the Rust member table', () => {
    const missing: string[] = [];
    for (const { member } of memberEntries) {
      if (typeof (PGLiteEngine.prototype as unknown as Record<string, unknown>)[member] !== 'function') missing.push(`${member}: pglite`);
      if (typeof (PostgresEngine.prototype as unknown as Record<string, unknown>)[member] !== 'function') missing.push(`${member}: postgres`);
      if (!(member in RUST_ENGINE_MEMBERS)) missing.push(`${member}: rust`);
    }
    expect(missing).toEqual([]);
  });

  test('a member the Rust engine does not serve is a known stop with an owner, and a stop is a member it does not serve', () => {
    const unmarked = memberEntries.filter(entry => rustMemberCapability(entry.member) !== null && !entry.stop).map(entry => entry.member);
    expect(unmarked).toEqual([]);
    const stale = memberEntries.filter(entry => entry.stop && rustMemberCapability(entry.member) === null).map(entry => entry.member);
    expect(stale).toEqual([]);
    expect(PURGE_PATH.filter(entry => !entry.owner).map(purgeEntryName)).toEqual([]);
    expect(PURGE_PATH.filter(entry => 'site' in entry && !entry.stop && !entry.guarded).map(purgeEntryName)).toEqual([]);
    expect(new Set(PURGE_PATH.map(purgeEntryName)).size).toBe(PURGE_PATH.length);
  });

  test('the check reads only the list: PGLite and Postgres have no stop, and a stop is named with its owner', async () => {
    expect(await purgePathStops({ kind: 'pglite' })).toEqual([]);
    expect(await purgePathStops({ kind: 'postgres' })).toEqual([]);
    const stops = await purgePathStops({ kind: 'rust' });
    // A delete_page purge has no stop left on main: every member it calls is served.
    for (const stop of stops) expect(PURGE_PATH).toContain(stop.entry);
    expect(stops.map(stop => stop.name)).toEqual(PURGE_PATH
      .filter(entry => entry.entry !== 'retention' && ('site' in entry ? entry.stop : entry.refuses || rustMemberCapability(entry.member) !== null))
      .map(purgeEntryName));
    // The retention purge's raw reads are typed members now (engine-sql/retention-purge.ts): it adds no stop.
    expect(await purgePathStops({ kind: 'rust' }, 'retention')).toEqual(stops);
  });

  test('every stop another lane owns names its due date, in the list and in the refusal detail', async () => {
    const stops = (await purgePathStops({ kind: 'rust' })) as Array<{ name: string; owner: string; due?: string }>;
    expect(stops.filter(stop => stop.owner !== PURGE_OWNERS.ours && !stop.due).map(stop => stop.name)).toEqual([]);
    const error = await requirePurgePathServed({ kind: 'rust' }).then(() => null, (e: unknown) => e as { message: string; detail: string });
    if (stops.length === 0) { expect(error).toBeNull(); return; }
    expect(error?.message).toContain(`which needs ${stops[0]!.name}: `);
    expect(error?.detail).toContain(`owner="${stops[0]!.owner}" due="${stops[0]!.due}"`);
  });

  afterAll(() => { members.clear(); sites.clear(); });
});
