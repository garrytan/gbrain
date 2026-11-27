-- G001_gbrain_telemetry.sql
-- gbrain's opt-in telemetry tables, in the Supabase project gbrain shares with
-- gstack (GST-3414, approved by the project owner 2026-11-22). The G prefix keeps
-- these files apart from gstack's numbered migrations (001-009).
--
-- Rules this file keeps (agreed with gstack's owner):
--   * Every object is gbrain_-prefixed, and nothing here reads, joins or
--     grants on a gstack object; nothing of gstack's reads these.
--   * The public (anon) key and signed-in users (authenticated) get nothing:
--     RLS is on with no policies and every privilege is revoked, the same
--     lockdown as gstack's 005 and 008. Only service_role (the
--     gbrain-telemetry-ingest and gbrain-telemetry-pulse edge functions) reads
--     or writes.
--   * No free text: every text column is a CHECKed pick from
--     src/core/telemetry/enums.json, a version, or an identifier
--     (error codes, doctor check ids, command and operation names) checked by
--     shape. test/gbrain-telemetry-backend.test.ts keeps the lists in step.
--   * Times are stored to the hour, so a row's time can't single out a session.
--   * Retention is 400 days (gbrain_telemetry_prune()).
--
-- Apply once with psql as the project owner, then deploy both functions, then
-- run supabase/gbrain-telemetry/verify.sh. Safe to run twice.

BEGIN;

