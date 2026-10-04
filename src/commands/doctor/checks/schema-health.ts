/**
 * Schema and extension health after a successful connection: pgvector and write-path shape checks, RLS, schema version + columns, the RLS event trigger and embedding coverage.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { embedBackfillFix } from '../../../core/embed-consent.ts';
import * as db from '../../../core/db.ts';
import { loadConfig } from '../../../core/config.ts';
import { LATEST_VERSION } from '../../../core/migrate.ts';
import { schemaVersionHealth } from '../../../core/schema-version-health.ts';
import { pgvectorCheck, pagesUpsertArbiterCheck, linkSourceCheckConstraintCheck } from './core-health.ts';
import { pgliteScaleCheck } from './engine-fit.ts';
import { checkParkedEffects } from './parked-effects.ts';
import { checkManagedGuardSchemaDrift, checkPublicationRefusals } from './managed-guard.ts';
import { checkWorktreeRefreshStuck } from './worktree-refresh.ts';
import { checkPersistenceCapacity } from './persistence-capacity.ts';
import { checkPostgresCancellationDriver } from './postgres-cancellation.ts';
import { checkProjectionReadiness } from './projection-readiness.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { embeddingsDisabled } from '../../../core/embedding-disabled.ts';
import { checkError, infoCheck, keylessEnablementFix } from '../check-fix.ts';

async function runPgvector(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 4. pgvector extension
  progress.heartbeat('pgvector');
  checks.push(await pgvectorCheck(engine));
  const postgresCancellation = await checkPostgresCancellationDriver(engine);
  if (postgresCancellation) checks.push(postgresCancellation);

  // 4a-bis. #550: pages(source_id, slug) upsert arbiter — when missing, every
  // page write fails brain-wide and the version counter can't see the drift.
  progress.heartbeat('pages_upsert_arbiter');
  checks.push(await pagesUpsertArbiterCheck(engine));
  checks.push(await checkProjectionReadiness(engine));

  // 4a-bis. Managed write capacity (#5470) and parked postcommit effects (#5612).
  progress.heartbeat('persistence_capacity');
  checks.push(await checkPersistenceCapacity(engine), await checkParkedEffects(engine), await checkWorktreeRefreshStuck(engine));
  // #5983/#5974: schema drift on guarded tables and writes the database refused.
  checks.push(await checkManagedGuardSchemaDrift(engine), await checkPublicationRefusals(engine));

  // 4a-ter. #4613: links_link_source_check shape — a ledger-current brain
  // whose CHECK reverted to the pre-v114 allowlist rejects every kebab
  // provenance write; the version counter can't see it.
  progress.heartbeat('links_link_source_check');
  checks.push(await linkSourceCheckConstraintCheck(engine));

  // 4b. pglite_scale — engine-fit signal: makes the init-time 1000-file
  // Supabase suggestion re-evaluable for the life of the brain.
  progress.heartbeat('pglite_scale');
  {
    const scale = await pgliteScaleCheck(engine);
    if (scale) checks.push(scale);
  }
  return checks;
}

export const pgvectorEntry: DoctorEntry = {
  name: 'pgvector',
  emits: [
    'pgvector',
    'postgres_cancellation_driver',
    'pages_upsert_arbiter',
    'text_projection_readiness',
    'persistence_capacity',
    'parked_effects',
    'worktree_refresh_stuck',
    'managed_guard_schema_drift',
    'publication_refusals',
    'links_link_source_check',
    'pglite_scale',
  ],
  run: runPgvector,
};

async function runRls(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // (pgbouncer_prepare moved ABOVE the connection check — URL-only, must
  // survive a dead DB.)

  // 5. RLS — check ALL public tables, not just gbrain's own.
  // Any table without RLS in the public schema is a security risk:
  // Supabase exposes the public schema via PostgREST, so tables without
  // RLS are readable/writable by anyone with the anon key.
  //
  // Escape hatch ("write it in blood"): if a user or plugin deliberately
  // wants a public-schema table readable by the anon key (analytics,
  // materialized views the anon key needs), they can exempt it with a
  // Postgres COMMENT whose value starts with:
  //
  //     GBRAIN:RLS_EXEMPT reason=<non-empty reason>
  //
  // The comment lives in pg_description, survives pg_dump, is visible in
  // schema diffs, and requires raw SQL in psql to set — there is no
  // `gbrain rls-exempt add` CLI on purpose. Doctor re-enumerates the
  // exemption list on every successful run so exempt tables never go
  // invisible. See docs/guides/rls-and-you.md.
  progress.heartbeat('rls');
  if (engine.kind === 'pglite') {
    // PGLite is embedded and single-user — no PostgREST exposure,
    // RLS is not a meaningful security boundary here.
    checks.push({
      name: 'rls',
      status: 'ok',
      message: 'Skipped (PGLite — no PostgREST exposure, RLS not applicable)',
    });
  } else {
    try {
      const sql = db.getConnection();
      // Left-join pg_description so we get the (optional) COMMENT ON TABLE
      // value alongside rowsecurity in a single round-trip. Filter to
      // base tables in the public schema.
      const tables = await sql`
        SELECT
          t.tablename,
          t.rowsecurity,
          COALESCE(
            obj_description(format('public.%I', t.tablename)::regclass, 'pg_class'),
            ''
          ) AS comment
        FROM pg_tables t
        WHERE t.schemaname = 'public'
      `;
      const EXEMPT_RE = /^GBRAIN:RLS_EXEMPT\s+reason=\S.{3,}/;
      const exempt: string[] = [];
      const gaps: string[] = [];
      for (const t of tables as Array<any>) {
        if (t.rowsecurity) continue;
        if (EXEMPT_RE.test(t.comment || '')) {
          exempt.push(t.tablename);
        } else {
          gaps.push(t.tablename);
        }
      }
      if (gaps.length === 0) {
        const suffix = exempt.length > 0
          ? ` (${exempt.length} explicitly exempt: ${exempt.join(', ')})`
          : '';
        checks.push({
          name: 'rls',
          status: 'ok',
          message: `RLS enabled on ${tables.length - exempt.length}/${tables.length} public tables${suffix}`,
        });
      } else {
        const names = gaps.join(', ');
        // Double-escape " inside identifiers so a pathological table name
        // like `weird"table` renders as `"weird""table"` in the remediation
        // SQL (matches how Postgres parses quoted identifiers). Doubling
        // any existing " is the minimum needed to keep the output valid
        // copy-paste SQL. Extremely rare in practice but cheap to get right.
        const fixes = gaps
          .map(n => `ALTER TABLE "public"."${n.replace(/"/g, '""')}" ENABLE ROW LEVEL SECURITY;`)
          .join(' ');
        const exemptInfo = exempt.length > 0
          ? ` (${exempt.length} other table(s) explicitly exempt.)`
          : '';
        checks.push({
          name: 'rls',
          status: 'fail',
          message:
            `${gaps.length} table(s) WITHOUT Row Level Security: ${names}.${exemptInfo} ` +
            `Fix: ${fixes} ` +
            `If a table should stay readable by the anon key on purpose, see docs/guides/rls-and-you.md for the GBRAIN:RLS_EXEMPT comment escape hatch.`,
        });
      }
    } catch {
      checks.push(checkError('rls', 'check RLS status'));
    }
  }
  return checks;
}

export const rlsEntry: DoctorEntry = { name: 'rls', emits: ['rls'], run: runRls };

async function runSchemaVersion(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 6. Schema version — also surfaces the #218 "postinstall silently failed"
  // state: if schema_version is 0/missing but the DB connected, migrations
  // never ran. That's the same class as a half-migrated install, just from a
  // different root cause (Bun blocked our top-level postinstall on global
  // install). Message is actionable either way.
  progress.heartbeat('schema_version');
  let schemaVersion = 0;
  try {
    const version = await engine.getConfig('version');
    schemaVersion = parseInt(version || '0', 10);
    checks.push({ name: 'schema_version', ...schemaVersionHealth(schemaVersion, LATEST_VERSION) });

    // 6b. Schema columns — gbrain#4421/#4425. The ledger counter alone can
    // lie: a PgBouncer transaction-mode pooler can swallow an ALTER TABLE
    // while the migration runner still advances config.version, leaving the
    // ledger "current" over a physically narrower table. The read-only column
    // diff below does the same live-column check `gbrain init --migrate-only`
    // already self-heals with — but a plain diagnostic run never issues DDL.
    if (schemaVersion > LATEST_VERSION) {
      // Forward skew (schemaVersionHealth warns AHEAD above): an ahead DB is
      // a superset of this client's expected columns — the diff below would
      // only mislead. "Upgrade this client" is the real fix; skip the diff.
    } else if (schemaVersion >= LATEST_VERSION) {
      // Ledger-current branch. Dynamic import is deliberate: the positional
      // source guard in test/doctor-schema-column-diff.test.ts pins that the
      // diff consult lives INSIDE this branch (a behind DB is EXPECTED to
      // miss columns from unapplied migrations — schema_version's own warn
      // covers that already, so the diff would only mislead there too).
      progress.heartbeat('schema_columns');
      try {
        const { detectMissingColumns } = await import('../../../core/schema-verify.ts');
        const detected = await detectMissingColumns(engine);
        if (detected.missing.length === 0) {
          checks.push({ name: 'schema_columns', status: 'ok', message: `${detected.checked} column(s) verified against live schema` });
        } else {
          const cols = detected.missing.map(m => `${m.table}.${m.column}`).join(', ');
          checks.push({
            name: 'schema_columns',
            status: 'warn',
            message:
              `${detected.missing.length} column(s) missing despite schema_version reporting up to date: ${cols}. ` +
              `The migration ledger advanced past a swallowed ALTER TABLE (PgBouncer transaction-mode is the ` +
              `usual cause). Fix: gbrain init --migrate-only (runs the schema self-heal); if it persists, ` +
              `connect directly to Postgres (not the pooler) first.`,
          });
        }
      } catch {
        checks.push(checkError('schema_columns', 'verify live schema columns'));
      }
    }
  } catch {
    checks.push(checkError('schema_version', 'check schema version'));
  }
  ctx.schemaVersion = schemaVersion;
  return checks;
}

export const schemaVersionEntry: DoctorEntry = {
  name: 'schema_version',
  emits: ['schema_version', 'schema_columns'],
  run: runSchemaVersion,
};

async function runRlsEventTrigger(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // Note: we intentionally DO NOT fail on "schema v7+ but no preferences.json".
  // That's a valid fresh-install state after `gbrain init` — the migration
  // orchestrator writes preferences, but `init` alone doesn't run it. The
  // partial-completed.jsonl check in the filesystem section (step 3) is
  // the canonical half-migration signal and fires when the stopgap ran
  // but `apply-migrations` didn't follow up.

  // 7. RLS event trigger (post-install drift detector for v35 auto-RLS).
  // Catches the case where an operator manually drops the trigger to debug
  // something and forgets to recreate it. Does NOT catch install-time silent
  // failure — runMigrations rethrows on SQL failure and only bumps
  // config.version after success, so a failed v35 install means version
  // stays at 34 and check #6 (schema_version) fires loudly.
  //
  // Healthy evtenabled values: 'O' (origin) and 'A' (always). 'R' is
  // replica-only and would NOT fire in normal origin sessions; 'D' is
  // disabled. Both of those are warn states.
  progress.heartbeat('rls_event_trigger');
  if (engine.kind === 'pglite') {
    checks.push({
      name: 'rls_event_trigger',
      status: 'ok',
      message: 'Skipped (PGLite — no event trigger support)',
    });
  } else {
    try {
      const sql = db.getConnection();
      const rows = await sql`
        SELECT evtname, evtenabled FROM pg_event_trigger
        WHERE evtname = 'auto_rls_on_create_table'
      `;
      if (rows.length === 0) {
        checks.push({
          name: 'rls_event_trigger',
          status: 'warn',
          message:
            'Auto-RLS event trigger missing. New tables created outside gbrain may not get RLS. ' +
            'Fix: recreate it with the SQL in docs/guides/rls-and-you.md ("What if the trigger gets dropped?").',
        });
      } else if (rows[0].evtenabled !== 'O' && rows[0].evtenabled !== 'A') {
        checks.push({
          name: 'rls_event_trigger',
          status: 'warn',
          message:
            `Auto-RLS event trigger present but evtenabled=${rows[0].evtenabled} ` +
            `(not origin/always). Trigger will not fire in normal sessions. ` +
            `Fix: ALTER EVENT TRIGGER auto_rls_on_create_table ENABLE;`,
        });
      } else {
        checks.push({
          name: 'rls_event_trigger',
          status: 'ok',
          message: 'Auto-RLS event trigger installed',
        });
      }
    } catch {
      checks.push(checkError('rls_event_trigger', 'check RLS event trigger'));
    }
  }
  return checks;
}

export const rlsEventTriggerEntry: DoctorEntry = {
  name: 'rls_event_trigger',
  emits: ['rls_event_trigger'],
  run: runRlsEventTrigger,
};

async function runEmbeddings(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 8. Embedding health
  progress.heartbeat('embeddings');
  try {
    // A keyless brain has no embedding backlog to drain: recommending a paid
    // catch-up there would send the agent into a refusal.
    if (await embeddingsDisabled(engine)) {
      checks.push(infoCheck('embeddings', 'Not applicable: embeddings are disabled on this brain (keyword search keeps working).', 'disabled_by_choice', keylessEnablementFix()));
      return checks;
    }
    const health = await engine.getHealth();
    const pct = (health.embed_coverage * 100).toFixed(0);
    // Coverage + missing now share one source (the stored vector over
    // eligible chunks), so the two numbers can no longer contradict each
    // other. When the READ path rides a custom active column, say so — this
    // check reports the default write-side column; the active-column truth
    // lives in embedding_column_registry.
    let carveOut = '';
    try {
      const activeCol = await engine.getConfig('search_embedding_column');
      if (activeCol && activeCol !== 'embedding') {
        carveOut = ` (read path uses '${activeCol}'; see embedding_column_registry)`;
      }
    } catch {
      // Config read is best-effort; the coverage numbers stand alone.
    }
    // The backlog's fix is the catch-up drain: a plain `embed --stale` stops
    // at its 30-minute budget, which on a large brain leaves most of the
    // backlog behind (52k documents: 51,910 chunks after one run).
    const backlog = health.missing_embeddings;
    const fix = 'gbrain embed --stale --catch-up';
    const backlogDetails = { code: 'embedding_backlog', backlog, fix, requires_user_approval: 'paid embedding calls',
      docs: 'docs/operations/backfill-pacing.md#large-brain-deadlines' };
    const fixText = `Fix: ${fix} (runs until the backlog is empty; a plain gbrain embed --stale stops after its 30-minute budget). ` +
      'It makes paid embedding calls: confirm with the user unless embedding spend is already approved.';
    if (health.embed_coverage >= 0.9) {
      checks.push(backlog > 0
        ? { name: 'embeddings', status: 'ok', message: `${pct}% coverage, ${backlog} missing${carveOut}. Backlog: ${backlog} chunk(s) without embeddings. ${fixText}`, details: backlogDetails, fix: embedBackfillFix({ backlog, verifyCheck: 'embeddings' }) }
        : { name: 'embeddings', status: 'ok', message: `${pct}% coverage, ${backlog} missing${carveOut}` });
    } else if (health.embed_coverage > 0) {
      checks.push({ name: 'embeddings', status: 'warn', message: `${pct}% coverage, ${backlog} missing${carveOut}. Backlog: ${backlog} chunk(s) without embeddings. ${fixText}`, details: backlogDetails, fix: embedBackfillFix({ backlog, verifyCheck: 'embeddings' }) });
    } else {
      checks.push({ name: 'embeddings', status: 'warn', message: `No embeddings yet${carveOut}. Backlog: ${backlog} chunk(s) without embeddings. ${fixText}`, details: backlogDetails, fix: embedBackfillFix({ backlog, verifyCheck: 'embeddings' }) });
    }
  } catch {
    checks.push(checkError('embeddings', 'check embedding health'));
  }
  return checks;
}

export const embeddingsEntry: DoctorEntry = { name: 'embeddings', emits: ['embeddings'], run: runEmbeddings };
