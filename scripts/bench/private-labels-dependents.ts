#!/usr/bin/env bun
/**
 * Time the statement a `gbrain repair private-labels` preview (and every `--apply --expect`) runs to find the pages a
 * window's clears expose (windowDependents), on a synthetic Postgres brain. Opt-in, never run in CI.
 *
 *   bun scripts/bench/private-labels-dependents.ts [--pages 300000] [--other-pages 100000] [--links-per-page 8]
 *     [--lineage] [--window 1000] [--class alias|alias-and-visibility] [--checkout <gbrain checkout>]
 *     [--database-url <admin url>] [--keep] [--reuse-db <name>] [--label <name>] [--out <file.json>]
 *
 * Creates a scratch database (default admin URL: the CI compose Postgres on 127.0.0.1:5434) holding a source of --pages
 * pages and a second source of --other-pages plain pages. In the first source every 8th page carries an over-stamped
 * `access: private` (every other one also `visibility: private`); every 16th page is a life-chronicle event naming a
 * labelled page in event.depth; every 128th is an atom whose source_slug names one, and a synthesized concept links to
 * that atom; every 16th is a synthesized concept with a concept-provenance link to a labelled page. --lineage adds
 * pages whose derived_from names a labelled page (as a string, and as an array with `.md`) and events naming those
 * pages. Every page also carries --links-per-page ordinary links. Seeding runs with triggers off
 * (session_replication_role = replica), so the columns they stamp keep their defaults; the statement reads none of them.
 * --keep leaves the database for --reuse-db, which skips seeding.
 *
 * One preview of a --window window (of --class; default, the preview's default classes) then runs through --checkout's
 * code (default: this checkout), so the same script measures master and a branch. The report has the dependents
 * statement's wall time (or the error that ended it), its EXPLAIN plan (with ANALYZE when it finished) and the
 * preview's dependents counts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import postgres from '#postgres';

const REPO = resolve(import.meta.dir, '../..');
function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const PAGES = Number(flag('pages', '300000'));
const OTHER_PAGES = Number(flag('other-pages', '100000'));
const LINKS_PER_PAGE = Number(flag('links-per-page', '8'));
const LINEAGE = process.argv.includes('--lineage');
const REUSE = flag('reuse-db', '');
const CLASS = flag('class', '');
const WINDOW = Number(flag('window', '1000'));
const CHECKOUT = resolve(flag('checkout', REPO));
const ADMIN_URL = flag('database-url', 'postgres://postgres:postgres@127.0.0.1:5434/postgres');
const KEEP = process.argv.includes('--keep');
const COMMIT = (() => { try { return execFileSync('git', ['-C', CHECKOUT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })();
const LABEL = flag('label', COMMIT);
const OUT = resolve(flag('out', join(REPO, '.context', 'bench', 'private-labels-dependents-' + LABEL.replace(/[^\w.-]/g, '_') + '-' + Date.now() + '.json')));
const SOURCE = 'bench';
const log = (msg: string) => console.error('[private-labels-dependents ' + new Date().toISOString().slice(11, 19) + '] ' + msg);

const db = REUSE || 'gbrain_pldeps_' + randomBytes(4).toString('hex');
const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
if (!REUSE) await admin.unsafe('CREATE DATABASE ' + db);
const url = Object.assign(new URL(ADMIN_URL), { pathname: '/' + db }).toString();
const { PostgresEngine } = await import(join(CHECKOUT, 'src/core/postgres-engine.ts'));
const { privateLabelsRepair } = await import(join(CHECKOUT, 'src/core/repair/private-labels.ts'));
const engine = new PostgresEngine();
try {
  await engine.connect({ database_url: url });
  await engine.initSchema();
  const seedStart = performance.now();
  if (!REUSE) {
    const seed = postgres(url, { max: 1, onnotice: () => {} });
    await seed.unsafe('SET session_replication_role = replica');
    await seed.unsafe('SET statement_timeout = 0');
    const run = (sql: string) => seed.unsafe(sql);
    log('seeding ' + PAGES + ' + ' + OTHER_PAGES + ' pages and ' + LINKS_PER_PAGE + ' links per page into ' + db);
    await run(`INSERT INTO sources (id, name) VALUES ('${SOURCE}', '${SOURCE}'), ('other', 'other') ON CONFLICT (id) DO NOTHING`);
    await run(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter)
      SELECT 'notes/n-' || i, '${SOURCE}',
        CASE WHEN i % 128 = 9 THEN 'atom' WHEN i % 128 = 11 OR i % 16 = 5 THEN 'concept'
          WHEN i % 16 = 2 OR (${LINEAGE} AND i % 16 = 10) THEN 'event' ELSE 'note' END,
        'Note ' || i, 'body of note ' || i,
        CASE
          WHEN i % 16 = 0 THEN '{"access": "private"}'::jsonb
          WHEN i % 16 = 8 THEN '{"access": "private", "visibility": "private"}'::jsonb
          WHEN i % 128 = 9 THEN jsonb_build_object('source_slug', 'notes/n-' || (i - 1), 'visibility', 'world')
          WHEN i % 128 = 11 OR i % 16 = 5 THEN '{"synthesized_by": "dream", "visibility": "world"}'::jsonb
          WHEN i % 16 = 2 THEN jsonb_build_object('captured_via', 'life-chronicle:meeting', 'event', jsonb_build_object('depth', 'notes/n-' || (i - 2)))
          WHEN ${LINEAGE} AND i % 16 = 14 THEN jsonb_build_object('derived_from', 'notes/n-' || (i - 6))
          WHEN ${LINEAGE} AND i % 16 = 15 THEN jsonb_build_object('derived_from', jsonb_build_array('notes/n-' || (i - 7) || '.md', 'notes/never-written'))
          WHEN ${LINEAGE} AND i % 16 = 10 THEN jsonb_build_object('captured_via', 'life-chronicle:meeting', 'event', jsonb_build_object('depth', 'notes/n-' || (i + 4)))
          ELSE jsonb_build_object('tags', jsonb_build_array('t' || (i % 97)))
        END
      FROM generate_series(0, ${PAGES - 1}) i`);
    await run(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter)
      SELECT 'notes/n-' || i, 'other', 'note', 'Note ' || i, 'body of note ' || i, jsonb_build_object('tags', jsonb_build_array('t' || (i % 97)))
      FROM generate_series(0, ${OTHER_PAGES - 1}) i`);
    await run(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
      SELECT c.id, a.id, 'synthesized_from', 'concept-provenance' FROM pages c
      JOIN pages a ON a.source_id = c.source_id AND a.slug = 'notes/n-' || (substring(c.slug from 9)::int - CASE WHEN substring(c.slug from 9)::int % 128 = 11 THEN 2 ELSE 13 END)
      WHERE c.source_id = '${SOURCE}' AND c.type = 'concept'`);
    const [{ lo, hi }] = await run('SELECT min(id) AS lo, max(id) AS hi FROM pages');
    await run(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
      SELECT p.id, ${lo} + (p.id - ${lo} + k * 7919) % (${hi} - ${lo} + 1), 'mentions', 'markdown'
      FROM pages p CROSS JOIN generate_series(1, ${LINKS_PER_PAGE}) k`);
    await run('ANALYZE pages');
    await run('ANALYZE links');
    await seed.end();
  }
  const seedMs = performance.now() - seedStart;

  const statements: Array<{ ms: number; ok: boolean; error?: string; sql: string; params: unknown[]; opts: any }> = [];
  const executeRaw = engine.executeRaw.bind(engine);
  engine.executeRaw = async (sql: string, params?: unknown[], opts?: unknown) => {
    const start = performance.now();
    const dependents = /\bcandidates\b/.test(sql) && /\bcleared\b/.test(sql);
    try {
      const rows = await executeRaw(sql, params, opts);
      if (dependents) statements.push({ ms: performance.now() - start, ok: true, sql, params: params ?? [], opts });
      return rows;
    } catch (error) {
      if (dependents) statements.push({ ms: performance.now() - start, ok: false, error: (error as Error).message, sql, params: params ?? [], opts });
      throw error;
    }
  };
  log('preview of a ' + WINDOW + '-page window through ' + CHECKOUT + ' (' + COMMIT + ')');
  const previewStart = performance.now();
  let plan: any = null;
  let previewError: string | null = null;
  try {
    plan = await privateLabelsRepair.plan(engine, { brain_id: 'bench', source_ids: [SOURCE] }, null, { limit: WINDOW, ...(CLASS ? { driftClass: CLASS } : {}) });
  } catch (error) {
    previewError = (error as Error).message;
  }
  const previewMs = performance.now() - previewStart;
  engine.executeRaw = executeRaw;
  const statement = statements[0];
  let explain: string | null = null;
  if (statement) {
    const mode = statement.ok ? 'EXPLAIN (ANALYZE, BUFFERS) ' : 'EXPLAIN ';
    explain = (await executeRaw(mode + statement.sql, statement.params, { ...statement.opts, timeoutMs: 600_000 }) as Array<{ 'QUERY PLAN': string }>).map(row => row['QUERY PLAN']).join('\n');
  }
  const report = {
    label: LABEL, commit: COMMIT, checkout: CHECKOUT, db, pages: PAGES, other_pages: OTHER_PAGES, links_per_page: LINKS_PER_PAGE, lineage: LINEAGE, class: CLASS || null, window: WINDOW, seed_ms: Math.round(seedMs),
    preview_ms: Math.round(previewMs), preview_error: previewError, listed: plan?.items?.length ?? null,
    dependents: plan?.details?.dependents ?? null,
    statement: statement ? { ms: Math.round(statement.ms), ok: statement.ok, error: statement.error ?? null } : null,
    explain,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
  log('dependents statement: ' + (statement ? Math.round(statement.ms) + ' ms' + (statement.ok ? '' : ' (' + statement.error + ')') : 'not run'));
  console.log(JSON.stringify({ ...report, explain: undefined, out: OUT }, null, 2));
} finally {
  await engine.disconnect().catch(() => {});
  if (!KEEP && !REUSE) await admin.unsafe('DROP DATABASE IF EXISTS ' + db + ' WITH (FORCE)').catch(() => {});
  await admin.end();
}
