/**
 * The copies a shadow replay runs on (docs/guides/shadow-replay.md). One `runSeed` snapshot read of the primary is
 * fanned out: the Rust store gets each batch through `importRelation`, and every SQL copy (a fresh PGLite brain, and
 * a local Postgres scratch database when one is configured) gets the same rows, so every arm holds the same
 * relations and leaves the same tables behind.
 *
 * The SQL copy inserts each batch with user triggers and foreign-key checks off (`session_replication_role =
 * replica`, transaction-local, so it ends with every transaction), splits the `page_projection_jobs` columns the
 * seed carries inside page rows back into their own table, then rebuilds the tsvector columns through only the
 * triggers that write them, and sets sequences with the graduation rule (`copySequences`: the primary's exact
 * position, raised to the copied column maximum).
 */
import type { BrainEngine } from '../core/engine.ts';
import { quoteIdent, tableColumns } from '../core/persistence/graduation-digest.ts';
import { copySequences } from '../core/persistence/graduation-copy.ts';
import type { SeedImportResult, SeedPlan, SeedRow } from '../core/rust-engine/store.ts';
import type { SeedTarget } from './seed.ts';
import { ReplayError } from './replay-errors.ts';

const PROJECTION_PREFIX = 'projection_job_';

export interface ArmImport { rows: number; imported: number; skipped: number; dropped: number; unmapped_columns: string[]; losses: Record<string, number> }

/** A SeedTarget that writes the seed's rows into an initialized, empty SQL brain. */
export class SqlSeedTarget implements SeedTarget {
  private cleared = new Set<string>();
  private types = new Map<string, Map<string, string>>();
  readonly totals: Record<string, number> = {};

  constructor(readonly engine: BrainEngine, private readonly plan: SeedPlan) {}

  async seedPlan(): Promise<SeedPlan> { return this.plan; }

  private async columnTypes(relation: string): Promise<Map<string, string>> {
    let t = this.types.get(relation);
    if (!t) {
      t = new Map((await tableColumns(this.engine, relation)).filter(c => !c.generated).map(c => [c.name, c.type]));
      this.types.set(relation, t);
    }
    return t;
  }

  async importRelation(_seedId: string, relation: string, rows: SeedRow[]): Promise<SeedImportResult> {
    const types = await this.columnTypes(relation);
    const columns = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(c => types.has(c) && !c.startsWith(PROJECTION_PREFIX));
    const unmapped = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(c => !types.has(c) && !c.startsWith(PROJECTION_PREFIX));
    const table = quoteIdent(relation);
    await this.engine.transaction(async tx => {
      await tx.executeRaw('SET LOCAL session_replication_role = replica');
      if (!this.cleared.has(relation)) { await tx.executeRaw(`DELETE FROM ${table}`); this.cleared.add(relation); }
      if (rows.length && columns.length) {
        const list = columns.map(quoteIdent).join(', ');
        const select = columns.map(c => `(r.v->>${sqlString(c)})::${types.get(c)}`).join(', ');
        await tx.executeRaw(`INSERT INTO ${table} (${list}) SELECT ${select} FROM jsonb_array_elements($1::text::jsonb) AS r(v)`, [JSON.stringify(rows)]);
      }
      if (relation === 'pages') {
        const jobs = rows.filter(r => r.projection_job_revision != null).map(r => ({
          source_id: r.source_id, slug: r.slug, revision: r.projection_job_revision, reason: r.projection_job_reason, updated_at: r.projection_job_updated_at,
        }));
        if (jobs.length) {
          await tx.executeRaw(`INSERT INTO page_projection_jobs (source_incarnation, slug, revision, reason, updated_at)
            SELECT s.incarnation, r.v->>'slug', (r.v->>'revision')::uuid, r.v->>'reason', (r.v->>'updated_at')::timestamptz
            FROM jsonb_array_elements($1::text::jsonb) AS r(v) JOIN sources s ON s.id = r.v->>'source_id'
            ON CONFLICT (source_incarnation, slug) DO NOTHING`, [JSON.stringify(jobs)]);
        }
      }
    });
    this.totals[relation] = (this.totals[relation] ?? 0) + rows.length;
    return { imported: rows.length, skipped: 0, dropped: 0, unmapped_columns: unmapped, losses: {} };
  }

