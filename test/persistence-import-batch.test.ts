import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { importManagedFile, importManagedFiles } from '../src/core/persistence/import-mutations.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimGroupFollowers, claimNextWrite, independentGroup, publicationGroupKey, releaseUnpublishedClaim } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer, waitForWrites } from '../src/core/persistence/service.ts';
import { managedImportContent } from '../src/core/persistence/import-prepare.ts';
import { preparePageAdmission } from '../src/core/persistence/page-mutations.ts';
import { admitBatch } from '../src/core/persistence/page-batch.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { runImport } from '../src/commands/import.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-import-batch-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
type Brain = { label: string; engine: BrainEngine; close: () => Promise<void> };
const pairs: Array<[Brain, Brain]> = [];

beforeAll(async () => {
  const lite: Brain[] = [];
  for (const label of ['pglite-one-by-one', 'pglite-batched']) {
    const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    lite.push({ label, engine, close: () => engine.disconnect() });
  }
  pairs.push([lite[0]!, lite[1]!]);
  if (!process.env.DATABASE_URL) return;
  const pg: Brain[] = [];
  for (const label of ['postgres-one-by-one', 'postgres-batched']) {
    const db = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    pg.push({ label, engine: db.engine, close: db.close });
  }
  pairs.push([pg[0]!, pg[1]!]);
}, 180_000);
afterAll(async () => {
  await withEnv(env, async () => {
    for (const brain of pairs.flat()) { await disposePersistenceConsumer(brain.engine); await brain.close(); }
  });
  rmSync(home, { recursive: true, force: true });
});

async function managedSource(engine: BrainEngine, sourceId: string, label: string) {
  const root = join(home, `${label}-${sourceId}`);
  mkdirSync(root, { recursive: true });
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, sourceId, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return root;
}

const fact = (rowNum: number, claim: string) => renderFactsTable([{ rowNum, claim, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true, context: 'fixture' }]);
function page(title: string, opts: { type?: string; tags?: string[]; links?: string[]; facts?: string; timeline?: string[]; body?: string } = {}): string {
  const fm = ['---', `type: ${opts.type ?? 'note'}`, `title: "${title}"`, ...(opts.tags?.length ? [`tags: [${opts.tags.join(', ')}]`] : []), '---', ''];
  const body = [`# ${title}`, '', opts.body ?? `Notes about ${title} for the import fixture.`, '',
    ...(opts.links ?? []).map(link => `- Related: [[${link}]]`), ...(opts.facts ? ['', `Facts: ${opts.facts}`] : [])];
  const timeline = opts.timeline?.length ? ['', '<!-- timeline -->', '', ...opts.timeline.map(line => `- **${line}**`)] : [];
  return [...fm, ...body, ...timeline, ''].join('\n');
}

/** A first import, then a second pass that updates, adds, collides on a slug and carries a refused file. */
const FIRST: Record<string, string> = {
  'people/alice-example.md': page('Alice Example', { type: 'person', tags: ['team'], links: ['companies/acme-example'], timeline: ['2024-01-02** | joined acme-example'] }),
  'notes/kept.md': page('Kept note', { body: 'Unchanged between passes.' }),
  'notes/edited.md': page('Edited note', { body: 'The first version.' }),
};
const SECOND: Record<string, string> = {
  'notes/kept.md': FIRST['notes/kept.md']!,
  'notes/edited.md': page('Edited note', { body: 'The second version links forward.', links: ['notes/topic-11'], tags: ['changed'] }),
  'companies/acme-example.md': page('Acme Example', { type: 'company', links: ['people/alice-example', 'people/bob-example'],
    facts: fact(1, 'acme-example builds example widgets'), timeline: ['2024-02-03** | met alice-example', '2024-03-04** | shipped widgets'] }),
  'people/bob-example.md': page('Bob Example', { type: 'person', links: ['companies/acme-example', 'notes/topic-3'], timeline: ['2024-05-06** | joined'] }),
  'notes/Foo Bar.md': page('Foo Bar spaced', { body: 'First file with the foo-bar slug.' }),
  'notes/foo-bar.md': page('Foo Bar dashed', { body: 'Second file with the same slug.' }),
  'broken.md': '---\ntags:\n  - a\n - b\n---\nBody\n',
  ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`notes/topic-${i}.md`,
    page(`Topic ${i}`, { tags: [`tag-${i % 3}`], links: [`notes/topic-${(i + 5) % 14}`, 'people/alice-example'], facts: i % 4 === 0 ? fact(1, `topic ${i} is about examples`) : undefined,
      timeline: i % 3 === 0 ? [`2024-0${1 + (i % 9)}-1${i % 10}** | topic ${i} event`] : [] })])),
};

