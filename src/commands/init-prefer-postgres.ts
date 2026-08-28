/**
 * `gbrain init --prefer-postgres` — the Postgres-first install ladder for
 * agent-harness installs (db-availability loop, 5a). The zero-config
 * `gbrain init` default stays PGLite; THIS flag is how the Codex/Claude Code
 * plugin lane prefers Postgres "if at all possible".
 *
 * Ladder (first usable rung wins; every reachable-but-unusable rung prints a
 * one-line note and falls through — only the final PGLite rung is terminal):
 *   1. env URL          (GBRAIN_DATABASE_URL / #427-guarded DATABASE_URL)
 *   2. Supabase token   (SUPABASE_ACCESS_TOKEN [+ SUPABASE_PROJECT_REF]
 *                        + SUPABASE_DB_PASSWORD — Management API DISCOVERY
 *                        only; the candidate URL is connect-probed before
 *                        anything persists)
 *   3. local Postgres   (opportunistic: only when PG* env vars are set or
 *                        --local-postgres — a blind localhost probe on
 *                        peer-auth dev installs just burns a timeout.
 *                        Detection-only: CREATE DATABASE needs
 *                        --allow-create-db)
 *   4. docker           (--allow-docker only; gbrain's own pgvector
 *                        container — idempotent reuse recovers the REAL
 *                        credentials via docker inspect)
 *   5. PGLite           (zero-config floor, with the upgrade-later note)
 *
 * Consent bars: headless mutation of a server gbrain doesn't own is never
 * implicit (rung 3's CREATE DATABASE and rung 4's container are both behind
 * explicit flags). Token hygiene: SUPABASE_ACCESS_TOKEN is never persisted,
 * logged, or echoed.
 */

import { randomBytes } from 'node:crypto';

import { effectiveEnvDatabaseUrl, isThinClient, loadConfigFileOnly } from '../core/config.ts';
import { InitPostgresFailure, initPGLite, initPostgresCore } from './init.ts';
import { defaultDeps as dbRepairDeps } from './db-repair.ts';
import { discoverPoolerUrl, listProjects } from '../core/supabase-admin.ts';
import {
  GBRAIN_PG_HOST_PORT,
  containerState,
  dockerAvailable,
  inspectCredentials,
  runNewContainer,
  startContainer,
} from '../core/docker-postgres.ts';
import { redactPgUrl, redactUrlsInText } from '../core/url-redact.ts';
import { classifyPgAccessError } from '../core/pg-access-classify.ts';

export interface PreferPostgresOpts {
  jsonOutput: boolean;
  apiKey: string | null;
  customPath: string | null;
  aiOpts: Parameters<typeof initPostgresCore>[0]['aiOpts'];
  schemaPack: string;
  skipEmbedCheck: boolean;
  allowDocker: boolean;
  allowCreateDb: boolean;
  localPostgres: boolean;
}

type LadderRung = 'env_url' | 'supabase_token' | 'local_postgres' | 'docker' | 'pglite';

function note(line: string): void {
  console.error(`[prefer-postgres] ${line}`);
}

/** Rung-note copy for a caught error: message redacted (a driver error can
 *  embed the full DSN, credentials included) and truncated. */
function noteErr(e: unknown): string {
  return redactUrlsInText(e instanceof Error ? e.message : String(e)).slice(0, 200);
}

/**
 * In --json mode the ladder's final envelope must be the ONLY stdout content
 * — but the inner init cores (called with jsonOutput:false) print their
 * human progress to stdout. Reroute stdout to stderr for the duration so
 * `gbrain init --prefer-postgres --json | jq` always parses.
 *
 * BOTH seams are patched: Bun's console.log writes to fd 1 directly and
 * bypasses a process.stdout.write override (verified by repro), so
 * console.log is rerouted to console.error and the write patch catches the
 * remaining bare process.stdout.write callers.
 */
