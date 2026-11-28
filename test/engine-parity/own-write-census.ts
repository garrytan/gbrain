/**
 * The own-write census on the parity harness's Postgres arm: every row the engine commits must be in a transaction the
 * own-write count booked (src/core/postgres-engine/own-writes.ts).
 *
 * The shadow seal lets the database's write counters move by exactly this process's own counted writes. A write path
 * that skips the count (a statement on a reserved connection, a DO block, a pool the counting does not wrap) leaves the
 * counters ahead, so the seal refuses after every session that used it. The census finds such a path: a row trigger
 * on every table of the arm's schema notes each committed row change with its backend pid and transaction start
 * (`now()`); after each case every noted change must belong to a transaction the counter reported as booked. Rows in
 * a rolled-back transaction vanish from the notes with it, so only committed writes are checked.
 *
 * Left out by decision: changes made while the schema lock is held (initSchema's replay and the migrations, advisory
 * lock 42, src/core/postgres-engine/init-schema-lock.ts). They run once at startup, before the shadow attaches and
 * turns the count on; a schema replay later in a session leaves the counters ahead, and that session's seal refuses.
 *
 * On for the Postgres arm when the server can count exactly (Postgres 15+, a role that may force a stats flush);
 * `GBRAIN_TEST_OWN_WRITE_CENSUS=0` turns it off. A case that writes through a second engine
 * (`ctx.unconnectedEngine`) is not checked: that engine's writes are foreign to the arm's count.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';

interface CounterView { onBooked: ((pid: string, at: string) => void) | null }

export interface OwnWriteCensus {
  /** Forget every note and booked transaction: call after the arm's reset, before the case. */
  clear(): Promise<void>;
  /** The committed changes no booked transaction holds, one entry per distinct relation, operation and statement. */
  uncounted(): Promise<string[]>;
}

const SETUP_SQL = `
CREATE SCHEMA IF NOT EXISTS own_census;
CREATE TABLE IF NOT EXISTS own_census.writes (pid int NOT NULL, at text NOT NULL, rel text NOT NULL, op text NOT NULL, q text);
ALTER TABLE own_census.writes ADD COLUMN IF NOT EXISTS schema boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION own_census.note() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $f$
BEGIN
  INSERT INTO own_census.writes VALUES (pg_backend_pid(), now()::text, TG_TABLE_NAME, TG_OP, left(current_query(), 240),
    EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0 AND objid = 42 AND granted));
  RETURN NULL;
END $f$;
GRANT USAGE ON SCHEMA own_census TO PUBLIC;
DO $d$ DECLARE t text; BEGIN
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relkind = 'r' LOOP
    EXECUTE format('CREATE TRIGGER zz_own_write_census AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION own_census.note()', t);
  END LOOP;
END $d$;`;

/** Whether the census runs on this process's Postgres arm. */
export function ownWriteCensusRequested(): boolean {
  return process.env.GBRAIN_TEST_OWN_WRITE_CENSUS !== '0';
}

/**
 * Installs the census on a freshly opened Postgres arm and turns the engine's own-write count on for every table of
 * its schema. Null where the count cannot be exact on this server (the census would only report that).
 */
export async function openOwnWriteCensus(engine: BrainEngine): Promise<OwnWriteCensus | null> {
  const pg = engine as PostgresEngine;
  const tables = (await pg.executeRaw<{ relname: string }>(
    `SELECT c.relname::text AS relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r'`,
  )).map((r) => r.relname);
  const ledger = await pg.countOwnWrites(tables);
  if (!ledger) return null;
  await pg.executeRaw(SETUP_SQL);
  const counter = (pg as unknown as { _ownWrites: CounterView })._ownWrites;
  const booked = new Set<string>();
  counter.onBooked = (pid, at) => { booked.add(`${pid}|${at}`); };
  return {
    async clear() {
      await pg.executeRaw('DELETE FROM own_census.writes');
      booked.clear();
    },
    async uncounted() {
      // A transaction the case did not wait for may commit just before its booking: look again for a moment.
      let missing: string[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        const rows = await pg.executeRaw<{ pid: number; at: string; rel: string; op: string; q: string | null }>(
          'SELECT DISTINCT pid, at, rel, op, q FROM own_census.writes WHERE NOT schema ORDER BY rel, op, q',
        );
        missing = [...new Set(rows.filter((r) => !booked.has(`${r.pid}|${r.at}`)).map((r) => `${r.rel} ${r.op}: ${(r.q ?? '').replace(/\s+/g, ' ').trim()}`))];
        if (missing.length === 0) return [];
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return missing;
    },
  };
}