function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
  return Object.keys(files).sort().map(path => ({ filePath: join(root, path), sourcePath: path }));
}
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
function normalize(value: unknown): unknown {
  if (value instanceof Date) return '<time>';
  if (typeof value === 'string') return value.replace(UUID, '<uuid>');
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/(_at|^updated|^created)$/.test(key)).map(([key, v]) => [key, normalize(v)]));
  return value;
}
const TABLES = ['pages', 'content_chunks', 'links', 'timeline_entries', 'facts', 'takes', 'tags', 'page_aliases', 'slug_aliases', 'page_versions'];
/** Every row of every table the import writes, all columns (timestamps dropped, generated ids masked), in a stable order. */
async function state(engine: BrainEngine, root: string) {
  const out: Record<string, string[]> = {};
  for (const table of TABLES) {
    const columns = await engine.executeRaw<{ column_name: string; data_type: string }>(
      "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table]);
    const select = columns.map(c => ['USER-DEFINED', 'tsvector'].includes(c.data_type) ? `"${c.column_name}"::text AS "${c.column_name}"` : `"${c.column_name}"`).join(',');
    out[table] = (await engine.executeRaw(`SELECT ${select} FROM ${table}`)).map(row => JSON.stringify(normalize(row))).sort();
  }
  const walk = (dir: string): string[] => readdirSync(dir).filter(name => !name.startsWith('.gbrain')).flatMap(name => statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]);
  out.files = walk(root).map(file => `${relative(root, file)}\n${readFileSync(file, 'utf8')}`).sort();
  return out;
}
const outcome = (settled: PromiseSettledResult<unknown>) => settled.status === 'fulfilled' ? { ok: settled.value }
  : { error: (settled.reason as { code?: string }).code ?? null, message: String((settled.reason as Error).message).replace(UUID, '<uuid>') };

