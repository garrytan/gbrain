/**
 * GBRA-69: a managed sync reads its pinned blobs in windows (one `ls-tree` per
 * window of entries, one `cat-file --batch` per bounded slice) instead of an
 * `ls-tree` and a `git show` per entry, and resolves the checkout's Git top
 * level once per run. The database a sync leaves must not depend on it: the
 * same commits synced with per-entry reads (window 0), the default window and
 * a window of 3 (every boundary crossed) leave identical rows in every table,
 * over a first sync and a second round of edits, renames, deletes and new
 * files, including held files (slug conflict, over the read bound) and a
 * source below the repository root. Each arm gets a fresh brain; ids, times
 * and UUIDs are replaced by stable labels, blob ids and commits are compared
 * as they are. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { persistencePostgresTemplate } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __setPinnedWindowForTests } from '../src/core/persistence/sync-blobs.ts';
import { syncGitTopLevel } from '../src/core/persistence/sync-prepare.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-pinned-reads-'));
const SOURCE = 'pinned-reads';
let template: Awaited<ReturnType<typeof persistencePostgresTemplate>> | undefined;
const GIT_ENV = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } }).trim();
}
const commit = (root: string) => { git(root, 'add', '-A', '--', 'vault', 'outside'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes'); };
function write(root: string, files: Record<string, string | null>) {
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    if (body === null) { rmSync(full); continue; }
    mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, body);
  }
}

const pad = (i: number) => String(i).padStart(3, '0');
const facts = (rows: Array<[number, string]>) => ['<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  ...rows.map(([n, claim]) => `| ${n} | ${claim} | fact | 1.0 | world | high | 2026-01-0${n} |  | remember |  |`), '<!--- gbrain:facts:end -->'].join('\n');
const takes = (rows: Array<[number, string]>) => ['<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |',
  '|---|-------|------|-----|--------|-------|--------|', ...rows.map(([n, claim]) => `| ${n} | ${claim} | take | brain | 0.5 | 2026-07 | notes |`),
  '<!--- gbrain:takes:end -->'].join('\n');
function page(i: number, count: number, v = 0): string {
  const kind = ['note', 'person', 'project'][i % 3]!;
  const front = [`title: ${kind === 'person' ? `Person Example ${i}` : `Item ${i}`}`, `type: ${kind}`];
  if (i % 4 === 0) front.push(`tags: [alpha, topic-${i % 5}${v ? ', revised' : ''}]`);
  if (i % 5 === 0) front.push(`aliases: [item-alias-${i}${v ? `, second-alias-${i}` : ''}]`);
  const body = [`A durable observation number ${i}${v ? ' (revised)' : ''}, see [[notes/n${pad((i + 7) % count)}]] and [[notes/n${pad((i + 3) % count)}]].`];
  if (i % 3 === 0) body.push('', facts(v ? [[1, `Fact one of ${i}`], [3, `Fact three of ${i}`]] : [[1, `Fact one of ${i}`], [2, `Fact two of ${i}`]]));
  if (i % 4 === 1) body.push('', takes(v ? [[1, `Take one of ${i}`]] : [[1, `Take one of ${i}`], [2, `Take two of ${i}`]]));
  const timeline = i % 2 === 0 ? ['', '<!-- timeline -->', '', '## Timeline', '', `- **2025-0${1 + (i % 9)}-01** | Started item ${i}`,
    ...(v ? [`- **2026-0${1 + (i % 9)}-15** | Revised item ${i}`] : [`- **2025-1${i % 3}-11** | Reviewed item ${i}`])] : [];
  return `---\n${front.join('\n')}\n---\n${body.join('\n')}\n${timeline.join('\n')}\n`;
}
const COUNT = 24;
/** The source lives in `vault/` below the repository root; `outside/` is not part of it. */
const corpus = (): Record<string, string> => ({
  ...Object.fromEntries(Array.from({ length: COUNT }, (_, i) => [`vault/notes/n${pad(i)}.md`, page(i, COUNT)])),
  'vault/notes/crlf.md': '---\r\ntitle: Line endings\r\ntype: note\r\n---\r\nWritten with CRLF line endings.\r\n',
  'vault/notes/conflict.md': '---\ntitle: Conflict\nslug: notes/somewhere-else\n---\nDeclares a slug its path does not have.\n',
  'vault/notes/broken.md': '---\ntitle: first line of a title\nsecond line of the title\n---\nA synthetic note.\n',
  'vault/big/oversize.md': `---\ntitle: Oversize\n---\n${'x'.repeat(10 * 1024 ** 2 + 64)}\n`,
  'outside/readme.md': '# Not in the source\n',
});
function secondRound(root: string) {
  const edits: Record<string, string | null> = {};
  for (const i of [1, 2, 3, 8, 9, 12, 16, 20]) edits[`vault/notes/n${pad(i)}.md`] = page(i, COUNT, 1);
  for (const i of [5, 13]) edits[`vault/notes/n${pad(i)}.md`] = null;
  for (let i = COUNT; i < COUNT + 5; i++) edits[`vault/notes/n${pad(i)}.md`] = page(i, COUNT);
  edits['vault/notes/conflict.md'] = '---\ntitle: Conflict\n---\nNo declared slug any more.\n';
  edits['vault/notes/broken.md'] = '---\ntitle: Fixed title\n---\nA synthetic note.\n';
  write(root, edits);
  git(root, 'mv', `vault/notes/n${pad(6)}.md`, 'vault/notes/moved-six.md');
  commit(root);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const VOLATILE = new Set(['id', 'created_at', 'updated_at', 'snapshot_at', 'last_written_at', 'embedded_at', 'decided_at', 'ingested_at', 'claim_expires_at',
  'next_attempt_at', 'completed_at', 'published_at', 'generation', 'execution_token', 'sequence', 'source_incarnation', 'incarnation', 'worktree_id',
  'consumer_host_id', 'admitter_host_id', 'consumer_version', 'admitter_version', 'digest', 'authority', 'intent_bytes', 'terminal_reservation', 'topology_generation',
  'runId', 'run_id', 'cursorKey', 'ownerEpoch', 'holdObservedAt', 'observed_at', 'held_at', 'syncAuthority', 'lane', 'group', 'request_id', 'requestId',
  'principal_id', 'revision_principal_id', 'write_principal_id', 'last_write_principal_id', 'archived_principal_id', 'knowledge_revision', 'text_projection_revision',
  'revision', 'expected_revision', 'salience_touched_at', 'last_retrieved_at', 'links_extracted_at', 'emotional_weight_recomputed_at', 'embedding',
  'embedding_image', 'embedding_multimodal', 'edges_backfilled_at', 'search_vector', 'content_hash', 'revision_write_request_id', 'coordination_path',
  'lastAt', 'startedAt']);

/** Every page-derived row the sync wrote, with ids, times, UUIDs and the checkout path replaced by labels. */
async function dump(e: BrainEngine, root: string): Promise<Record<string, string[]>> {
  const pages = await e.executeRaw<{ id: number; slug: string }>('SELECT id,slug FROM pages WHERE source_id=$1', [SOURCE]);
  const slugOf = new Map(pages.map(p => [Number(p.id), p.slug]));
  const norm = (value: unknown, key = ''): unknown => {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return '<time>';
    if (Array.isArray(value)) return value.map(v => norm(v, key));
    if (typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !VOLATILE.has(k)).sort(([a], [b]) => a < b ? -1 : 1)
        .map(([k, v]) => [k, /(^|_)page_id$|^pageId$/.test(k) && v != null ? `page(${slugOf.get(Number(v)) ?? 'other'})` : norm(v, k)]));
    }
    if (typeof value === 'string') {
      const text = value.replaceAll(root, '<root>');
      if (UUID.test(text)) return `<uuid:${key}>`;
      if (TIMESTAMP.test(text) && !/[T ]00:00:00(\.0+)?([+-]00(:00)?|Z)?$/.test(text)) return '<time>';
      return text;
    }
    return value;
  };
  const rows = async (sql: string) => (await e.executeRaw<{ r: unknown }>(sql, [SOURCE])).map(row => JSON.stringify(norm(row.r))).sort();
  return {
    pages: await rows('SELECT to_jsonb(p) || jsonb_build_object(\'deleted\', p.deleted_at IS NOT NULL, \'sv\', p.search_vector::text) AS r FROM pages p WHERE source_id=$1'),
    chunks: await rows('SELECT to_jsonb(c) || jsonb_build_object(\'sv\', c.search_vector::text) AS r FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1'),
    page_aliases: await rows('SELECT to_jsonb(a) AS r FROM page_aliases a WHERE source_id=$1'),
    slug_aliases: await rows('SELECT to_jsonb(a) AS r FROM slug_aliases a WHERE source_id=$1'),
    tags: await rows('SELECT to_jsonb(t) AS r FROM tags t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1'),
    links: await rows('SELECT to_jsonb(l) AS r FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1'),
    timeline: await rows('SELECT to_jsonb(t) AS r FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1'),
    facts: await rows('SELECT to_jsonb(f) - ARRAY[\'superseded_by\',\'consolidated_into\'] || jsonb_build_object(\'expired\', f.expired_at IS NOT NULL) AS r FROM facts f WHERE source_id=$1'),
    takes: await rows('SELECT to_jsonb(k) - \'superseded_by\' AS r FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1'),
    versions: await rows('SELECT to_jsonb(v) AS r FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1'),
    chronicle: await rows('SELECT to_jsonb(c) AS r FROM chronicle_page_state c WHERE source_id=$1'),
    effects: await rows(`SELECT to_jsonb(e) - ARRAY['state','attempts','error_code','outcome','recovery','recovery_bytes'] AS r FROM persistence_effects e WHERE source_id=$1`),
    receipts: await rows(`SELECT jsonb_build_object('intent',r.intent,'state',r.state,'error_code',r.error_code,'error_message',r.error_message,
        'outcome',r.outcome,'slug',r.slug,'page_id',r.page_id,'publication_started',r.publication_started,'compacted',r.compacted) AS r
      FROM persistence_requests r WHERE r.source_id=$1`),
    sources: await rows('SELECT to_jsonb(s) - ARRAY[\'last_sync_at\',\'newest_content_at\'] AS r FROM sources s WHERE id=$1'),
    // A provenance record is keyed by page id, which Postgres bulk groups may assign in another order.
    checkpoints: await rows(`SELECT jsonb_build_object('op',op,'fingerprint',regexp_replace(regexp_replace(fingerprint,'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}','<uuid>','g'),'[0-9a-f]{32,}','<key>','g'),
        'page_id',CASE WHEN op='sync-import-provenance' THEN substring(fingerprint from ':([0-9]+)$')::integer END,'record',completed_keys) AS r
      FROM op_checkpoints WHERE completed_keys::text LIKE '%' || $1 || '%' OR fingerprint LIKE '%' || $1 || '%'`)
      .then(list => list.map(row => row.replace(/("fingerprint":"[^"]*):\d+"(.*"page_id":"(page\([^)]*\))")/, '$1:$3"$2'))),
  };
}

