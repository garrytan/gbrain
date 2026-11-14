/**
 * GBRA-498: `--room` on the CLI, as real subprocesses against repo-less PGLite brains on disk (no git checkout).
 *
 * 1. Protects: a command that names a room prints exactly what it reads and marks every item (`room_access`), on the
 *    direct path and through a live PGLite owner; a `--room` with no value is a declared room that could not be read
 *    (every item unknown, reason invalid, the degraded stamp, exit 0), never a dropped flag; `--json` carries
 *    `_meta.room` (an array becomes `{ results, _meta }`); with no owner the CLI is unbound and says how to name one;
 *    `--as` marks the member's view; a write marks its own result without a degraded stamp; a command outside the
 *    operations runs unchanged and says it marks nothing.
 * 2. Fails when: a trailing `--room` is swallowed and the answer comes back unannotated, a room changes what is
 *    printed, or a delegated answer loses its marks.
 * 3. Existing coverage: test/access-room.test.ts holds the in-process assessment; nothing covered the CLI seam.
 * 4. Real seams: src/core/cli-options.ts global flags, runSharedOperation, the persistence IPC owner.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { createPersistenceIpcProvider } from '../src/core/persistence/provider.ts';
import { persistenceSocketPathForConfig, requestPersistenceOperation, startPersistenceIpcServer } from '../src/core/persistence/ipc.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { addMember } from '../src/core/access/members.ts';
import { clearOwner, setOwner } from '../src/core/access/owner.ts';
import { delegatedRoom, roomSummaryLine, routedRoom } from '../src/cli/room.ts';
import { reviewedWriterIntent } from './helpers/writer-admin-intent.ts';
import { withEnv } from './helpers/with-env.ts';
import { importFromContent } from '../src/core/import-file.ts';

const CLI = join(resolve(import.meta.dir, '..'), 'src', 'cli.ts');
const OPEN = 'notes/open-plan';
const MINE = 'notes/owner-plan';

function env(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete out[key];
  return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', GBRAIN_NO_BANNER: '1' };
}

async function cli(root: string, home: string, args: string[], stdin?: string, extra: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: { ...env(home), ...extra }, stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

async function seed(engine: BrainEngine): Promise<void> {
  await importFromContent(engine, OPEN, '---\ntype: note\ntitle: Open plan\n---\nHarbor ledger open notes.\n', { sourceId: 'default', noEmbed: true });
  await importFromContent(engine, MINE, '---\ntype: note\ntitle: Owner plan\nreadable_by: [owner-example]\n---\nHarbor ledger owner notes.\n', { sourceId: 'default', noEmbed: true });
  for (const id of ['owner-example', 'alice-example']) await addMember(engine, id);
  await setOwner(engine, 'owner-example');
}

const marks = (items: Array<{ slug?: string; room_access?: unknown }>) => Object.fromEntries(items.filter(i => i.slug).map(i => [i.slug!, i.room_access]));

describe('--room on the direct path (repo-less PGLite)', () => {
  let root: string, home: string, db: string;
  const run = (args: string[], stdin?: string, extra?: Record<string, string>) => cli(root, home, args, stdin, extra);
  async function withBrain<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    const config = { engine: 'pglite' as const, database_path: db };
    const engine = await createEngine(config);
    await engine.connect(config);
    try { return await fn(engine); } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  }
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gb-room-cli-'));
    home = join(root, 'home');
    db = join(root, 'db');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db }));
    await withBrain(async engine => { await engine.initSchema(); await seed(engine); });
  }, 180_000);
  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

  test('--json marks every item and carries _meta.room; the room changes nothing else', async () => {
    const plain = await run(['list', '--json']);
    const roomed = await run(['list', '--json', '--room', 'alice-example']);
    expect(roomed.exitCode).toBe(0);
    const doc = JSON.parse(roomed.stdout) as { results: Array<Record<string, unknown>>; _meta: { room: Record<string, unknown> } };
    expect(marks(doc.results)).toEqual({ [OPEN]: { readable: true }, [MINE]: { readable: false, reason: 'readers' } });
    expect(doc._meta.room).toMatchObject({ principals: ['member:alice-example'], complete: true, counts: { items: 2, readable: 1, above: 1, unknown: 0 } });
    expect(doc.results.map(({ room_access: _r, ...rest }) => rest)).toEqual(JSON.parse(plain.stdout));
  }, 120_000);

  test('the Critical: a --room with no value marks every item unknown (invalid) with the degraded stamp, and exits 0', async () => {
    for (const args of [['list', '--json', '--room'], ['list', '--room', '--json'], ['list', '--json', '--room=']]) {
      const out = await run(args);
      expect({ args, exitCode: out.exitCode }).toEqual({ args, exitCode: 0 });
      const doc = JSON.parse(out.stdout) as { results: Array<Record<string, unknown>>; _meta: { room: Record<string, unknown> }; degraded?: unknown };
      expect(doc.results.length).toBe(2);
      expect(Object.values(marks(doc.results))).toEqual([{ readable: 'unknown', reason: 'invalid' }, { readable: 'unknown', reason: 'invalid' }]);
      expect(doc._meta.room).toMatchObject({ complete: false, unavailable: 'invalid' });
      expect(doc.degraded).toBeDefined();
    }
    const human = await run(['query', 'harbor ledger', '--room']);
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toContain('[gbrain degraded:');
    expect(human.stderr).toContain('[gbrain room: no one readable] no item could be judged (invalid)');
  }, 180_000);

  test('search and query --json keep their own rendering (answer ids, --explain) inside the room document', async () => {
    const out = await run(['search', 'harbor', '--json', '--explain', '--room', 'alice-example']);
    expect(out.exitCode).toBe(0);
    const doc = JSON.parse(out.stdout) as { results: Array<Record<string, unknown>>; _meta: { room: Record<string, unknown> } };
    expect(Array.isArray(doc.results)).toBe(true);
    expect(doc.results.length).toBeGreaterThan(0);
    for (const r of doc.results) { expect(r.room_access).toBeDefined(); expect(r.score_details).toBeDefined(); }
    expect(doc._meta.room).toMatchObject({ principals: ['member:alice-example'] });
  }, 180_000);

  test('human output is unchanged on stdout; stderr names what the room cannot read', async () => {
    const plain = await run(['list']);
    const roomed = await run(['list', '--room', 'alice-example']);
    expect(roomed.exitCode).toBe(0);
    expect(roomed.stdout).toBe(plain.stdout);
    expect(roomed.stderr).toContain('[gbrain room: member:alice-example] 1 of 2 items readable by the room, 1 above its level, 0 unknown');
    expect(roomed.stderr).toContain('default:' + MINE + ' (readers)');
  }, 120_000);

  test('--as marks the member view; a write marks its own page and is never stamped degraded', async () => {
    const asAlice = await run(['list', '--json', '--as', 'alice-example', '--room', 'alice-example']);
    expect(asAlice.exitCode).toBe(0);
    expect(marks((JSON.parse(asAlice.stdout) as { results: Array<Record<string, unknown>> }).results)).toEqual({ [OPEN]: { readable: true } });
    const put = await run(['put', 'notes/room-cli-plan', '--json', '--room', 'alice-example'], '---\ntype: note\ntitle: Room cli plan\nreadable_by: [owner-example]\n---\n# Room cli plan\n');
    expect(put.exitCode).toBe(0);
    const doc = JSON.parse(put.stdout) as { room_access?: unknown; degraded?: unknown; _meta?: { room?: unknown } };
    expect(doc.room_access).toEqual({ readable: false, reason: 'readers' });
    expect(doc.degraded).toBeUndefined();
    expect(doc._meta?.room).toMatchObject({ counts: { items: 1, above: 1 } });
  }, 120_000);

  test('with no owner the CLI is unbound and the notice says how to name one; a command outside the operations says it marks nothing', async () => {
    await withBrain(engine => clearOwner(engine));
    try {
      const out = await run(['list', '--room', 'alice-example']);
      expect(out.exitCode).toBe(0);
      expect(out.stderr).toContain('no item could be judged (unbound)');
      expect(out.stderr).toContain('gbrain access owner set');
    } finally { await withBrain(engine => setOwner(engine, 'owner-example')); }
    const offline = await run(['errors', 'no_brain', '--room', 'alice-example']);
    expect(offline.stderr).toContain('[gbrain room] gbrain errors does not mark its results for a room');
  }, 180_000);
});

describe('--room under an enforced member', () => {
  test('a CLI held to one member may not ask what another room reads: every item unknown (not_permitted), the read unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gb-room-enforced-'));
    const home = join(root, 'home'), db = join(root, 'db');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db }));
    const config = { engine: 'pglite' as const, database_path: db };
    const engine = await createEngine(config);
    await engine.connect(config);
    try { await engine.initSchema(); await seed(engine); } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    try {
      const out = await cli(root, home, ['list', '--json', '--room', 'owner-example'], undefined, { GBRAIN_ENFORCED_MEMBER: 'alice-example' });
      expect(out.exitCode).toBe(0);
      const doc = JSON.parse(out.stdout) as { results: Array<Record<string, unknown>>; _meta: { room: Record<string, unknown> } };
      expect(Object.keys(marks(doc.results))).toEqual([OPEN]);
      expect(Object.values(marks(doc.results))).toEqual([{ readable: 'unknown', reason: 'not_permitted' }]);
      expect(doc._meta.room).toMatchObject({ complete: false, unavailable: 'not_permitted' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 180_000);
});

describe('--room through a live PGLite owner', () => {
  let dir: string;
  let engine: PGLiteEngine;
  let binding: Awaited<ReturnType<typeof startPersistenceIpcServer>>;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gb-room-owner-'));
    const config = { engine: 'pglite' as const, database_path: join(dir, 'db') };
    await withEnv({ GBRAIN_HOME: dir, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      engine = new PGLiteEngine();
      await engine.connect(config);
      await engine.initSchema();
      await seed(engine);
      mkdirSync(join(dir, '.gbrain'), { recursive: true });
      writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify(config));
      const provider = await createPersistenceIpcProvider(engine, config);
      await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewedWriterIntent(engine, 'writer_activate') });
      binding = await startPersistenceIpcServer(persistenceSocketPathForConfig(config)!, provider);
    });
  }, 180_000);
  afterAll(async () => {
    if (binding) { const closed = once(binding.server, 'close'); binding.close(); await closed; }
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  test('the owner marks a delegated read for the room', async () => {
    const out = await cli(dir, dir, ['get', MINE, '--json', '--room', 'alice-example']);
    expect(out.exitCode).toBe(0);
    const doc = JSON.parse(out.stdout) as { slug: string; room_access?: unknown; _meta?: { room?: unknown } };
    expect(doc.slug).toBe(MINE);
    expect(doc.room_access).toEqual({ readable: false, reason: 'readers' });
    expect(doc._meta?.room).toMatchObject({ principals: ['member:alice-example'], counts: { items: 1, above: 1 } });
  }, 120_000);

  test('a room too long for the owner socket still runs the read, every item unknown', async () => {
    const room = Array.from({ length: 400 }, (_, i) => 'member-' + i + '-example').join(',');
    const out = await cli(dir, dir, ['get', MINE, '--json', '--room', room]);
    expect(out.exitCode).toBe(0);
    const doc = JSON.parse(out.stdout) as { slug: string; room_access?: unknown };
    expect(doc.slug).toBe(MINE);
    expect(doc.room_access).toEqual({ readable: 'unknown', reason: 'invalid' });
  }, 120_000);
});

describe('--room fallbacks for a brain that cannot mark', () => {
  test('an owner or host that predates room marks leaves every item unknown, never unmarked', async () => {
    const owner = await delegatedRoom('get_page', { result: { slug: MINE } }, 'alice-example');
    expect((owner.result as { room_access: unknown }).room_access).toEqual({ readable: 'unknown', reason: 'not_supported' });
    const host = await routedRoom('list_pages', [{ slug: OPEN }], undefined, 'alice-example');
    expect(host.local).toBe(true);
    expect((host.marked.result as Array<{ room_access: unknown }>)[0]!.room_access).toEqual({ readable: 'unknown', reason: 'not_supported' });
    const capped = await routedRoom('list_pages', [{ slug: OPEN }], { complete: false, unavailable: 'response_cap' }, 'alice-example');
    expect(capped.marked.meta.unavailable).toBe('response_cap');
    const marked = { principals: ['member:alice-example'], complete: true };
    const fromHost = await routedRoom('list_pages', [{ slug: OPEN, room_access: { readable: true } }], marked, 'alice-example');
    expect({ local: fromHost.local, meta: fromHost.marked.meta }).toEqual({ local: false, meta: marked as never });
  });

  test('the summary lists at most 20 items, then how many more', () => {
    const above = Array.from({ length: 23 }, (_, i) => ({ source_id: 'default', slug: 'notes/p' + i, reason: 'readers' }));
    const text = roomSummaryLine({ principals: ['member:alice-example'], declared_by: 'harness', complete: true, counts: { items: 23, readable: 0, above: 23, unknown: 0 }, by_reason: { readers: 23 }, above });
    expect(text.trimEnd().split('\n').length).toBe(22);
    expect(text).toContain('and 3 more');
  });
});

describe('the owner socket accepts a room only as a bounded string', () => {
  const request = (extra: Record<string, unknown>) => ({ version: 1, kind: 'operation', brain_id: '00000000-0000-4000-8000-000000000001', operation: 'get_page', params: { slug: OPEN },
    registration: { id: '00000000-0000-4000-8000-000000000002', credential: 'a'.repeat(64), lane: 'cli' }, routing: { source: null, cwd: '/tmp' }, ...extra });
  // A valid envelope reaches the (absent) socket and fails there; an invalid one is refused before anything is sent.
  const accepted = async (extra: Record<string, unknown>) => {
    try { await requestPersistenceOperation(join(tmpdir(), 'gb-room-no-socket-' + process.pid), request(extra) as never, 500); return 'sent'; }
    catch (e) { return String((e as { code?: unknown }).code) === 'invalid_params' ? 'refused' : 'sent'; }
  };
  test('room alone or beside write_wait_ms passes; a non-string, an over-long room or an unknown key does not', async () => {
    expect(await accepted({})).toBe('sent');
    expect(await accepted({ room: 'alice-example' })).toBe('sent');
    expect(await accepted({ room: 'alice-example', write_wait_ms: 10 })).toBe('sent');
    expect(await accepted({ room: ['alice-example'] })).toBe('refused');
    expect(await accepted({ room: 'a'.repeat(4097) })).toBe('refused');
    expect(await accepted({ other: 1 })).toBe('refused');
  });
});