test('a batched managed import leaves exactly the rows, files and per-file results of importing the files one by one', async () => withEnv(env, async () => {
  for (const [one, batched] of pairs) {
    const sourceId = `batch-${randomUUID().slice(0, 8)}`;
    const roots = { one: await managedSource(one.engine, sourceId, one.label), batched: await managedSource(batched.engine, sourceId, batched.label) };
    for (const [brain, root] of [[one, roots.one], [batched, roots.batched]] as const) {
      for (const file of write(root, FIRST)) await importManagedFile(brain.engine, file.filePath, file.sourcePath, { sourceId, noEmbed: true });
    }
    const sequential: PromiseSettledResult<unknown>[] = [];
    for (const file of write(roots.one, SECOND)) {
      sequential.push(await importManagedFile(one.engine, file.filePath, file.sourcePath, { sourceId, noEmbed: true })
        .then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason })));
    }
    const files = write(roots.batched, SECOND);
    const together = await importManagedFiles(batched.engine, files, { sourceId, noEmbed: true });
    expect(together.map(outcome)).toEqual(sequential.map(outcome));
    expect(together.filter(result => result.status === 'fulfilled' && result.value.status === 'imported').length).toBeGreaterThan(16);
    expect(together.map(outcome).find(result => 'error' in result && result.message?.includes('Invalid YAML'))).toBeDefined();
    expect(await state(batched.engine, roots.batched)).toEqual(await state(one.engine, roots.one));
    // Every new request of the call carries one batch marker, so the owner publishes them as independent groups.
    const markers = await batched.engine.executeRaw<{ marker: string | null }>(
      "SELECT DISTINCT intent->>'import_batch' AS marker FROM persistence_requests WHERE source_id=$1 AND intent->>'import_batch' IS NOT NULL", [sourceId]);
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(await batched.engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-file-import'")).toHaveLength(
      (await one.engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-file-import'")).length);
    // A repeated import settles every file as the one-by-one import does, and admits the same (refused-file) requests.
    const requests = async (brain: Brain) => (await brain.engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [sourceId])).length;
    const before = await requests(batched);
    expect(before).toBe(await requests(one));
    const againOne: PromiseSettledResult<unknown>[] = [];
    for (const file of write(roots.one, SECOND)) {
      againOne.push(await importManagedFile(one.engine, file.filePath, file.sourcePath, { sourceId, noEmbed: true })
        .then(value => ({ status: 'fulfilled' as const, value }), reason => ({ status: 'rejected' as const, reason })));
    }
    const againBatched = await importManagedFiles(batched.engine, write(roots.batched, SECOND), { sourceId, noEmbed: true });
    expect(againBatched.map(outcome)).toEqual(againOne.map(outcome));
    expect(againBatched.filter(result => result.status === 'fulfilled').every(result => (result as PromiseFulfilledResult<{ status: string }>).value.status === 'skipped')).toBe(true);
    expect(await requests(batched)).toBe(await requests(one));
    expect(await state(batched.engine, roots.batched)).toEqual(await state(one.engine, roots.one));
  }
}), 300_000);

test('runImport accounts every file of a batched directory import', async () => withEnv(env, async () => {
  for (const [, brain] of pairs) {
    const sourceId = `dir-${randomUUID().slice(0, 8)}`;
    const root = await managedSource(brain.engine, sourceId, brain.label);
    write(root, SECOND);
    const result = await runImport(brain.engine, [root, '--no-embed', '--fresh'], { sourceId });
    expect(result).toMatchObject({ imported: Object.keys(SECOND).length - 2, errors: 2 });
    const failed = (result as { failures: Array<{ path: string }> }).failures.map(failure => failure.path);
    expect(failed).toContain('broken.md');
    expect(failed.filter(path => path === 'notes/foo-bar.md' || path === 'notes/Foo Bar.md')).toHaveLength(1);
    expect(await runImport(brain.engine, [root, '--no-embed', '--fresh'], { sourceId })).toMatchObject({ imported: 0, errors: 2 });
  }
}), 300_000);

test('a batch that is interrupted after admission resumes its accepted requests', async () => withEnv(env, async () => {
  for (const [, brain] of pairs) {
    const sourceId = `resume-${randomUUID().slice(0, 8)}`;
    await managedSource(brain.engine, sourceId, brain.label);
    // Input outside the canonical root: publication writes the root's copy, so the input bytes (and the durable intent's key) stay put.
    const input = join(home, `${brain.label}-${sourceId}-input`);
    const files = write(input, Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`resume-${i}.md`, page(`Resume ${i}`)])));
    const original = brain.engine.executeRaw;
    let fail = true;
    brain.engine.executeRaw = async function(this: BrainEngine, sql, params) {
      if (fail && sql.startsWith('DELETE FROM op_checkpoints') && params?.[0] === 'managed-file-import') { fail = false; throw new Error('simulated caller interruption'); }
      return original.call(this, sql, params);
    } as BrainEngine['executeRaw'];
    let first: PromiseSettledResult<unknown>[];
    try { first = await importManagedFiles(brain.engine, files, { sourceId, noEmbed: true }); } finally { brain.engine.executeRaw = original; }
    expect(first.map(outcome)).toEqual(files.map(() => ({ error: null, message: 'simulated caller interruption' })));
    const resumed = await importManagedFiles(brain.engine, files, { sourceId, noEmbed: true });
    expect(resumed.map(result => result.status === 'fulfilled' && result.value.status)).toEqual(files.map(() => 'imported'));
    expect(await brain.engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [sourceId])).toHaveLength(files.length);
    expect(await brain.engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='managed-file-import' AND completed_keys->0->>'source_id'=$1", [sourceId])).toHaveLength(0);
  }
}), 300_000);

