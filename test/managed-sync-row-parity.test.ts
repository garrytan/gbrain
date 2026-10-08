/**
 * #5984 lane apply: a managed sync publishes the same rows whether its bulk
 * groups run in lanes or one at a time (Postgres only; PGLite has no bulk
 * groups). Two rounds over one corpus (frontmatter, aliases, tags, timeline,
 * facts and takes fences, links; then edits, renames, deletes and new files)
 * compare every page-derived row, effect and receipt with ids, timestamps and
 * revisions replaced by stable labels. GBRAIN_TEST_PARITY_DUMP=<file> also writes
 * the lanes dump, to compare two builds of the publisher.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const dumpFile = process.env.GBRAIN_TEST_PARITY_DUMP;
const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-row-parity-'));
let engine: BrainEngine | undefined;
let closePostgres: (() => Promise<void>) | undefined;
const sources: string[] = [];
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes'); };
function write(root: string, files: Record<string, string | null>) {
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    if (body === null) { rmSync(full); continue; }
    mkdirSync(join(full, '..'), { recursive: true }); writeFileSync(full, body);
  }
}
async function fixture(e: BrainEngine, files: Record<string, string>) {
  const id = `parity-${randomUUID().replace(/-/g, '').slice(0, 20)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  write(root, files); commit(root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await e.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(e, id, root);
  await e.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}

const pad = (i: number) => String(i).padStart(3, '0');
const facts = (rows: Array<[number, string]>) => ['<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  ...rows.map(([n, claim]) => `| ${n} | ${claim} | fact | 1.0 | world | high | 2026-01-0${n} |  | remember |  |`), '<!--- gbrain:facts:end -->'].join('\n');
const takes = (rows: Array<[number, string]>) => ['<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |',
  '|---|-------|------|-----|--------|-------|--------|', ...rows.map(([n, claim]) => `| ${n} | ${claim} | take | brain | 0.5 | 2026-07 | notes |`),
  '<!--- gbrain:takes:end -->'].join('\n');
/** One page of the corpus; `v` changes its content between rounds. */
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
const COUNT = 36;
const meeting = (i: number, v = 0) => `---\ntitle: Weekly sync ${i}\ntype: meeting\ndate: 2026-02-0${i + 1}\n---\nAttendees reviewed the roadmap for item ${i}${v ? ' again' : ''}, agreed on the next milestone and assigned follow-ups to the team.\n`;
const corpus = () => ({ ...Object.fromEntries(Array.from({ length: COUNT }, (_, i) => [`notes/n${pad(i)}.md`, page(i, COUNT)])),
  ...Object.fromEntries([0, 1, 2].map(i => [`meetings/m${i}.md`, meeting(i)])) });