/** A `git` on PATH that logs each invocation, so an arm's Git process count is known. */
function gitCounter(dir: string): { path: string; calls: () => string[] } {
  const log = join(dir, 'git.log'), bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  return { path: `${bin}${delimiter}${process.env.PATH ?? ''}`, calls: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [] };
}

type Arm = { name: string; window: number | null };
const ARMS: Arm[] = [{ name: 'per-entry', window: 0 }, { name: 'window', window: null }, { name: 'window-3', window: 3 }];

async function runArm(backend: string, arm: Arm, open: () => Promise<{ engine: BrainEngine; close: () => Promise<void> }>) {
  const dir = join(home, `${backend}-${arm.name}`), root = join(dir, 'repo');
  mkdirSync(root, { recursive: true }); git(root, 'init', '-q');
  write(root, corpus()); commit(root);
  const sourceRoot = join(root, 'vault');
  const { engine, close } = await open();
  const counter = process.platform === 'win32' ? null : gitCounter(dir);
  const restore = __setPinnedWindowForTests(arm.window);
  try {
    return await withEnv({ GBRAIN_HOME: join(dir, 'home'), ...(counter ? { PATH: counter.path } : {}) }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [SOURCE, sourceRoot]);
      await claimWorktree(engine, SOURCE, sourceRoot);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const outcomes: unknown[] = [], rounds: Array<Record<string, string[]>> = [];
      for (const round of [0, 1]) {
        if (round) secondRound(root);
        const result = await performSync(engine, { sourceId: SOURCE, noPull: true, noEmbed: true, drain: true });
        outcomes.push({ status: result.status, added: result.added, modified: result.modified, deleted: result.deleted, renamed: result.renamed, drain: result.drain?.outcome });
        rounds.push(await dump(engine, root));
      }
      await disposePersistenceConsumer(engine);
      return { outcomes, rounds, calls: counter?.calls() ?? null, head: git(root, 'rev-parse', 'HEAD') };
    });
  } finally { restore(); await close(); }
}