test('an import batch admits its members as one independent publication group', async () => withEnv(env, async () => {
  const [, brain] = pairs[0]!;
  const sourceId = `group-${randomUUID().slice(0, 8)}`;
  const root = await managedSource(brain.engine, sourceId, brain.label);
  const files = write(root, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`group-${i}.md`, page(`Group ${i}`)])));
  await disposePersistenceConsumer(brain.engine);
  const binding = (await getWorktreeBinding(brain.engine, sourceId))!;
  const ctx = { engine: brain.engine, remote: false, sourceId, config: { engine: brain.engine.kind } } as OperationContext;
  const batch = randomUUID();
  const admissions = await Promise.all(files.map(async file => {
    const bytes = readFileSync(file.filePath);
    const { slug, content } = managedImportContent(file.sourcePath, bytes);
    const prepared = await preparePageAdmission(ctx, { operation: 'put_page', managedFileImport: true, params: { kind: 'managed_file_import', slug, content,
      sourcePath: file.sourcePath, path: file.sourcePath, inputPath: file.filePath, inputHash: sha256(bytes), targetHash: sha256(bytes),
      ownerEpoch: String(binding.owner_epoch), noEmbed: true, import_batch: batch, request_id: randomUUID(), source_id: sourceId } });
    return prepared.admission!;
  }));
  const rows = await admitBatch(ctx, batch, admissions);
  const head = (await claimNextWrite(brain.engine, localHostId()))!;
  expect(head.id).toBe(rows[0]!.id);
  const key = publicationGroupKey(head);
  expect(key).toBe(`import:${batch}`);
  expect(independentGroup(key)).toBe(true);
  const followers = await claimGroupFollowers(brain.engine, head, key!, 7);
  expect(followers.map(row => row.id)).toEqual(rows.slice(1, 8).map(row => row.id));
  for (const row of [head, ...followers]) await releaseUnpublishedClaim(brain.engine, row, 'group_member_waiting');
  const settled = await waitForWrites(brain.engine, rows, ctx.config, 60_000);
  expect(settled.map(row => row.state)).toEqual(files.map(() => 'committed'));
}), 300_000);