  /** Rebuilds tsvector columns through the triggers that write them, then sets sequences from the primary. */
  async finish(primary: BrainEngine): Promise<void> {
    const tsv = await this.engine.executeRaw<{ rel: string; col: string }>(`SELECT c.relname AS rel, a.attname AS col FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = current_schema() AND c.relkind = 'r' AND t.typname = 'tsvector' AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated::text = ''`);
    for (const { rel, col } of tsv) {
      if (!this.cleared.has(rel)) continue;
      const triggers = await this.engine.executeRaw<{ name: string; enabled: string; cols: string[] | null; writes: boolean }>(`SELECT tg.tgname AS name, tg.tgenabled::text AS enabled,
          (SELECT array_agg(a.attname::text) FROM pg_attribute a WHERE a.attrelid = tg.tgrelid AND a.attnum = ANY(tg.tgattr::int2[])) AS cols,
          (p.prosrc ILIKE '%' || $2 || '%') AS writes
        FROM pg_trigger tg JOIN pg_proc p ON p.oid = tg.tgfoid WHERE tg.tgrelid = to_regclass(format('%I', $1::text)) AND NOT tg.tgisinternal`, [rel, col]);
      const fts = triggers.filter(t => t.writes && t.enabled !== 'D');
      if (!fts.length) continue;
      const table = quoteIdent(rel);
      const setCols = [...new Set(fts.flatMap(t => t.cols ?? []))];
      const set = (setCols.length ? setCols : [col]).map(c => `${quoteIdent(c)} = ${quoteIdent(c)}`).join(', ');
      await this.engine.transaction(async tx => {
        for (const t of triggers.filter(x => x.enabled !== 'D' && !fts.includes(x))) await tx.executeRaw(`ALTER TABLE ${table} DISABLE TRIGGER ${quoteIdent(t.name)}`);
        await tx.executeRaw(`UPDATE ${table} SET ${set}`);
        for (const t of triggers.filter(x => x.enabled !== 'D' && !fts.includes(x))) await tx.executeRaw(`ALTER TABLE ${table} ENABLE TRIGGER ${quoteIdent(t.name)}`);
      });
    }
    await copySequences({ source: primary, target: this.engine });
  }
}

