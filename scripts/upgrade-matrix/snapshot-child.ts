#!/usr/bin/env bun
/**
 * Upgrade matrix snapshot child: prints a content (and with --catalog, a
 * catalog) snapshot of one brain as JSON on stdout.
 *
 *   bun scripts/upgrade-matrix/snapshot-child.ts --pglite <data dir> --install <gbrain package dir> [--catalog]
 *   bun scripts/upgrade-matrix/snapshot-child.ts --url <postgres url> [--catalog]
 *   bun scripts/upgrade-matrix/snapshot-child.ts <brain flags> --exec '<sql>; <sql>'   (runs the statements in order on one connection, prints nothing)
 *
 * A PGLite brain is opened with the PGLite build of the gbrain release that is
 * installed at that moment (resolved from --install), never the harness's own,
 * so the data directory only ever meets a PGLite version the brain's own
 * release would open it with. Run it only while no gbrain process holds the
 * brain.
 */
import { takeSnapshot, type Query } from './snapshot.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const catalog = argv.includes('--catalog');
const exec = flag('--exec');

let query: Query;
let close: () => Promise<void>;
const dataDir = flag('--pglite');
if (dataDir) {
  const install = flag('--install');
  if (!install) throw new Error('--pglite needs --install <gbrain package dir>');
  const load = async (spec: string) => import(Bun.resolveSync(spec, install));
  const { PGlite } = await load('@electric-sql/pglite');
  const { vector } = await load('@electric-sql/pglite/vector');
  const { pg_trgm } = await load('@electric-sql/pglite/contrib/pg_trgm');
  const db = await PGlite.create({ dataDir, extensions: { vector, pg_trgm } });
  query = async (sql, params) => (await db.query(sql, params ?? [])).rows as Record<string, unknown>[];
  close = () => db.close();
} else {
  const url = flag('--url');
  if (!url) throw new Error('pass --pglite <dir> --install <dir> or --url <postgres url>');
  const postgres = (await import('#postgres')).default;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  query = async (text, params) => [...await sql.unsafe(text, (params ?? []) as never[])] as Record<string, unknown>[];
  close = () => sql.end({ timeout: 5 });
}
try {
  if (exec) for (const statement of exec.split(';').map(s => s.trim()).filter(Boolean)) await query(statement);
  else process.stdout.write(JSON.stringify(await takeSnapshot(query, { catalog })) + '\n');
} finally {
  await close();
}
