/**
 * GST-2476 gap 1: the access read log.
 *
 * 1. Protects: a read a non-owner member or audience makes (a member-bound remote read, an enforced member CLI read)
 *    leaves one row: who, operation, transport, result code and the ids of the pages it returned, never text or query
 *    terms; `gbrain access log` and `gbrain access who-read` read it back; retention and the row cap delete the oldest.
 * 2. Fails when: an owner read or any read on a brain with no members writes a row (R94, keyless and solo brains), a
 *    logged read's answer changes, a hidden page's id is logged as returned, a query term lands in the log, a failed
 *    log write fails the read, or the CLI's teardown drain leaves buffered rows unwritten.
 * 3. Real seams: MCP dispatch over stdio with serve --stdio-member and enforcedMember (the path cli/enforced-member.ts
 *    takes), the access CLI module, the background-work drain; PGLite repo-less (Postgres too when DATABASE_URL is set).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { addMember } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { drainAllBackgroundWorkForCliExit } from '../src/core/background-work.ts';
import { __resetAccessReadLogForTests, flushAccessReadLog, pruneAccessReadLog } from '../src/core/access/read-log.ts';
import { runAccess } from '../src/commands/access.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'readlog';
const OPEN = 'notes/open-plan';
const ALICE = 'notes/alice-plan';
const BOB = 'notes/bob-plan';
const QUIET = 'notes/quiet-plan';
const DATED = 'notes/dated-plan';
const TERM = 'zebracanary';

async function capture(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await fn(); } finally { spy.mockRestore(); }
  return lines.join('\n');
}

async function seed(engine: BrainEngine): Promise<void> {
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
  const page = (slug: string, fm: string[]) => importFromContent(engine, slug, ['---', 'type: note', 'title: ' + slug, ...fm, '---', '# ' + slug, '', 'Plan notes ' + TERM + '.'].join('\n'), { sourceId: SRC, noEmbed: true });
  await page(OPEN, []);
  await page(ALICE, ['readable_by: [owner-example, alice-example]']);
  await page(BOB, ['readable_by: [owner-example, bob-example]']);
  await page(QUIET, ['visibility: private']);
  await page(DATED, ['readable_by: [owner-example, alice-example]', 'valid_from: 2026-01-01']);
}

const rows = async (engine: BrainEngine) => {
  await flushAccessReadLog();
  return engine.executeRaw<{ member: string | null; audience: string[] | null; operation: string; transport: string; result_code: string; page_ids: number[] }>(
    'SELECT member, audience, operation, transport, result_code, page_ids FROM access_read_log ORDER BY id');
};
const pageId = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [SRC, slug]))[0]!.id;
const call = (engine: BrainEngine, op: string, args: Record<string, unknown>, opts: Record<string, unknown>) =>
  dispatchToolCall(engine, op, args, { remote: true, transport: 'stdio', sourceId: SRC, takesHoldersAllowList: ['world'], ...opts });
const text = (r: { content: Array<{ text: string }> }) => r.content.map(c => c.text).join('\n');

for (const kind of testBackends()) {
  describe(`access read log: a brain with no members (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await seed(engine);
    });
    afterAll(async () => { __resetAccessReadLogForTests(); await close(); });

    test('remote and stdio reads write nothing', async () => {
      __resetAccessReadLogForTests();
      expect(text(await call(engine, 'get_page', { slug: OPEN }, {}))).toContain(TERM);
      await call(engine, 'search', { query: TERM }, {});
      await call(engine, 'get_page', { slug: OPEN }, { transport: 'http' });
      expect(await rows(engine)).toEqual([]);
    });
  });

  describe(`access read log: members (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await seed(engine);
      await addMember(engine, 'owner-example');
      await addMember(engine, 'alice-example');
      await addMember(engine, 'bob-example');
      await setOwner(engine, 'owner-example');
    });
    afterAll(async () => { __resetAccessReadLogForTests(); await close(); });
    beforeEach(async () => { __resetAccessReadLogForTests(); await engine.executeRaw('DELETE FROM access_read_log'); });

    test('R94: owner reads are answered in full and never logged', async () => {
      const owner = { stdioMember: 'owner-example' };
      for (const slug of [OPEN, ALICE, BOB, QUIET]) expect(text(await call(engine, 'get_page', { slug }, owner))).toContain(TERM);
      await call(engine, 'search', { query: TERM }, owner);
      expect(await rows(engine)).toEqual([]);
    });

    test('a member-bound read logs who, what and the pages returned; a hidden page is logged as refused with no id', async () => {
      const alice = { stdioMember: 'alice-example' };
      expect(text(await call(engine, 'get_page', { slug: ALICE }, alice))).toContain(TERM);
      const bob = await call(engine, 'get_page', { slug: BOB }, alice);
      expect(bob.isError).toBe(true);
      expect(text(bob)).not.toContain(TERM);
      const log = await rows(engine);
      expect(log).toEqual([
        { member: 'alice-example', audience: null, operation: 'get_page', transport: 'stdio', result_code: 'ok', page_ids: [await pageId(engine, ALICE)] },
        { member: 'alice-example', audience: null, operation: 'get_page', transport: 'stdio', result_code: expect.any(String), page_ids: [] },
      ]);
      expect(log[1]!.result_code).not.toBe('ok');
    });

    test('a temporal get_page (as_of) logs the page it returned', async () => {
      const out = await call(engine, 'get_page', { slug: DATED, as_of: new Date().toISOString().slice(0, 10) }, { stdioMember: 'alice-example' });
      expect(text(out)).toContain(TERM);
      expect((await rows(engine)).map(r => r.page_ids)).toEqual([[await pageId(engine, DATED)]]);
    });

    test('a search logs the readable pages it returned and never the query terms', async () => {
      const out = await call(engine, 'search', { query: TERM }, { stdioMember: 'alice-example' });
      expect(out.isError).toBeFalsy();
      const [row] = await rows(engine);
      expect(row).toMatchObject({ member: 'alice-example', operation: 'search', result_code: 'ok' });
      const visible = new Set([await pageId(engine, OPEN), await pageId(engine, ALICE), await pageId(engine, DATED)]);
      expect(row!.page_ids.length).toBeGreaterThan(0);
      for (const id of row!.page_ids) expect(visible.has(id)).toBe(true);
      expect(JSON.stringify(await engine.executeRaw('SELECT to_jsonb(l) - \'id\' AS row FROM access_read_log l'))).not.toContain(TERM);
    });

    test('an enforced member CLI read logs transport cli and the CLI teardown drain writes it', async () => {
      await call(engine, 'get_page', { slug: OPEN }, { stdioMember: 'alice-example', enforcedMember: true, admissionOrigin: 'interactive' });
      expect((await engine.executeRaw('SELECT 1 FROM access_read_log')).length).toBe(0);
      await drainAllBackgroundWorkForCliExit();
      const log = await engine.executeRaw<{ transport: string; member: string; page_ids: number[] }>('SELECT transport, member, page_ids FROM access_read_log');
      expect(log).toEqual([{ transport: 'cli', member: 'alice-example', page_ids: [await pageId(engine, OPEN)] }]);
    });

    test('gbrain access log and who-read read it back', async () => {
      await call(engine, 'get_page', { slug: ALICE }, { stdioMember: 'alice-example' });
      await call(engine, 'get_page', { slug: OPEN }, { stdioMember: 'bob-example' });
      await flushAccessReadLog();
      const log = JSON.parse(await capture(() => runAccess(engine, ['log', '--member', 'alice-example', '--since', '1h', '--json'])));
      expect(log.reads).toHaveLength(1);
      expect(log.reads[0]).toMatchObject({ member: 'alice-example', operation: 'get_page', result_code: 'ok', pages: [`${SRC}:${ALICE}`] });
      const who = JSON.parse(await capture(() => runAccess(engine, ['who-read', OPEN, '--source', SRC, '--json'])));
      expect(who.readers).toEqual([{ who: 'bob-example', reads: 1, last_at: expect.any(String) }]);
      expect(await capture(() => runAccess(engine, ['who-read', ALICE]))).toContain('alice-example  1 read(s)');
    });

    test('retention deletes rows past the window and beyond the cap, oldest first', async () => {
      await engine.executeRaw(`INSERT INTO access_read_log (created_at, member, operation, transport, result_code) VALUES
        (now() - interval '400 days', 'alice-example', 'get_page', 'stdio', 'ok'),
        (now() - interval '3 days', 'alice-example', 'get_page', 'stdio', 'ok'),
        (now() - interval '2 days', 'alice-example', 'search', 'stdio', 'ok'),
        (now() - interval '1 day', 'alice-example', 'query', 'stdio', 'ok')`);
      await pruneAccessReadLog(engine);
      expect((await rows(engine)).map(r => r.operation)).toEqual(['get_page', 'search', 'query']);
      await pruneAccessReadLog(engine, 365, 2);
      expect((await rows(engine)).map(r => r.operation)).toEqual(['search', 'query']);
    });

    test('a failed log write never fails the read', async () => {
      await engine.executeRaw('ALTER TABLE access_read_log RENAME TO access_read_log_away');
      try {
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(text(await call(engine, 'get_page', { slug: ALICE }, { stdioMember: 'alice-example' }))).toContain(TERM);
          await flushAccessReadLog();
        } finally { warn.mockRestore(); }
      } finally {
        await engine.executeRaw('ALTER TABLE access_read_log_away RENAME TO access_read_log');
      }
    });
  });
}
