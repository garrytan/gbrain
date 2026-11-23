/**
 * Forget's database expiry keeps master's time-zone semantics.
 *
 * 1. Protects: in a session whose TimeZone is not UTC, `expireFactAtDate` with a `'YYYY-MM-DD'` text ends the row at
 *    the value master's file-mirror stamp (`UPDATE facts SET valid_until = $1` with today's text) stores: midnight in
 *    that zone on PGLite, UTC midnight on Postgres (postgres.js turns the text into a Date for the timestamptz
 *    parameter); and forget on a source with a checkout stores master's valid_until on every path: a supersession ends the
 *    row at the replacement's instant (master bound `validUntil.toISOString()`), a retirement and a withdrawal at now.
 * 2. Fails when: the member stores a day text differently from master's statement on the same engine (a fixed UTC
 *    midnight on PGLite), or a forget path moves an end.
 * 3. Out of scope: the Rust store (no session zone; a day text is UTC midnight there, see
 *    test/engine-parity/forget-whole.test.ts). On master and here, the retirement and the withdrawal expire the row
 *    before the file mirror runs (forget.ts:168, withdrawal.ts expireFactsByWithdrawal), so the mirror's stamp finds
 *    it expired and changes nothing: the day-text case calls the member directly.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { forgetFactInFence } from '../src/core/facts/forget.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { withEnv } from './helpers/with-env.ts';

const ZONE = 'America/Los_Angeles';
const home = mkdtempSync(join(tmpdir(), 'gbrain-forget-zone-'));
const engines: Array<{ name: string; engine: BrainEngine }> = [];
const closers: Array<() => Promise<void>> = [];

const fence = (claims: string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${claims.map((claim, i) => `| ${i + 1} | ${claim} | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |`).join('\n')}
<!--- gbrain:facts:end -->`;
const filler = (sections: number) => Array.from({ length: sections }, (_, i) => `## Part ${i}\n\n${'Notes on hiring and the budget review. '.repeat(30)}\n\n`).join('');

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema();
  await lite.executeRaw(`SET TIME ZONE '${ZONE}'`);
  engines.push({ name: 'pglite', engine: lite });
  if (process.env.DATABASE_URL) {
    // A database-level zone, so every pooled connection runs in it (a session SET reaches one connection only).
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    await pg.engine.executeRaw(`DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET TimeZone = %L', current_database(), '${ZONE}'); END $$`);
    await pg.engine.disconnect();
    const zoned = new PostgresEngine(); await zoned.connect({ database_url: pg.databaseUrl, poolSize: 4 });
    engines.push({ name: 'postgres', engine: zoned });
    closers.push(pg.close);
  }
  for (const { engine } of engines) { await registerLocalWriter(engine, 'cli'); await engine.setConfig('pages.segmented_storage', 'on'); }
}), 120_000);
afterAll(async () => {
  for (const { engine } of engines) await engine.disconnect().catch(() => undefined);
  for (const close of closers) await close().catch(() => undefined);
  rmSync(home, { recursive: true, force: true });
});

async function seed(engine: BrainEngine, root: string, slug: string, claims: string[], sections: number): Promise<number[]> {
  const content = `---\ntitle: Zone\ntype: note\n---\n\n# Zone\n\n## Facts\n\n${fence(claims)}\n\n${filler(sections)}`;
  writeFileSync(join(root, `${slug}.md`), content);
  await importFromContent(engine, slug, content, { noEmbed: true, sourceId: 'default' });
  const ids: number[] = [];
  for (const [i, claim] of claims.entries()) {
    const [fact] = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source,source_markdown_slug,row_num,valid_from)
      VALUES ('default',$1,$2,'world','test',$2,$3,'2026-01-01') RETURNING id`, [claim, slug, i + 1]), TEST_WRITE_ATTRIBUTION));
    ids.push(Number(fact!.id));
  }
  return ids;
}

describe('forget expiry in a non-UTC session zone', () => {
  test('supersession, retirement and withdrawal store master\'s valid_until on a source with a checkout', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const [index, { name, engine }] of engines.entries()) {
      const [{ zone }] = await engine.executeRaw<{ zone: string }>("SELECT current_setting('TimeZone') AS zone");
      expect(`${name} ${zone}`).toBe(`${name} ${ZONE}`);
      const root = mkdtempSync(join(home, `brain-${index}-`));
      mkdirSync(join(root, 'notes'));
      await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
      const today = new Date().toISOString().slice(0, 10);
      const until = new Date('2026-03-04T05:06:07.000Z');
      for (const [storage, sections] of [['inline', 2], ['segmented', 1500]] as const) {
        const slug = `notes/zone-${storage}`;
        const [superseded, retired, withdrawn] = await seed(engine, root, slug, [`Prefers the ${storage} aisle`, `Drinks ${storage} tea`, `Walks the ${storage} path`], sections);
        const forget = (id: number, opts: Parameters<typeof forgetFactInFence>[2]) =>
          withCoordinatedWrite(engine, ['default'], () => forgetFactInFence(engine, id, opts), TEST_WRITE_ATTRIBUTION);
        expect(await forget(superseded!, { supersededBy: { rowNum: null, validUntil: until } })).toMatchObject({ ok: true });
        expect(await forget(retired!, { retired: 'source item deleted' })).toMatchObject({ ok: true });
        expect(await forget(withdrawn!, {})).toMatchObject({ ok: true });
        const rows = await engine.executeRaw<{ id: number; until_utc: string; expired: boolean; at_today: boolean; at_now: boolean }>(
          `SELECT id, to_char(valid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS until_utc, expired_at IS NOT NULL AS expired,
             valid_until = $2::text::timestamptz AS at_today, valid_until >= now() - interval '10 minutes' AS at_now
           FROM facts WHERE id = ANY($1::bigint[]) ORDER BY id`, [[superseded, retired, withdrawn], today]);
        const by = new Map(rows.map(r => [Number(r.id), r]));
        // Master forget.ts:195 bound validUntil.toISOString(): the replacement's instant, whatever the zone.
        expect(`${name} ${storage} ${by.get(superseded!)!.until_utc}`).toBe(`${name} ${storage} 2026-03-04T05:06:07`);
        for (const id of [superseded!, retired!, withdrawn!]) expect(`${name} ${storage} ${id} ${by.get(id)!.expired}`).toBe(`${name} ${storage} ${id} true`);
        // The retirement and the withdrawal expire before the file mirror runs, so they end now.
        for (const id of [retired!, withdrawn!]) expect(`${name} ${storage} ${id} now=${by.get(id)!.at_now}`).toBe(`${name} ${storage} ${id} now=true`);
      }
      // The file-mirror stamp's member binds the day text as master's statement did (forget.ts:359 on master, run here
      // verbatim on a twin row): PGLite casts it to midnight in the session zone; postgres.js serializes a text bound
      // to a timestamptz parameter through \`new Date(text)\`, so Postgres stores UTC midnight, on master and here.
      const [stamped, twin] = await seed(engine, root, 'notes/zone-stamp', ['Takes the early train', 'Takes the late train'], 2);
      await engine.expireFactAtDate(stamped!, today);
      await engine.executeRaw(`UPDATE facts SET valid_until = $1, expired_at = now()
         WHERE id = $2 AND expired_at IS NULL`, [today, twin]);
      const ends = await engine.executeRaw<{ id: number; at_zone_midnight: boolean; at_utc_midnight: boolean }>(
        `SELECT id, valid_until = $2::text::timestamptz AS at_zone_midnight, valid_until = ($2::text || 'T00:00:00Z')::timestamptz AS at_utc_midnight
         FROM facts WHERE id = ANY($1::bigint[]) ORDER BY id`, [[stamped, twin], today]);
      const end = (id: number) => { const r = ends.find(e => Number(e.id) === id)!; return `zone=${r.at_zone_midnight} utc=${r.at_utc_midnight}`; };
      expect(`${name} ${end(stamped!)}`).toBe(`${name} ${end(twin!)}`);
      expect(`${name} ${end(stamped!)}`).toBe(name === 'pglite' ? `${name} zone=true utc=false` : `${name} zone=false utc=true`);
    }
  }), 300_000);
});