function sqlString(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

/** Feeds one seed to the Rust store and every SQL copy; the seed record keeps the Rust store's own counts. */
export class FanOutSeedTarget implements SeedTarget {
  readonly arms: Record<string, ArmImport> = {};
  /** Wall-clock bounds of the snapshot: before the plan read, and when the first batch (already inside it) returned. */
  cut: { before: number; after: number | null } = { before: 0, after: null };

  constructor(private readonly rust: SeedTarget, private readonly sql: Record<string, SqlSeedTarget>) {}

  async seedPlan(): Promise<SeedPlan> {
    this.cut.before = Date.now();
    return this.rust.seedPlan();
  }

  async importRelation(seedId: string, relation: string, rows: SeedRow[]): Promise<SeedImportResult> {
    const result = await this.rust.importRelation(seedId, relation, rows);
    this.add('rust', rows.length, result);
    for (const [name, target] of Object.entries(this.sql)) this.add(name, rows.length, await target.importRelation(seedId, relation, rows));
    this.cut.after ??= Date.now();
    return result;
  }

  private add(arm: string, n: number, r: SeedImportResult): void {
    const a = this.arms[arm] ??= { rows: 0, imported: 0, skipped: 0, dropped: 0, unmapped_columns: [], losses: {} };
    a.rows += n; a.imported += r.imported; a.skipped += r.skipped; a.dropped += r.dropped;
    a.unmapped_columns = [...new Set([...a.unmapped_columns, ...r.unmapped_columns])].sort();
    for (const [k, v] of Object.entries(r.losses)) a.losses[k] = (a.losses[k] ?? 0) + v;
  }
}

export const REPLAY_POSTGRES_ENV = 'GBRAIN_SHADOW_REPLAY_POSTGRES_URL';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Refuses a scratch Postgres URL that could send rows off this machine: a host other than localhost or a Unix
 * socket, several hosts, or a host override in the query string. Also refuses the primary's own database.
 */
export function checkLocalPostgresUrl(raw: string, primaryUrl?: string | null): { host: string; port: string; database: string } {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ReplayError('shadow_replay_postgres_not_local', 'the scratch Postgres URL does not parse'); }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new ReplayError('shadow_replay_postgres_not_local', 'the scratch URL is not a postgres URL');
  const qHost = url.searchParams.get('host') ?? url.searchParams.get('hostaddr');
  for (const name of ['host', 'hostaddr']) for (const v of url.searchParams.getAll(name)) {
    if (!v.startsWith('/') || v.includes(',')) throw new ReplayError('shadow_replay_postgres_not_local', `the scratch URL's ${name} option is not a Unix socket path`);
  }
  if (url.hostname.includes(',') || (url.hostname && !LOCAL_HOSTS.has(url.hostname))) {
    throw new ReplayError('shadow_replay_postgres_not_local', 'the scratch Postgres host is not localhost or a Unix socket');
  }
  if (!url.hostname && !qHost) throw new ReplayError('shadow_replay_postgres_not_local', 'the scratch URL names no host');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new ReplayError('shadow_replay_postgres_not_local', 'the scratch URL names no database');
  if (primaryUrl) {
    try {
      const p = new URL(primaryUrl);
      if (LOCAL_HOSTS.has(p.hostname) && (p.port || '5432') === (url.port || '5432') && decodeURIComponent(p.pathname.replace(/^\//, '')) === database) {
        throw new ReplayError('shadow_replay_postgres_not_owned', 'the scratch database is the primary brain');
      }
    } catch (e) { if (e instanceof ReplayError) throw e; }
  }
  return { host: url.hostname || qHost!, port: url.port || '5432', database };
}

/**
 * Makes the scratch database an empty replay copy owned by `brainKey`: refuses a database that holds tables but no
 * replay marker for this brain, then drops and recreates the public schema.
 */
export async function resetScratchPostgres(engine: BrainEngine, brainKey: string): Promise<void> {
  const [marker] = await engine.executeRaw<{ present: boolean }>("SELECT to_regclass('public.gbrain_shadow_replay_owner') IS NOT NULL AS present");
  if (marker?.present) {
    const [own] = await engine.executeRaw<{ brain: string }>('SELECT brain FROM gbrain_shadow_replay_owner LIMIT 1');
    if (own?.brain !== brainKey) throw new ReplayError('shadow_replay_postgres_not_owned', 'the scratch database belongs to another brain\'s replay');
  } else {
    const [count] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
    if ((count?.n ?? 0) > 0) throw new ReplayError('shadow_replay_postgres_not_owned', 'the scratch database is not empty and was not created by a replay');
  }
  try {
    await engine.executeRaw('DROP SCHEMA IF EXISTS public CASCADE');
    await engine.executeRaw('CREATE SCHEMA public');
  } catch (e) {
    throw new ReplayError('shadow_replay_postgres_privilege', `the scratch role cannot reset its database (${(e as { code?: string }).code ?? 'error'})`);
  }
}

export async function markScratchPostgres(engine: BrainEngine, brainKey: string): Promise<void> {
  await engine.executeRaw('CREATE TABLE IF NOT EXISTS gbrain_shadow_replay_owner (brain TEXT PRIMARY KEY)');
  await engine.executeRaw('INSERT INTO gbrain_shadow_replay_owner (brain) VALUES ($1) ON CONFLICT DO NOTHING', [brainKey]);
}