beforeAll(async () => {
  if (process.env.DATABASE_URL) template = await persistencePostgresTemplate(process.env.DATABASE_URL);
}, 120_000);
afterAll(async () => {
  await template?.dispose();
  rmSync(home, { recursive: true, force: true });
});

const backends: Array<[string, () => Promise<{ engine: BrainEngine; close: () => Promise<void> }>]> = [
  ['pglite', async () => { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); return { engine, close: () => engine.disconnect() }; }],
  ['postgres', async () => template!.clone()],
];

for (const [backend, open] of backends) {
  test(`${backend}: windowed pinned reads leave the same rows as per-entry reads, with far fewer Git processes`, async () => {
    if (backend === 'postgres' && !process.env.DATABASE_URL) return;
    const results = [];
    for (const arm of ARMS) results.push(await runArm(backend, arm, open));
    const [legacy, ...windowed] = results;
    expect(legacy!.outcomes).toEqual([
      expect.objectContaining({ drain: 'synced' }), expect.objectContaining({ drain: 'synced' })]);
    const [first, last] = legacy!.rounds;
    for (const table of ['pages', 'chunks', 'page_aliases', 'tags', 'links', 'timeline', 'facts', 'takes', 'versions', 'receipts', 'checkpoints']) {
      expect(last![table]!.length).toBeGreaterThan(0);
    }
    const holds = first!.checkpoints!.filter(row => row.includes('"op":"sync-hold"'));
    expect(holds.some(row => row.includes('"code":"file_too_large"'))).toBe(true);
    expect(holds.some(row => row.includes('"code":"invalid_frontmatter"'))).toBe(true);
    expect(last!.receipts!.some(row => row.includes('"path":"notes/broken.md"'))).toBe(true);
    for (const other of windowed) {
      expect(other.head).toBe(legacy!.head);
      expect(other.outcomes).toEqual(legacy!.outcomes);
      for (const [round, rows] of legacy!.rounds.entries()) {
        const differences = Object.keys(rows).flatMap(table => {
          const mine = new Set(other.rounds[round]![table]), theirs = new Set(rows[table]);
          return [...rows[table]!.filter(row => !mine.has(row)).map(row => `round ${round} ${table} per-entry only: ${row}`),
            ...other.rounds[round]![table]!.filter(row => !theirs.has(row)).map(row => `round ${round} ${table} windowed only: ${row}`)];
        });
        expect(differences).toEqual([]);
        for (const table of Object.keys(rows)) expect(other.rounds[round]![table]!.length).toBe(rows[table]!.length);
      }
    }
    if (!legacy!.calls) return;
    const count = (calls: string[], verb: RegExp) => calls.filter(call => verb.test(call)).length;
    const imports = COUNT + 3 + 8 + 5 + 3;
    expect(count(legacy!.calls, / show [0-9a-f]+:/)).toBeGreaterThanOrEqual(COUNT);
    expect(count(legacy!.calls, / ls-tree -l /)).toBeGreaterThanOrEqual(COUNT);
    expect(count(windowed[0]!.calls!, / show [0-9a-f]+:/)).toBe(0);
    expect(count(windowed[0]!.calls!, / ls-tree -l /)).toBeLessThanOrEqual(4);
    expect(count(windowed[0]!.calls!, / cat-file --batch$/)).toBeLessThanOrEqual(4);
    expect(count(windowed[0]!.calls!, / rev-parse --show-toplevel$/)).toBeLessThan(imports / 2);
  }, 600_000);
}