test('a batch admission whose COMMIT acknowledgment is lost replays its admitted rows; one that keeps dropping is write_outcome_unknown and resumes', async () => withEnv(env, async () => {
  for (const [, brain] of pairs) {
    const sourceId = `loss-${randomUUID().slice(0, 8)}`;
    await managedSource(brain.engine, sourceId, brain.label);
    const original = { transaction: brain.engine.transaction, reconnect: brain.engine.reconnect };
    // Group admission transactions (the ones that read and insert request rows) commit, then the socket closes before the client hears back.
    const lose = (times: number) => {
      let drops = 0;
      brain.engine.reconnect = (async () => undefined) as BrainEngine['reconnect'];
      brain.engine.transaction = (async <T>(fn: (tx: BrainEngine) => Promise<T>) => {
        let admits = false;
        const value = await original.transaction.call(brain.engine, (tx: BrainEngine) => {
          const seen = Object.create(tx) as BrainEngine;
          seen.executeRaw = ((sql: string, params?: unknown[], opts?: unknown) => {
            if (sql.includes('INSERT INTO persistence_requests') || sql.includes('principal_id=$2 AND request_id=ANY($3::uuid[])')) admits = true;
            return tx.executeRaw(sql, params, opts as never);
          }) as BrainEngine['executeRaw'];
          return fn(seen);
        });
        if (admits && drops < times && ++drops) throw Object.assign(new Error('write CONNECTION_CLOSED 127.0.0.1:5432'), { code: 'CONNECTION_CLOSED' });
        return value as T;
      }) as BrainEngine['transaction'];
      return () => drops;
    };
    const restore = () => Object.assign(brain.engine, original);
    const once = write(join(home, `${brain.label}-${sourceId}-once`), Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`once-${i}.md`, page(`Once ${i}`)])));
    const drops = lose(1);
    let settled: PromiseSettledResult<{ status: string }>[];
    try { settled = await importManagedFiles(brain.engine, once, { sourceId, noEmbed: true }); } finally { restore(); }
    expect(drops()).toBe(1);
    expect(settled.map(result => result.status === 'fulfilled' && result.value.status)).toEqual(once.map(() => 'imported'));
    // The re-run is a read: one row per file, under the request id and digest its durable intent recorded before admission.
    const recorded = async (prefix: string) => (await brain.engine.executeRaw<{ slug: string; request_id: string; digest: string }>(
      `SELECT slug,request_id::text AS request_id,digest FROM persistence_requests WHERE source_id=$1 AND slug LIKE $2 ORDER BY slug`, [sourceId, `${prefix}-%`]));
    expect((await recorded('once')).map(row => row.slug)).toEqual(once.map((_, i) => `once-${i}`));
    const always = write(join(home, `${brain.label}-${sourceId}-always`), Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`always-${i}.md`, page(`Always ${i}`)])));
    lose(Number.POSITIVE_INFINITY);
    try { settled = await importManagedFiles(brain.engine, always, { sourceId, noEmbed: true }); } finally { restore(); }
    expect(settled.map(result => result.status === 'rejected' && (result.reason as { code?: string }).code)).toEqual(always.map(() => 'write_outcome_unknown'));
    const admitted = await recorded('always');
    expect(admitted).toHaveLength(always.length);
    // Each file's error names its own request id to read, the one its row was admitted under.
    expect(settled.map(result => (result as PromiseRejectedResult).reason.fix?.argv?.at(-1))).toEqual(admitted.map(row => row.request_id));
    const resumed = await importManagedFiles(brain.engine, always, { sourceId, noEmbed: true });
    expect(resumed.map(result => result.status === 'fulfilled' && result.value.status)).toEqual(always.map(() => 'imported'));
    expect(await recorded('always')).toEqual(admitted);
  }
}), 300_000);

test('an unchanged re-import screens its files with one read of each batch-shared value', async () => withEnv(env, async () => {
  for (const [, brain] of pairs) {
    const sourceId = `screen-${randomUUID().slice(0, 8)}`;
    const root = await managedSource(brain.engine, sourceId, brain.label);
    const files = write(root, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`notes/screen-${i}.md`, page(`Screen ${i}`)])));
    expect((await importManagedFiles(brain.engine, files, { sourceId, noEmbed: true })).every(r => r.status === 'fulfilled' && r.value.status === 'imported')).toBe(true);
    const counted = new Map<string, number>();
    const original = brain.engine.executeRaw;
    brain.engine.executeRaw = async function(this: BrainEngine, sql, params, opts) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      for (const key of ['FROM persistence_local_writers', 'FROM shared_skill_packs', "profile='company-brain'", 'FROM sources s LEFT JOIN persistence_source_bindings'])
        if (flat.includes(key)) counted.set(key, (counted.get(key) ?? 0) + 1);
      return original.call(this, sql, params, opts);
    } as BrainEngine['executeRaw'];
    let again: PromiseSettledResult<unknown>[];
    try { again = await importManagedFiles(brain.engine, files, { sourceId, noEmbed: true }); } finally { brain.engine.executeRaw = original; }
    expect(again.map(r => r.status === 'fulfilled' && (r.value as { status: string }).status)).toEqual(files.map(() => 'skipped'));
    // A per-file screen would read each of these at least once per file (12 here).
    for (const key of counted.keys()) expect({ key, perBatch: counted.get(key)! <= 4 }).toEqual({ key, perBatch: true });
    expect(counted.size).toBe(4);
  }
}), 300_000);