async function withStdoutToStderr<T>(active: boolean, fn: () => Promise<T>): Promise<T> {
  if (!active) return fn();
  const realWrite = process.stdout.write.bind(process.stdout);
  const realLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  (process.stdout as { write: typeof process.stdout.write }).write = ((
    chunk: Parameters<typeof process.stdout.write>[0],
    ...rest: unknown[]
  ) => (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    (process.stdout as { write: typeof process.stdout.write }).write = realWrite;
    console.log = realLog;
  }
}

/** Single bounded connect probe (shared with db-repair — one prober, one contract). */
async function probeUrl(url: string): Promise<string | null> {
  const diag = await dbRepairDeps.probeAccess({ engine: 'postgres', database_url: url });
  return diag === null ? null : `${diag.reason}: ${diag.remediation}`;
}

/**
 * What already lives in a reachable candidate database?
 *   'gbrain'  — an existing gbrain brain (pages table present): safe to adopt.
 *   'empty'   — no user tables in public: safe to initialize.
 *   'foreign' — someone else's tables: NEVER mutate implicitly.
 *   'unknown' — the check itself failed: treat as foreign (fail-closed).
 */
async function classifyDbContent(url: string): Promise<'gbrain' | 'empty' | 'foreign' | 'unknown'> {
  try {
    return await dbRepairDeps.withEngine({ engine: 'postgres', database_url: url }, async (engine) => {
      const pages = await engine.executeRaw<{ n: string | number }>(
        "SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'pages'",
      );
      if (Number(pages[0]?.n) > 0) return 'gbrain' as const;
      const tables = await engine.executeRaw<{ n: string | number }>(
        "SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname = 'public'",
      );
      return Number(tables[0]?.n) === 0 ? ('empty' as const) : ('foreign' as const);
    });
  } catch {
    return 'unknown';
  }
}

async function initPostgresRung(
  o: PreferPostgresOpts,
  databaseUrl: string,
  rung: LadderRung,
): Promise<LadderRung | null> {
  try {
    await withStdoutToStderr(o.jsonOutput, () => initPostgresCore({
      databaseUrl,
      // Inner JSON stays off in --json mode: the ladder emits ONE final
      // envelope (two JSON objects on stdout would break every parser),
      // and withStdoutToStderr keeps the core's human lines off stdout too.
      jsonOutput: false,
      apiKey: o.apiKey ?? undefined,
      aiOpts: o.aiOpts,
      schemaPack: o.schemaPack,
      skipEmbedCheck: o.skipEmbedCheck,
    } as Parameters<typeof initPostgresCore>[0]));
    return rung;
  } catch (e) {
    if (e instanceof InitPostgresFailure) {
      note(`${rung}: init failed (${e.reason}) — falling through`);
      return null;
    }
    const d = classifyPgAccessError(e, { url: databaseUrl });
    note(`${rung}: ${d.reason} — ${d.remediation} Falling through.`);
    return null;
  }
}

export async function runPreferPostgresLadder(o: PreferPostgresOpts): Promise<void> {
  // A brain is already configured → REFUSE. The ladder's rung choice is
  // environment-dependent (env URL today, docker tomorrow), so a re-run
  // would repoint the brain non-deterministically — worst case, a configured
  // Postgres brain whose server is temporarily down falls through every rung
  // and the PGLite floor overwrites config.json, orphaning the whole brain
  // because of an OUTAGE. Outages are db-repair's lane, not init's.
  const existing = loadConfigFileOnly();
  if (existing && (existing.engine || existing.database_url || existing.database_path || isThinClient(existing))) {
    console.error(
      '[prefer-postgres] a brain is already configured — refusing to re-run the ladder over it.\n' +
      '  Inspect:            gbrain engine status --probe\n' +
      '  Access broken?      gbrain db-repair\n' +
      '  Move PGLite → PG:   gbrain migrate --to supabase --url <conn>  (the postgres-adopt skill walks it)\n' +
      '  Really start over:  gbrain init --url <conn>  (explicit target, no ladder)',
    );
    process.exit(1);
  }

  // Rung-entry criterion — the preference is informed, not silent.
  note('Postgres wins on concurrency, multi-machine access, and 1000+ pages; PGLite keeps the per-turn bootstrap hook lane. Trying Postgres first.');

  let rung: LadderRung | null = null;
  let urlSource: string | null = null;

  // Rung 1 — env URL. GBRAIN_DATABASE_URL is gbrain-specific and adopted as
  // stated intent. A bare DATABASE_URL is NOT (deploy platforms export it
  // pointing at the APP's database) — initSchema would mutate a server
  // gbrain doesn't own, so it is adopted only when the target is already a
  // gbrain brain or holds no tables at all (fail-closed on 'foreign').
  const envUrl = effectiveEnvDatabaseUrl();
  if (envUrl) {
    const bare = !process.env.GBRAIN_DATABASE_URL;
    let adoptable = true;
    if (bare) {
      const content = await classifyDbContent(envUrl);
      if (content === 'foreign' || content === 'unknown') {
        adoptable = false;
        note(
          `rung 1 (env URL): DATABASE_URL points at a database with existing non-gbrain tables (${content}) — ` +
          'refusing to adopt it implicitly. Export GBRAIN_DATABASE_URL to use it deliberately. Next.',
        );
      }
    }
    if (adoptable) {
      note(`rung 1 (env URL): trying ${redactPgUrl(envUrl)}`);
      rung = await initPostgresRung(o, envUrl, 'env_url');
      if (rung) urlSource = 'env';
    }
  } else {
    note('rung 1 (env URL): no GBRAIN_DATABASE_URL/DATABASE_URL — next');
  }

  // Rung 2 — Supabase Management API discovery.
  if (!rung && process.env.SUPABASE_ACCESS_TOKEN) {
    const token = process.env.SUPABASE_ACCESS_TOKEN;
    try {
      let ref = process.env.SUPABASE_PROJECT_REF ?? null;
      if (!ref) {
        const projects = await listProjects(token);
        if (projects.length === 1) {
          ref = projects[0].id;
        } else if (projects.length === 0) {
          note('rung 2 (supabase): the account has no projects — create one in the dashboard, then re-run. Next.');
        } else {
          note(`rung 2 (supabase): ${projects.length} projects on the account — set SUPABASE_PROJECT_REF to pick one (guessing a brain's home is never OK). Next.`);
        }
      }
      if (ref) {
        const password = process.env.SUPABASE_DB_PASSWORD;
        if (!password) {
          note('rung 2 (supabase): the Management API cannot return the DB password — set SUPABASE_DB_PASSWORD (dashboard > Project Settings > Database). Next.');
        } else {
          let candidate = await discoverPoolerUrl(token, ref);
          candidate = candidate.replace('[YOUR-PASSWORD]', encodeURIComponent(password));
          const probeFail = await probeUrl(candidate);
          if (probeFail) {
            note(`rung 2 (supabase): discovered URL failed its probe (${probeFail}) — not persisting an unverified URL. Next.`);
          } else {
            note(`rung 2 (supabase): discovered + probed ${redactPgUrl(candidate)}`);
            rung = await initPostgresRung(o, candidate, 'supabase_token');
            if (rung) urlSource = 'supabase_discovery';
          }
        }
      }
    } catch (e) {
      note(`rung 2 (supabase): ${noteErr(e)} — next`);
    }
  } else if (!rung) {
    note('rung 2 (supabase): no SUPABASE_ACCESS_TOKEN — next');
  }

  // Rung 3 — local Postgres (opportunistic + detection-only by default).
  const pgEnvPresent = Boolean(process.env.PGHOST || process.env.PGPORT || process.env.PGUSER || process.env.PGPASSWORD);
  if (!rung && (pgEnvPresent || o.localPostgres)) {
    const host = process.env.PGHOST || 'localhost';
    const port = process.env.PGPORT || '5432';
    const user = process.env.PGUSER || 'postgres';
    const pass = process.env.PGPASSWORD ? `:${encodeURIComponent(process.env.PGPASSWORD)}` : '';
    const base = `postgresql://${user}${pass}@${host}:${port}`; /* allow-pg-url-literal */ // constructed target, only ever printed via redactPgUrl
    try {
      const maint = `${base}/postgres`;
      const probeFail = await probeUrl(maint);
      if (probeFail) {
        note(`rung 3 (local postgres): ${host}:${port} not usable (${probeFail}) — next`);
      } else {
        const checks = await dbRepairDeps.withEngine({ engine: 'postgres', database_url: maint }, async (engine) => {
          const vector = await engine.executeRaw<{ one: number }>(
            "SELECT 1 AS one FROM pg_available_extensions WHERE name = 'vector'",
          );
          const db = await engine.executeRaw<{ one: number }>(
            "SELECT 1 AS one FROM pg_database WHERE datname = 'gbrain'",
          );
          return { hasVector: vector.length > 0, hasDb: db.length > 0 };
        });
        if (!checks.hasVector) {
          note('rung 3 (local postgres): reachable but pgvector is not installed — install it (or use another rung). Next.');
        } else if (!checks.hasDb && !o.allowCreateDb) {
          note('rung 3 (local postgres): reachable with pgvector, but no `gbrain` database. CREATE DATABASE on a server not owned by this brain needs explicit consent: re-run with --allow-create-db. Next.');
        } else {
          if (!checks.hasDb) {
            await dbRepairDeps.withEngine({ engine: 'postgres', database_url: maint }, async (engine) => {
              await engine.executeRaw('CREATE DATABASE gbrain');
            });
            note('rung 3 (local postgres): created database `gbrain` (--allow-create-db)');
          }
          rung = await initPostgresRung(o, `${base}/gbrain`, 'local_postgres');
          if (rung) urlSource = 'local_probe';
        }
      }
    } catch (e) {
      note(`rung 3 (local postgres): ${noteErr(e)} — next`);
    }
  } else if (!rung) {
    note('rung 3 (local postgres): no PG* env vars and no --local-postgres — skipped (a blind localhost probe just burns a timeout)');
  }

  // Rung 4 — gbrain's own docker container (explicit opt-in only).
  if (!rung && o.allowDocker) {
    if (!dockerAvailable()) {
      note('rung 4 (docker): docker is not available — next');
    } else {
      try {
        const state = containerState();
        let url: string | null = null;
        if (state === 'absent') {
          const password = randomBytes(16).toString('hex');
          const run = runNewContainer(password);
          if (!run.ok) {
            note(`rung 4 (docker): container create failed (${run.stderr.slice(0, 120)}) — next`);
          } else {
            url = `postgresql://postgres:${password}@localhost:${GBRAIN_PG_HOST_PORT}/postgres`; /* allow-pg-url-literal */ // constructed target, only ever printed via redactPgUrl
          }
        } else {
          // Idempotent reuse: a freshly generated password can never match a
          // surviving container, and `docker start` reuses the ORIGINAL port
          // mapping — recover both from docker inspect.
          const creds = inspectCredentials();
          if (!creds) {
            note('rung 4 (docker): the gbrain-postgres container exists but its credentials are unrecoverable via docker inspect — gbrain never destroys a container it cannot prove it owns. Remove it yourself (docker rm -f gbrain-postgres) and re-run, or use another rung. Next.');
          } else {
            if (state === 'stopped' && !startContainer()) {
              note('rung 4 (docker): docker start failed — next');
            } else {
              // encodeURIComponent: gbrain-generated passwords are hex, but a
              // user-created container's password can carry URL metacharacters.
              url = `postgresql://postgres:${encodeURIComponent(creds.password)}@localhost:${creds.hostPort}/postgres`; /* allow-pg-url-literal */ // constructed target, only ever printed via redactPgUrl
            }
          }
        }
        if (url) {
          // Readiness poll: postgres in a fresh container takes a few seconds.
          let ready = false;
          let authMismatch = false;
          for (let i = 0; i < 20; i++) {
            const diag = await dbRepairDeps.probeAccess({ engine: 'postgres', database_url: url });
            if (diag === null) { ready = true; break; }
            // A FRESH container rejecting the password we JUST generated means
            // a surviving gbrain-pgdata volume: the postgres image ignores
            // POSTGRES_PASSWORD when a cluster already exists in the volume.
            // Reachable-with-wrong-auth is terminal — polling won't fix it,
            // and "never became reachable" would misdiagnose it.
            if (state === 'absent' && diag.reason === 'auth_failed') { authMismatch = true; break; }
            await new Promise((r) => setTimeout(r, 1000));
          }
          if (authMismatch) {
            note(
              'rung 4 (docker): a gbrain-pgdata volume survives from an earlier container, so the fresh password was ' +
              'ignored (postgres keeps the volume\'s original credentials) — the old brain is still in that volume. ' +
              'Adopt it by exporting GBRAIN_DATABASE_URL with the ORIGINAL password, or start clean with ' +
              'docker rm -f gbrain-postgres && docker volume rm gbrain-pgdata (destroys that brain). Next.',
            );
          } else if (!ready) {
            note('rung 4 (docker): the container never became reachable — next');
          } else {
            // Content guard on BOTH paths (reuse AND fresh-create — a fresh
            // container can attach a SURVIVING gbrain-pgdata volume). With
            // the existing-config refusal above, reaching this rung means
            // THIS home has no brain, so any content here is either another
            // home/user's brain (the container is machine-global) or foreign
            // tables. Fail-closed on 'unknown' — same predicate as rung 1.
            const content = await classifyDbContent(url);
            if (content === 'gbrain') {
              note(
                'rung 4 (docker): the gbrain-postgres container already holds a brain not recorded in this ' +
                'home\'s config — refusing to share it implicitly. To adopt it deliberately, export GBRAIN_DATABASE_URL ' +
                'with its connection string and re-run. Next.',
              );
            } else if (content !== 'empty') {
              note(
                `rung 4 (docker): the container's database holds non-gbrain tables (${content}) — refusing to ` +
                'initialize over them. Next.',
              );
            } else {
              note('rung 4 (docker): container ready. gbrain starts/reuses this container but never stops or removes it.');
              rung = await initPostgresRung(o, url, 'docker');
              if (rung) urlSource = 'docker';
            }
          }
        }
      } catch (e) {
        note(`rung 4 (docker): ${noteErr(e)} — next`);
      }
    }
  } else if (!rung && !o.allowDocker) {
    note('rung 4 (docker): not opted in (--allow-docker) — next');
  }

  // Rung 5 — PGLite, the zero-config floor. Terminal; no silent anything.
  if (!rung) {
    note('falling back to PGLite. Upgrade later: gbrain migrate --to supabase --url <postgres-conn> (docs/ENGINES.md; the postgres-adopt skill walks it).');
    await withStdoutToStderr(o.jsonOutput, () => initPGLite({
      jsonOutput: false,
      apiKey: o.apiKey ?? undefined,
      customPath: o.customPath ?? undefined,
      aiOpts: o.aiOpts,
      schemaPack: o.schemaPack,
      skipEmbedCheck: o.skipEmbedCheck,
    } as Parameters<typeof initPGLite>[0]));
    rung = 'pglite';
    urlSource = null;
  }

  if (o.jsonOutput) {
    console.log(JSON.stringify({
      status: 'ok',
      engine: rung === 'pglite' ? 'pglite' : 'postgres',
      ladder_rung: rung,
      url_source: urlSource,
    }));
  }
}