test('the Git top level is read once per root and run, and again when the checkout\'s .git changes', async () => {
  mkdirSync(join(home, 'top-level', 'a', 'b'), { recursive: true });
  const repo = realpathSync(join(home, 'top-level')), nested = join(repo, 'a', 'b');
  git(repo, 'init', '-q');
  const counter = process.platform === 'win32' ? null : gitCounter(join(home, 'top-level-git'));
  const toplevels = () => execFileSync('git', ['-C', nested, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  await withEnv(counter ? { PATH: counter.path } : {}, async () => {
    const reads = () => counter ? counter.calls().filter(call => call.endsWith('rev-parse --show-toplevel')).length : 0;
    expect(syncGitTopLevel(nested, 'run-1')).toBe(repo);
    expect(syncGitTopLevel(nested, 'run-1')).toBe(repo);
    if (counter) expect(reads()).toBe(1);
    expect(syncGitTopLevel(nested, 'run-2')).toBe(repo);
    if (counter) expect(reads()).toBe(2);
    // A repository initialized between the root and the top level moves the top level.
    git(join(repo, 'a'), 'init', '-q');
    expect(syncGitTopLevel(nested, 'run-1')).toBe(join(repo, 'a'));
    expect(syncGitTopLevel(nested, 'run-1')).toBe(toplevels());
    rmSync(join(repo, 'a', '.git'), { recursive: true, force: true });
    expect(syncGitTopLevel(nested, 'run-1')).toBe(repo);
    // A replaced .git at the top level is read again.
    renameSync(join(repo, '.git'), join(home, 'top-level-old-git'));
    git(repo, 'init', '-q');
    const before = reads();
    expect(syncGitTopLevel(nested, 'run-1')).toBe(repo);
    if (counter) expect(reads()).toBe(before + 1);
  });
});
