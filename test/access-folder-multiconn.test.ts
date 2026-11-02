/**
 * GBRA-218 (A2) plan §16 multi-connection cases, on real Postgres:
 *  (a) an import paused after it installed the imported rulebook (pending coverage committed, no page published yet)
 *      and then publishing its pages, while remote reads run through MCP dispatch on other pool connections: no read
 *      ever returns a page under the restricted prefix to a caller outside the rule, and the end state is stamped;
 *  (b) gbrain access rule migrate (database -> git) interrupted after its git commits and, separately, after the store
 *      switch: the applied rules never go missing (remote reads stay narrowed), the rerun or the next sync reconciles,
 *      the end state matches an uninterrupted run, and the switch waits for a page write already holding the source.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runImport } from '../src/commands/import.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { coverageRows, policySeams, policyStatus, proposeRevision } from '../src/core/access/policy.ts';
import { migrateAccessStore, migrateSeams } from '../src/core/access/policy-migrate.ts';
import { APPROVED_FILE, POLICY_FILE, syncAccessPolicyAt } from '../src/core/access/policy-git.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SKIP = !process.env.DATABASE_URL;
const SECRET = 'partners/secret-example/';
const page = (title: string, canary: string) => ['---', 'type: note', 'title: ' + title, '---', '# ' + title, '', 'Folder notes ' + canary + '.'].join('\n');
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [log, err] = [console.log, console.error];
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
};

describe.skipIf(SKIP)('folder rules under concurrent connections (postgres)', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;
  const tokens: Record<string, string> = {};
  const dirs: string[] = [];
  const fresh = (tag: string) => { const d = mkdtempSync(join(tmpdir(), 'gbrain-mp-' + tag + '-')); dirs.push(d); return d; };

  async function sees(who: string, sourceId: string, canary: string): Promise<boolean> {
    const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) })
      .verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
    const out = await dispatchToolCall(engine, 'search', { query: canary, match: 'keyword', fields: 'full', limit: 50 },
      { remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: ['world'] });
    return out.content.map(c => c.text).join('\n').includes(canary);
  }

  /** Reads as bob and an unbound token in a loop until stop() resolves; returns every read that saw a canary. */
  function readerLoop(sourceId: string, canaries: string[]): { stop: () => Promise<{ reads: number; leaks: string[] }> } {
    let running = true;
    const leaks: string[] = [];
    let reads = 0;
    const loop = (async () => {
      while (running) {
        for (const who of ['bob', 'unbound']) for (const c of canaries) {
          reads++;
          if (await sees(who, sourceId, c)) leaks.push(who + ':' + c);
        }
      }
    })();
    return { stop: async () => { running = false; await loop; return { reads, leaks }; } };
  }

  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 6));
    const sources = ['mp-dst', 'mp-a', 'mp-b', 'mp-c'];
    for (const s of sources) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [s]);
    for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
    for (const [name, member] of [['alice', 'alice-example'], ['bob', 'bob-example'], ['unbound', null]] as const) {
      const minted = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: sources });
      tokens[name] = minted.token;
      if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
    }
  }, 180_000);
  afterAll(async () => {
    policySeams.afterInstall = undefined;
    migrateSeams.afterPhase = undefined;
    await close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test('(a) an import paused after installing its rulebook, then publishing, never shows a restricted page to a caller outside the rule', async () => {
    await importFromContent(engine, SECRET + 'old', page('Old', 'canarympold'), { sourceId: 'mp-dst', noEmbed: true });
    expect(await sees('bob', 'mp-dst', 'canarympold')).toBe(true);
    const dir = fresh('import');
    mkdirSync(join(dir, SECRET), { recursive: true });
    mkdirSync(join(dir, 'notes'), { recursive: true });
    mkdirSync(join(dir, '.gbrain'), { recursive: true });
    for (let i = 0; i < 12; i++) writeFileSync(join(dir, SECRET + 'p' + i + '.md'), page('P' + i, 'canarympsecret'));
    writeFileSync(join(dir, 'notes/open.md'), page('Open', 'canarympopen'));
    writeFileSync(join(dir, POLICY_FILE), ['version: 1', 'rules:', '  - id: secret', '    prefix: ' + SECRET, '    readable_by: [alice-example]', ''].join('\n'));

    let paused!: () => void;
    const pausedAt = new Promise<void>(resolve => { paused = resolve; });
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    policySeams.afterInstall = async () => { paused(); await released; };
    const imported = quiet(() => runImport(engine, [dir, '--source', 'mp-dst', '--no-embed']));
    await pausedAt;
    policySeams.afterInstall = undefined;
    for (const who of ['alice', 'bob', 'unbound']) expect({ who, old: await sees(who, 'mp-dst', 'canarympold') }).toEqual({ who, old: false });
    expect((await coverageRows(engine, 'mp-dst')).map(c => c.prefix + ':' + c.reason)).toEqual([SECRET + ':pending']);
    expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id = 'mp-dst' AND slug LIKE $1", [SECRET + 'p%']))[0]!.n).toBe(0);
    const loop = readerLoop('mp-dst', ['canarympsecret', 'canarympold']);
    release();
    await imported;
    const { reads, leaks } = await loop.stop();
    expect(reads).toBeGreaterThan(0);
    expect(leaks).toEqual([]);
    expect(await coverageRows(engine, 'mp-dst')).toEqual([]);
    const stamps = await engine.executeRaw<{ slug: string; ids: string[] | null }>("SELECT slug, folder_rule_ids AS ids FROM pages WHERE source_id = 'mp-dst' ORDER BY slug");
    expect(stamps.filter(s => s.slug.startsWith(SECRET)).every(s => JSON.stringify(s.ids) === JSON.stringify(['mp-dst:secret']))).toBe(true);
    expect(stamps.filter(s => s.slug.startsWith(SECRET)).length).toBe(13);
    expect({ alice: await sees('alice', 'mp-dst', 'canarympsecret'), bob: await sees('bob', 'mp-dst', 'canarympsecret'), open: await sees('bob', 'mp-dst', 'canarympopen') })
      .toEqual({ alice: true, bob: false, open: true });
  }, 300_000);

  async function gitSource(sourceId: string): Promise<string> {
    const root = fresh(sourceId);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 't@t.co');
    git(root, 'config', 'user.name', 't');
    writeFileSync(join(root, 'README.md'), 'repo\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    await engine.executeRaw("UPDATE sources SET local_path = $2, config = '{}'::jsonb WHERE id = $1", [sourceId, root]);
    await importFromContent(engine, SECRET + 'doc', page('Doc', 'canarymp' + sourceId.replace('-', '')), { sourceId, noEmbed: true });
    await proposeRevision(engine, sourceId, [{ id: 'secret', prefix: SECRET, readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
    return root;
  }
  const endState = async (sourceId: string, root: string) => {
    const s = await policyStatus(engine, sourceId);
    return { store: s.store, rules: s.rules, held: s.held, pending: s.pending, yml: readFileSync(join(root, POLICY_FILE), 'utf8'), approved: readFileSync(join(root, APPROVED_FILE), 'utf8'),
      commits: git(root, 'log', '--format=%s').split('\n').map(l => l.replace(sourceId, '<src>')) };
  };

  test('(b) a migrate interrupted after its git commit, or after the store switch, never drops a rule and reconciles to an uninterrupted run', async () => {
    const roots = { a: await gitSource('mp-a'), b: await gitSource('mp-b'), c: await gitSource('mp-c') };
    const narrowed = async (sourceId: string) => ({ bob: await sees('bob', sourceId, 'canarymp' + sourceId.replace('-', '')), alice: await sees('alice', sourceId, 'canarymp' + sourceId.replace('-', '')) });
    for (const s of ['mp-a', 'mp-b', 'mp-c']) expect({ s, ...await narrowed(s) }).toEqual({ s, bob: false, alice: true });

    await quiet(() => migrateAccessStore(engine, 'mp-b'));
    const reference = await endState('mp-b', roots.b);
    expect(reference.store).toBe('git');

    migrateSeams.afterPhase = phase => { if (phase === 'committed') throw new Error('interrupted after commit'); };
    await expect(quiet(() => migrateAccessStore(engine, 'mp-a'))).rejects.toThrow('interrupted after commit');
    migrateSeams.afterPhase = undefined;
    expect((await policyStatus(engine, 'mp-a')).store).toBe('database');
    expect((await engine.executeRaw<{ phase: string }>("SELECT phase FROM access_policy_migrations WHERE source_id = 'mp-a'")).map(r => r.phase)).toEqual(['committed']);
    expect({ ...await narrowed('mp-a') }).toEqual({ bob: false, alice: true });
    let holding!: () => void;
    const held = new Promise<void>(resolve => { holding = resolve; });
    let letGo!: () => void;
    const go = new Promise<void>(resolve => { letGo = resolve; });
    const write = engine.transaction(async tx => {
      await tx.executeRaw("SELECT incarnation FROM sources WHERE id = 'mp-a' FOR SHARE");
      holding();
      await go;
      await tx.putPage(SECRET + 'during', { type: 'note', title: 'During', compiled_truth: 'During notes.', timeline: '', frontmatter: {} }, { sourceId: 'mp-a' });
    });
    await held;
    const loop = readerLoop('mp-a', ['canarympmpa']);
    const resumed = quiet(() => migrateAccessStore(engine, 'mp-a'));
    const deadline = Date.now() + 30_000;
    while ((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"))[0]!.n === 0) {
      if (Date.now() > deadline) throw new Error('the store switch never waited on the open page write');
      await Bun.sleep(50);
    }
    letGo();
    const settled = await Promise.allSettled([write, resumed]);
    expect(settled.map(s => (s.status === 'rejected' ? String(s.reason) : 'ok'))).toEqual(['ok', 'ok']);
    const { reads, leaks } = await loop.stop();
    expect({ reads: reads > 0, leaks }).toEqual({ reads: true, leaks: [] });
    expect(((settled[1] as PromiseFulfilledResult<{ phase: string; receipts: Record<string, unknown> }>).value)).toMatchObject({ phase: 'switched', receipts: { sync: 'unchanged' } });
    expect((await engine.executeRaw<{ ids: string[] | null }>("SELECT folder_rule_ids AS ids FROM pages WHERE source_id = 'mp-a' AND slug = $1", [SECRET + 'during']))[0]?.ids).toEqual(['mp-a:secret']);
    expect(await endState('mp-a', roots.a)).toEqual(reference);

    migrateSeams.afterPhase = phase => { if (phase === 'switched') throw new Error('interrupted after switch'); };
    await expect(quiet(() => migrateAccessStore(engine, 'mp-c'))).rejects.toThrow('interrupted after switch');
    migrateSeams.afterPhase = undefined;
    expect((await policyStatus(engine, 'mp-c')).store).toBe('git');
    expect({ ...await narrowed('mp-c') }).toEqual({ bob: false, alice: true });
    expect((await quiet(() => syncAccessPolicyAt(engine, 'mp-c', roots.c)))?.state).toBe('unchanged');
    expect({ ...await narrowed('mp-c') }).toEqual({ bob: false, alice: true });
    expect(await endState('mp-c', roots.c)).toEqual(reference);
  }, 300_000);
});
