/**
 * The writer-admin digest on a server whose default collation is not byte order (en_US.utf8).
 *
 * `writerAdminState` (what `gbrain sources writer status` returns as the reviewed `--expected-state`) and
 * `assertWriterAdminState` (what every administrative request checks it against, through `readWriterAdminState`) must
 * hash the same text. With source ids `a-b` and `aa` the two orders differ under en_US.utf8 (`aa` before `a-b`) and under
 * `COLLATE "C"` (`a-b` before `aa`), so a digest taken in one order is refused in the other.
 *
 * Protects: a digest taken by `writerAdminState` is accepted by `assertWriterAdminState` right away, and equals the hash of
 * `readWriterAdminState`, on a database whose collation differs from byte order.
 * Fails when the two read the topology with different statements. The test needs a database whose default
 * collation differs from byte order; on a C-locale server it still runs and passes without proving the point.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertWriterAdminState, writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { sha256 } from '../../src/core/persistence/digest.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';

let engine: PostgresEngine | undefined;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!hasDatabase()) return;
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 4);
  engine = pg.engine; close = pg.close;
  for (const id of ['a-b', 'aa', 'a_c', 'ab']) await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [id]);
}, 120_000);
afterAll(async () => { await close?.(); });

describe.skipIf(!hasDatabase())('the writer-admin digest on a non-C collation', () => {
  test('the digest writer status hands out is the one a request checks, and the request accepts it', async () => {
    const [{ collation }] = await engine!.executeRaw<{ collation: string }>("SELECT datcollate AS collation FROM pg_database WHERE datname = current_database()");
    const digest = await writerAdminState(engine!);
    expect(digest, `database collation ${collation}`).toBe(sha256(await engine!.readWriterAdminState()));
    await expect(assertWriterAdminState(engine!, digest, false)).resolves.toBeUndefined();
  });
});