CREATE TABLE IF NOT EXISTS public.gbrain_telemetry_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('hour', now()),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  event_type TEXT NOT NULL CHECK (event_type IN ('setup', 'upgrade', 'doctor', 'daily_rollup', 'consent')),
  event_hour TIMESTAMPTZ NOT NULL CHECK (event_hour = date_trunc('hour', event_hour)),
  gbrain_version TEXT NOT NULL CHECK (gbrain_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(\.[0-9]{1,6})?$'),
  os TEXT NOT NULL CHECK (os IN ('linux', 'darwin', 'win32', 'freebsd', 'other')),
  arch TEXT NOT NULL CHECK (arch IN ('x64', 'arm64', 'other')),
  bun_version TEXT CHECK (bun_version ~ '^[0-9]{1,3}\.[0-9]{1,3}$'),
  install_method TEXT NOT NULL CHECK (install_method IN ('bun_global', 'release_binary', 'git_clone', 'npm', 'unknown')),
  deployment TEXT NOT NULL CHECK (deployment IN ('local_pglite', 'local_postgres', 'self_hosted_http', 'thin_client_hosted', 'thin_client_self_hosted', 'unknown')),
  git_backed BOOLEAN,
  source TEXT NOT NULL CHECK (source IN ('live', 'test', 'ci', 'eval', 'capy', 'other')),
  tier TEXT NOT NULL CHECK (tier IN ('anonymous', 'community')),
  installation_id UUID CHECK (installation_id IS NULL OR tier = 'community'),
  -- setup
  harness TEXT CHECK (harness IN ('claude_code', 'codex', 'openclaw', 'hermes', 'cursor', 'opencode', 'pi', 'hosted', 'other')),
  step TEXT CHECK (step IN ('brain_create', 'mcp_register', 'hooks', 'instructions', 'wiring_smoke', 'done')),
  outcome TEXT CHECK (outcome IN ('success', 'error', 'abort')),
  error_code TEXT CHECK (error_code ~ '^[a-z][a-z0-9_-]{0,63}$'),
  embedding TEXT CHECK (embedding IN ('none', 'configured')),
  duration_s INTEGER CHECK (duration_s BETWEEN 0 AND 86400),
  -- upgrade
  from_version TEXT CHECK (from_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(\.[0-9]{1,6})?$'),
  to_version TEXT CHECK (to_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(\.[0-9]{1,6})?$'),
  channel TEXT CHECK (channel IN ('stable', 'latest', 'tag', 'unknown')),
  migrations_applied INTEGER CHECK (migrations_applied BETWEEN 0 AND 999),
  failed_migration INTEGER CHECK (failed_migration BETWEEN 0 AND 99999),
  wedged BOOLEAN,
  -- doctor
  score_band TEXT CHECK (score_band IN ('0-29', '30-49', '50-69', '70-89', '90-100')),
  failing_checks TEXT[] CHECK (cardinality(failing_checks) <= 10
    AND array_to_string(failing_checks, ',') ~ '^([a-z][a-z0-9_-]{0,63})?(,[a-z][a-z0-9_-]{0,63}){0,9}$'),
  mode TEXT CHECK (mode IN ('manual', 'autopilot', 'alert')),
  brain_size_band TEXT CHECK (brain_size_band IN ('0', '1-99', '100-999', '1k-9.9k', '10k+')),
  -- daily_rollup: {identifier: count} objects, validated key by key in the ingest
  rollup_day DATE,
  transport TEXT CHECK (transport IN ('stdio', 'http', 'none')),
  command_counts JSONB CHECK (command_counts IS NULL OR jsonb_typeof(command_counts) = 'object'),
  operation_counts JSONB CHECK (operation_counts IS NULL OR jsonb_typeof(operation_counts) = 'object'),
  error_code_counts JSONB CHECK (error_code_counts IS NULL OR jsonb_typeof(error_code_counts) = 'object'),
  crash_counts JSONB CHECK (crash_counts IS NULL OR jsonb_typeof(crash_counts) = 'object'),
  -- consent
  answer TEXT CHECK (answer IN ('anonymous', 'community'))
);

CREATE INDEX IF NOT EXISTS gbrain_telemetry_events_received_idx ON public.gbrain_telemetry_events (received_at);
CREATE INDEX IF NOT EXISTS gbrain_telemetry_events_type_version_idx ON public.gbrain_telemetry_events (event_type, gbrain_version);
CREATE INDEX IF NOT EXISTS gbrain_telemetry_events_installation_idx ON public.gbrain_telemetry_events (installation_id) WHERE installation_id IS NOT NULL;

-- One row per community-tier install: first and last day seen. No anonymous row.
CREATE TABLE IF NOT EXISTS public.gbrain_installations (
  installation_id UUID PRIMARY KEY,
  first_seen DATE NOT NULL DEFAULT current_date,
  last_seen DATE NOT NULL DEFAULT current_date,
  gbrain_version TEXT CHECK (gbrain_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}(\.[0-9]{1,6})?$'),
  os TEXT CHECK (os IN ('linux', 'darwin', 'win32', 'freebsd', 'other'))
);

-- The ingest's global daily ceiling: accepted requests and rows per UTC day,
-- and how many requests it refused (the pulse reports them).
CREATE TABLE IF NOT EXISTS public.gbrain_ingest_daily (
  day DATE PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  rows_accepted INTEGER NOT NULL DEFAULT 0,
  refused INTEGER NOT NULL DEFAULT 0
);

-- The pulse's one-hour cache. attempted_at is the refresh claim: one refresh
-- at a time, and at most one attempt every 5 minutes after a failure.
CREATE TABLE IF NOT EXISTS public.gbrain_pulse_cache (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  refreshed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempted_at TIMESTAMPTZ
);
ALTER TABLE public.gbrain_ingest_daily ADD COLUMN IF NOT EXISTS refused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.gbrain_pulse_cache ADD COLUMN IF NOT EXISTS attempted_at TIMESTAMPTZ;
INSERT INTO public.gbrain_pulse_cache (id, refreshed_at) VALUES (1, 'epoch') ON CONFLICT (id) DO NOTHING;

-- Real use only: live rows with a release-shaped version.
CREATE OR REPLACE VIEW public.gbrain_telemetry_live WITH (security_invoker = true) AS
SELECT *
FROM public.gbrain_telemetry_events
WHERE source = 'live'
  AND gbrain_version NOT LIKE '0.0.0%';

-- Reserve room under the daily ceiling for one request of p_rows rows. Returns
-- false (reserving nothing and counting the refusal) once either limit for
-- today is reached.
CREATE OR REPLACE FUNCTION public.gbrain_ingest_reserve(p_rows INTEGER, p_max_requests INTEGER, p_max_rows INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  ok BOOLEAN;
  today DATE := (now() AT TIME ZONE 'utc')::date;
BEGIN
  IF p_rows <= p_max_rows THEN
    INSERT INTO public.gbrain_ingest_daily AS d (day, requests, rows_accepted)
    VALUES (today, 1, p_rows)
    ON CONFLICT (day) DO UPDATE
      SET requests = d.requests + 1, rows_accepted = d.rows_accepted + p_rows
      WHERE d.requests < p_max_requests AND d.rows_accepted + p_rows <= p_max_rows
    RETURNING true INTO ok;
  END IF;
  IF ok IS NULL THEN
    INSERT INTO public.gbrain_ingest_daily AS d (day, refused) VALUES (today, 1)
    ON CONFLICT (day) DO UPDATE SET refused = d.refused + 1;
  END IF;
  RETURN coalesce(ok, false);
END
$$;

-- gbrain telemetry forget: the install's own row goes, and its id is blanked on
-- every stored event (the events stay, as anonymous rows).
CREATE OR REPLACE FUNCTION public.gbrain_telemetry_forget(p_installation_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  n INTEGER;
BEGIN
  DELETE FROM public.gbrain_installations WHERE installation_id = p_installation_id;
  UPDATE public.gbrain_telemetry_events
     SET installation_id = NULL, tier = 'anonymous'
   WHERE installation_id = p_installation_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Retention: events and installs unseen for 400 days, ceiling rows after 30.
-- Run daily (pg_cron where enabled: see README.md) or by hand monthly.
CREATE OR REPLACE FUNCTION public.gbrain_telemetry_prune()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  e INTEGER; i INTEGER; d INTEGER;
BEGIN
  DELETE FROM public.gbrain_telemetry_events WHERE received_at < now() - interval '400 days';
  GET DIAGNOSTICS e = ROW_COUNT;
  DELETE FROM public.gbrain_installations WHERE last_seen < current_date - 400;
  GET DIAGNOSTICS i = ROW_COUNT;
  DELETE FROM public.gbrain_ingest_daily WHERE day < current_date - 30;
  GET DIAGNOSTICS d = ROW_COUNT;
  RETURN jsonb_build_object('events', e, 'installations', i, 'ingest_days', d);
END
$$;

-- What the public pulse shows, over live rows received in the last 7 days.
-- p_max_version is the newest released gbrain version (the pulse function reads
-- it from GitHub); rows claiming a newer version are left out, so a forged
-- version can't fake a regression. NULL counts every release-shaped version.
-- Counts per harness x version are published as they are (counts, no ids);
-- any cell that crosses with brain size or failing checks needs 5 distinct
-- community installs. Every row is an unauthenticated report, so the
-- per-version lists cover 10 versions: the newest release always, then the
-- versions with the most setup, upgrade and doctor reports (daily rollups don't
-- rank), and each version lists at most 5 upgrade targets. The answer stays
-- small however many versions callers invent.
CREATE OR REPLACE FUNCTION public.gbrain_pulse_summary(p_max_version TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
WITH week AS (
  SELECT *,
         string_to_array(gbrain_version, '.')::int[] AS v
  FROM public.gbrain_telemetry_live
  WHERE received_at >= now() - interval '7 days'
),
known AS (
  SELECT * FROM week
  WHERE p_max_version IS NULL OR v <= string_to_array(p_max_version, '.')::int[]
),
top AS (
  SELECT v FROM known
  GROUP BY v
  ORDER BY (p_max_version IS NOT NULL AND v = string_to_array(p_max_version, '.')::int[]) DESC,
           count(*) FILTER (WHERE event_type <> 'daily_rollup') DESC, v DESC
  LIMIT 10
),
recent AS (
  SELECT * FROM known WHERE v IN (SELECT v FROM top)
),
setup AS (
  SELECT harness, gbrain_version, v,
         count(*) AS attempts,
         count(*) FILTER (WHERE outcome = 'success') AS successes,
         count(DISTINCT installation_id) AS installs
  FROM recent WHERE event_type = 'setup' AND step IS NOT NULL
  GROUP BY harness, gbrain_version, v
),
upgrades AS (
  SELECT to_version, gbrain_version, v,
         count(*) AS attempts,
         count(*) FILTER (WHERE outcome = 'error') AS failures,
         count(*) FILTER (WHERE wedged) AS wedged,
         count(DISTINCT installation_id) AS installs
  FROM recent WHERE event_type = 'upgrade'
    AND (to_version IS NULL OR p_max_version IS NULL
         OR string_to_array(to_version, '.')::int[] <= string_to_array(p_max_version, '.')::int[])
  GROUP BY to_version, gbrain_version, v
),
codes AS (
  SELECT gbrain_version, v, code, sum(n)::bigint AS n
  FROM (
    SELECT gbrain_version, v, error_code AS code, 1::bigint AS n FROM recent WHERE error_code IS NOT NULL
    UNION ALL
    SELECT k.gbrain_version, k.v, c.key, c.value::bigint
    FROM recent k, jsonb_each_text(k.error_code_counts) c
    WHERE k.event_type = 'daily_rollup' AND k.error_code_counts IS NOT NULL
  ) x
  GROUP BY gbrain_version, v, code
),
commands AS (
  SELECT c.key AS command, sum(c.value::bigint)::bigint AS n
  FROM known k, jsonb_each_text(k.command_counts) c
  WHERE k.event_type = 'daily_rollup' AND k.command_counts IS NOT NULL
  GROUP BY c.key
),
doctor AS (
  SELECT score_band, count(*) AS n FROM known WHERE event_type = 'doctor' AND score_band IS NOT NULL GROUP BY score_band
),
doctor_size AS (
  SELECT brain_size_band, score_band, count(*) AS n
  FROM known WHERE event_type = 'doctor' AND brain_size_band IS NOT NULL AND score_band IS NOT NULL
  GROUP BY brain_size_band, score_band
  HAVING count(DISTINCT installation_id) >= 5
)
SELECT jsonb_build_object(
  'window_days', 7,
  'max_version', p_max_version,
  'events', (SELECT count(*) FROM known),
  'community_installs', (SELECT count(DISTINCT installation_id) FROM known),
  'ceiling_refusals', (SELECT coalesce(sum(refused), 0) FROM public.gbrain_ingest_daily
      WHERE day > (now() AT TIME ZONE 'utc')::date - 7),
  'setup', coalesce((SELECT jsonb_agg(jsonb_build_object('harness', harness, 'version', gbrain_version,
      'attempts', attempts, 'successes', successes, 'installs', installs) ORDER BY v DESC, harness) FROM setup), '[]'::jsonb),
  'upgrades', coalesce((SELECT jsonb_agg(jsonb_build_object('to_version', to_version, 'version', gbrain_version,
      'attempts', attempts, 'failures', failures, 'wedged', wedged, 'installs', installs) ORDER BY v DESC, to_version)
      FROM (SELECT *, row_number() OVER (PARTITION BY gbrain_version ORDER BY attempts DESC, to_version) AS r FROM upgrades) t
      WHERE r <= 5), '[]'::jsonb),
  'error_codes', coalesce((SELECT jsonb_agg(jsonb_build_object('version', gbrain_version, 'code', code, 'count', n) ORDER BY v DESC, n DESC, code)
      FROM (SELECT *, row_number() OVER (PARTITION BY gbrain_version ORDER BY n DESC, code) AS r FROM codes) t WHERE r <= 10), '[]'::jsonb),
  'commands', coalesce((SELECT jsonb_agg(jsonb_build_object('command', command, 'count', n) ORDER BY n DESC, command)
      FROM (SELECT * FROM commands ORDER BY n DESC, command LIMIT 20) t), '[]'::jsonb),
  'doctor_bands', coalesce((SELECT jsonb_agg(jsonb_build_object('score_band', score_band, 'count', n) ORDER BY score_band) FROM doctor), '[]'::jsonb),
  'doctor_by_size', coalesce((SELECT jsonb_agg(jsonb_build_object('brain_size_band', brain_size_band, 'score_band', score_band, 'count', n)
      ORDER BY brain_size_band, score_band) FROM doctor_size), '[]'::jsonb)
);
$$;

-- Lockdown: RLS on with no policies, nothing for the public key or signed-in
-- users, everything for service_role. Functions also lose PUBLIC's default
-- EXECUTE (gstack 005's note).
ALTER TABLE public.gbrain_telemetry_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gbrain_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gbrain_ingest_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gbrain_pulse_cache ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.gbrain_telemetry_events, public.gbrain_installations, public.gbrain_ingest_daily,
  public.gbrain_pulse_cache, public.gbrain_telemetry_live FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.gbrain_ingest_reserve(INTEGER, INTEGER, INTEGER), public.gbrain_telemetry_forget(UUID),
  public.gbrain_telemetry_prune(), public.gbrain_pulse_summary(TEXT) FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.gbrain_telemetry_events, public.gbrain_installations,
  public.gbrain_ingest_daily, public.gbrain_pulse_cache TO service_role;
GRANT SELECT ON public.gbrain_telemetry_live TO service_role;
GRANT EXECUTE ON FUNCTION public.gbrain_ingest_reserve(INTEGER, INTEGER, INTEGER), public.gbrain_telemetry_forget(UUID),
  public.gbrain_telemetry_prune(), public.gbrain_pulse_summary(TEXT) TO service_role;

COMMIT;