/** Round two: edits, renames (one with an edit), deletes and new files. */
function secondRound(root: string) {
  const edits: Record<string, string | null> = {};
  for (const i of [1, 2, 3, 4, 8, 9, 12, 16, 20, 24]) edits[`notes/n${pad(i)}.md`] = page(i, COUNT, 1);
  for (const i of [5, 13, 21]) edits[`notes/n${pad(i)}.md`] = null;
  edits['meetings/m1.md'] = meeting(1, 1);
  for (let i = COUNT; i < COUNT + 6; i++) edits[`notes/n${pad(i)}.md`] = page(i, COUNT);
  write(root, edits);
  git(root, 'mv', `notes/n${pad(6)}.md`, 'notes/moved-six.md');
  mkdirSync(join(root, 'archive'), { recursive: true });
  git(root, 'mv', `notes/n${pad(15)}.md`, 'archive/moved-fifteen.md');
  write(root, { 'archive/moved-fifteen.md': page(15, COUNT, 1) });
  commit(root);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const VOLATILE = new Set(['id', 'created_at', 'updated_at', 'snapshot_at', 'last_written_at', 'embedded_at', 'decided_at', 'ingested_at', 'claim_expires_at',
  'next_attempt_at', 'completed_at', 'published_at', 'generation', 'execution_token', 'sequence', 'source_id', 'source_incarnation', 'worktree_id',
  'consumer_host_id', 'admitter_host_id', 'consumer_version', 'admitter_version', 'digest', 'authority', 'intent_bytes', 'terminal_reservation', 'topology_generation',
  'local_path', 'root', 'runId', 'run_id', 'cursorKey', 'ownerEpoch', 'holdObservedAt', 'syncAuthority', 'repoPath', 'lane', 'group', 'from', 'target', 'blobOid', 'blob_oid',
  'gbrain_version', 'raw_sha256', 'rawHash', 'request_id', 'principal_id', 'revision_principal_id', 'write_principal_id', 'last_write_principal_id', 'archived_principal_id']);

/** Every page-derived row of one source, ids and times replaced by labels. */
async function dump(e: BrainEngine, source: string): Promise<Record<string, unknown[]>> {
  const pages = await e.executeRaw<{ id: number; slug: string }>('SELECT id,slug FROM pages WHERE source_id=$1', [source]);
  const slugOf = new Map(pages.map(p => [Number(p.id), p.slug]));
  const requests = await e.executeRaw<{ id: string; label: string; revision: string | null }>(`SELECT r.id::text AS id,
      concat_ws(':',r.intent->>'kind',COALESCE(r.intent->>'path',''),dense_rank() OVER (ORDER BY (SELECT min(sequence) FROM persistence_requests x WHERE x.intent->>'runId'=r.intent->>'runId'))) AS label,
      r.outcome->>'revision' AS revision
    FROM persistence_requests r WHERE r.source_id=$1`, [source]);
  const labels = new Map<string, string>(requests.map(r => [r.id, `request(${r.label})`]));
  for (const p of await e.executeRaw<{ slug: string; revision: string }>('SELECT slug,knowledge_revision::text AS revision FROM pages WHERE source_id=$1', [source])) labels.set(p.revision, `revision(${p.slug})`);
  const norm = (value: unknown, key = ''): unknown => {
    if (value === null || value === undefined) return value ?? null;
    if (value instanceof Date) return '<time>';
    if (Array.isArray(value)) return value.map(v => norm(v, key));
    if (typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => !VOLATILE.has(k)).sort(([a], [b]) => a < b ? -1 : 1)
        .map(([k, v]) => [k, /(^|_)page_id$|^pageId$|^origin_page_id$|^event_page_id$/.test(k) && v != null ? `page(${slugOf.get(Number(v)) ?? 'other'})` : norm(v, k)]));
    }
    if (typeof value === 'string') {
      value = value.replaceAll(source, '<source>');
      if (UUID.test(value as string)) return labels.get(value as string) ?? `<uuid:${key}>`;
      // A clock reading is volatile; a calendar date stored as midnight is content.
      if (TIMESTAMP.test(value as string) && !/[T ]00:00:00(\.0+)?([+-]00(:00)?|Z)?$/.test(value as string)) return '<time>';
    }
    return value;
  };
  const rows = async (sql: string) => (await e.executeRaw<{ r: unknown }>(sql, [source])).map(row => norm(row.r)).map(r => JSON.stringify(r)).sort();
  const strip = (cols: string[]) => `ARRAY[${cols.map(c => `'${c}'`).join(',')}]`;
  return {
    pages: await rows(`SELECT to_jsonb(p) - ${strip(['salience_touched_at', 'last_retrieved_at', 'links_extracted_at', 'emotional_weight_recomputed_at', 'knowledge_revision', 'text_projection_revision'])}
      || jsonb_build_object('sealed', p.text_projection_revision IS NOT DISTINCT FROM p.knowledge_revision, 'deleted', p.deleted_at IS NOT NULL, 'search_vector', p.search_vector::text) AS r
      FROM pages p WHERE source_id=$1`),
    chunks: await rows(`SELECT to_jsonb(c) - ${strip(['embedding', 'embedding_image', 'embedding_multimodal', 'edges_backfilled_at', 'search_vector'])} || jsonb_build_object('sv', c.search_vector::text) AS r
      FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1`),
    page_aliases: await rows('SELECT to_jsonb(a) AS r FROM page_aliases a WHERE source_id=$1'),
    slug_aliases: await rows('SELECT to_jsonb(a) AS r FROM slug_aliases a WHERE source_id=$1'),
    tags: await rows('SELECT to_jsonb(t) AS r FROM tags t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1'),
    links: await rows('SELECT to_jsonb(l) AS r FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1'),
    timeline: await rows('SELECT to_jsonb(t) AS r FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1'),
    facts: await rows(`SELECT to_jsonb(f) - ${strip(['embedding', 'superseded_by', 'consolidated_into'])} || jsonb_build_object('expired', f.expired_at IS NOT NULL) AS r FROM facts f WHERE source_id=$1`),
    takes: await rows(`SELECT to_jsonb(k) - ${strip(['embedding', 'superseded_by'])} AS r FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.source_id=$1`),
    versions: await rows('SELECT to_jsonb(v) - ARRAY[\'knowledge_revision\'] AS r FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1'),
    projection_jobs: await rows(`SELECT to_jsonb(j) - 'revision' AS r FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation WHERE s.id=$1`),
    chronicle: await rows('SELECT to_jsonb(c) - ARRAY[\'content_hash\'] AS r FROM chronicle_page_state c WHERE source_id=$1'),
    // Effects are compared as queued; their execution state moves on in the background.
    effects: await rows(`SELECT to_jsonb(e) - ${strip(['revision', 'state', 'attempts', 'error_code', 'outcome', 'recovery', 'recovery_bytes'])} AS r FROM persistence_effects e WHERE source_id=$1`),
    receipts: await rows(`SELECT jsonb_build_object('kind',r.intent->>'kind','path',r.intent->>'path','state',r.state,'error_code',r.error_code,'error_message',r.error_message,
        'outcome',r.outcome - 'revision','slug',r.slug,'page_id',r.page_id,'publication_started',r.publication_started,'compacted',r.compacted) AS r
      FROM persistence_requests r WHERE r.source_id=$1 AND r.intent->>'kind' LIKE 'managed_sync_%'`),
    provenance: await rows(`SELECT jsonb_build_object('op',op,'record',completed_keys) AS r FROM op_checkpoints
      WHERE completed_keys->0->>'source_id'=$1 AND op NOT LIKE 'managed-sync%'`),
  };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL, 'instance', 12); engine = pg.engine; closePostgres = pg.close;
}, 120_000);
afterAll(async () => {
  if (engine) await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine!); await engine!.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const id of sources) await engine!.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('lanes and --no-lanes publish the same rows, effects and receipts over imports, edits, renames and deletes', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_BULK_SIZE: '4' }, async () => {
  if (!engine) return;
  const laned = await fixture(engine, corpus()), serial = await fixture(engine, corpus());
  const sync = (id: string, lanes: number) => performSync(engine!, { sourceId: id, noPull: true, noEmbed: false, drain: true, lanes });
  for (const round of [0, 1]) {
    if (round) { secondRound(laned.root); secondRound(serial.root); }
    const a = await sync(laned.id, 4), b = await sync(serial.id, 1);
    expect(a.drain).toMatchObject({ outcome: 'synced', bulk: { lanes: { configured: 4 } } });
    expect(b.drain).toMatchObject({ outcome: 'synced', bulk: { lanes: { configured: 1 } } });
    if (round === 0) expect(a.drain!.bulk!.lanes.overlapped_groups).toBeGreaterThan(0);
  }
  const left = await dump(engine, laned.id), right = await dump(engine, serial.id);
  if (dumpFile) writeFileSync(dumpFile, JSON.stringify(left, null, 1));
  for (const table of ['pages', 'chunks', 'page_aliases', 'slug_aliases', 'tags', 'links', 'timeline', 'facts', 'takes', 'versions', 'chronicle', 'effects', 'receipts', 'provenance'] as const) {
    expect(left[table]!.length).toBeGreaterThan(0);
  }
  const differences = Object.keys(left).flatMap(table => {
    const r = new Set(right[table] as string[]), l = new Set(left[table] as string[]);
    return [...(left[table] as string[]).filter(row => !r.has(row)).map(row => `${table} lanes only: ${row}`),
      ...(right[table] as string[]).filter(row => !l.has(row)).map(row => `${table} --no-lanes only: ${row}`)];
  });
  expect(differences).toEqual([]);
  for (const table of Object.keys(left)) expect(left[table]!.length).toBe(right[table]!.length);
  const live = (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [laned.id])).map(r => r.slug);
  expect(live).toContain('notes/moved-six');
  expect(live).toContain('archive/moved-fifteen');
  expect(live).not.toContain(`notes/n${pad(5)}`);
  expect(live).toHaveLength(COUNT - 3 + 6 + 3);
}), 600_000);
