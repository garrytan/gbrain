/**
 * E10 managed connector-source job contract (GBRA-35 fix wave, lane L0).
 *
 * Drives every automatic connector-source maintenance job on a managed brain
 * (default source claimed, persistence activated) against an UNBOUND Google
 * connector source whose pages arrived through a real managed Gmail sweep.
 * Each case runs the real handler through a real MinionQueue + MinionWorker
 * (so retries and dead letters are the queue's own), with fake chat and
 * embedding transports, and is checked by one shared detector:
 *
 *   - guard refusals: the installed `gbrain_require_managed_writer()` is
 *     re-created with a non-transactional counter (`nextval`) in front of
 *     each of its RAISE statements, so a refusal that a caller swallows is
 *     still counted. The body is otherwise byte-identical (checked), and the
 *     original is restored at teardown. TS-side refusals
 *     (`writer_coordinator_required`, `owner_unavailable`) are counted from
 *     captured output, thrown errors and job error text.
 *   - receipts: a test-only AFTER trigger on every guarded table records each
 *     committed canonical row change (the guard's physical-projection
 *     exemptions mirrored) with its transaction id and the coordinator
 *     capability (`gbrain.write_sources`) it ran under; a second trigger
 *     records each persistence request as it commits. Every change must run
 *     under the capability for its own source, stay on the case's source,
 *     and commit in the same transaction as a committed request (its
 *     receipt). The one direct coordinated writer allowed without a request is
 *     the connector lease's freshness stamp on its own source row. Per-case
 *     assertions then compare what each job REPORTS with what committed.
 *   - dead letters: no job created during the case may end `dead`, and no job
 *     may fail with a structural refusal.
 *
 * Expected failures are keyed by issue in EXPECTED_FAILURES with the exact
 * failure signature; the runner asserts the case fails with that signature,
 * and fails with "flip me" once a lane's fix makes the case pass. Set
 * CONNECTOR_CONTRACT_DEBUG=1 to print job rows and each failure's captured
 * output.
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../../src/core/ai/gateway.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { maintenancePreflight, publishMaintenancePage } from '../../src/core/persistence/prepared-maintenance.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../../src/core/google/google-source.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../../src/commands/jobs.ts';
import { runExtract } from '../../src/commands/extract.ts';
import { runEmbed } from '../../src/commands/embed.ts';
import { countExtractAtomsBacklog } from '../../src/core/cycle/extract-atoms.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { json, googleConfig, withGoogleAccount } from './connector-fixture.ts';
import { withEnv } from './with-env.ts';

export const GUARDED_TABLES = ['pages', 'tags', 'slug_aliases', 'page_aliases', 'facts', 'takes', 'timeline_entries', 'sources'] as const;

export const contractCases = [
  'detector_self_test',
  'gmail_sweep_loops_enqueue',
  'loops_extract_run',
  'loops_close',
  'cycle_extract',
  'cycle_extract_loops_race',
  'cycle_extract_facts',
  'extract_conversation_facts',
  'facts_absorb',
  'atom_drain_opted_out',
  'atom_drain_default_on',
  'atom_dispatch',
  'embed_backfill',
  'synthesize_publish',
  'synthesize_publish_busy_writer',
  'extract_timeline_db',
  'handler_enumeration',
] as const;
export type ContractCase = typeof contractCases[number];

/** Cases that need a second database connection (Postgres only). */
export const POSTGRES_ONLY_CASES: ReadonlySet<ContractCase> = new Set(['synthesize_publish_busy_writer']);

/**
 * Known failures on the base (origin/capy/fix-wave-7 3ac9e5e0). Each lane that
 * fixes an issue deletes its entries; the runner fails a listed case that
 * passes. `signature` must match the case's failure message.
 */
export const EXPECTED_FAILURES: Partial<Record<ContractCase, { issue: string; signature: RegExp; engines?: ReadonlyArray<'pglite' | 'postgres'> }>> = {
};

/**
 * #5856 (Garry, Oct 2): connector email/meeting atom extraction is opt-in
 * behind one setting, default off. Lane L6 owns the key's final name; keep
 * this constant in step with it.
 */
export const CONNECTOR_ATOMS_SETTING = { key: 'cycle.extract_atoms.connector_pages', off: 'false' } as const;

/**
 * Handlers from registerBuiltinHandlers that this contract does not drive on
 * a connector source, each with the reason. A new handler fails the
 * enumeration case until it is covered or listed here.
 */
export const HANDLER_COVERAGE: Record<string, { covered: ContractCase } | { exempt: string }> = {
  'autopilot-cycle': { covered: 'cycle_extract' },
  'extract_facts': { covered: 'cycle_extract_facts' },
  'extract-conversation-facts': { covered: 'extract_conversation_facts' },
  'facts-absorb': { covered: 'facts_absorb' },
  'extract-atoms-drain': { covered: 'atom_drain_default_on' },
  'loops_extract': { covered: 'loops_extract_run' },
  'embed-backfill': { covered: 'embed_backfill' },
  'synthesize': { covered: 'synthesize_publish' },
  'extract': { covered: 'extract_timeline_db' },
  'connector-sync': { covered: 'gmail_sweep_loops_enqueue' },
  'sync': { covered: 'gmail_sweep_loops_enqueue' },
  'autopilot-global-maintenance': { exempt: 'brain-wide maintenance; selects no connector source' },
  'backlinks': { exempt: 'filesystem back-link writer for checkout sources; refused on managed brains (backlinks-managed-refusal test)' },
  'chronicle_extract': { exempt: 'Life Chronicle extraction over conversation transcripts, not connector pages; owned by wave 7 (ops/chronicle.ts)' },
  'consolidate': { exempt: 'dream consolidate phase over the facts table; not scoped to a connector source' },
  'contextual_reindex_per_chunk': { exempt: 'chunk-level reindex child of contextual retrieval; writes content_chunks only (unguarded)' },
  'embed': { exempt: 'chunk embedding; writes content_chunks only (unguarded); embed_backfill drives the source-scoped path' },
  'embed-catch-up': { exempt: 'brain-wide embedding catch-up over the same path embed_backfill drives' },
  'enrich': { exempt: 'operator-requested entity enrichment; not an automatic connector job' },
  'extract-ner': { exempt: 'opt-in NER over checkout sources; not dispatched for connector sources' },
  'extract-takes-from-pages': { exempt: 'takes extraction; covered by managed-takes tests, not dispatched for connector sources' },
  'extract-timeline-from-meetings': { exempt: 'operator-requested backfill; the db timeline path is covered by extract_timeline_db' },
  'import': { exempt: 'filesystem import for checkout sources' },
  'ingest_capture': { exempt: 'capture inbox ingestion into the default source' },
  'integrity': { exempt: 'read-only integrity report' },
  'integrity-auto': { exempt: 'filesystem integrity repair for checkout sources' },
  'lint': { exempt: 'filesystem lint for checkout sources' },
  'lint-fix': { exempt: 'filesystem lint fix for checkout sources' },
  'orphans': { exempt: 'read-only orphan report' },
  'patterns': { exempt: 'dream patterns phase over synthesis output, not connector pages' },
  'purge': { exempt: 'operator purge of deleted pages; covered by purge tests' },
  'recompute_emotional_weight': { exempt: 'writes pages.emotional_weight, a physical projection column outside the guard' },
  'reindex': { exempt: 'search reindex; projection tables only' },
  'repair-jsonb': { exempt: 'one-shot JSONB repair migration helper' },
  'resolve_symbol_edges': { exempt: 'code-symbol edges for code sources' },
  'shell': { exempt: 'operator shell job; opt-in and not a maintenance writer' },
  'skillopt': { exempt: 'protected skill optimizer; writes skill files, not connector pages' },
  'subagent': { exempt: 'agent runtime; its writes go through ordinary operations' },
  'subagent_aggregator': { exempt: 'agent runtime aggregator' },
  'sync-retry-failed': { exempt: 'checkout sync retry; connector retries are covered by persistence-connector-retry tests' },
  'unify-types': { exempt: 'operator type unification migration' },
};

const USAGE = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };
const CHAT_MODEL = 'anthropic:claude-sonnet-4-6';
const FAKE_ENV = { ANTHROPIC_API_KEY: 'sk-ant-contract-fake', OPENAI_API_KEY: 'sk-contract-fake', VOYAGE_API_KEY: undefined };
const THREAD_ID = '17aa00000000c001';
const MESSAGE_ID = '18c2f4a9b3d20001';
const EMAIL_BODY = [
  'Hi, can you send me the quarterly plan by Friday? I will review it on Monday.',
  '',
  'Some context for the review: the plan should cover hiring, the support backlog and the two launch dates we discussed.',
  'Last quarter the review slipped because the numbers arrived late, so this time the finance appendix should be attached to the first draft.',
  'If the launch dates move, flag it in the summary rather than in the appendix, so the board pre-read stays accurate.',
  'I will circulate my comments to the team the same day and we can settle open questions in the Tuesday sync.',
  '',
  '- **2026-09-28** | Quarterly plan draft requested',
].join('\n');
const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');

/** Routes the fake model by the prompt it receives (loops, atoms, facts). */
function fakeChat(opts: unknown): ChatResult {
  const prompt = JSON.stringify(opts);
  let text: string;
  if (prompt.includes('decisions_pending')) {
    text = JSON.stringify({ commitments: [{ text: 'Send the quarterly plan by Friday', direction: 'owed_by_me',
      counterparty_name: 'people/alice-example', counterparty_email: 'alice@example.invalid', due_iso: '2026-10-09',
      quote: 'can you send me the quarterly plan by Friday?' }], decisions_pending: [] });
  } else if (prompt.includes('atom_type')) {
    text = '[{"title":"Plan reviews","atom_type":"insight","body":"Quarterly plans are reviewed on the Monday after they are sent."}]';
  } else {
    text = JSON.stringify({ facts: [{ fact: 'Alice Example reviews the quarterly plan on Mondays.', kind: 'fact',
      entity: 'people/alice-example', confidence: 0.9, notability: 'high' }] });
  }
  return { text, blocks: [], stopReason: 'end', usage: USAGE, model: CHAT_MODEL, providerId: 'anthropic' };
}

export interface ContractBrain {
  engine: BrainEngine;
  home: string;
  env: Record<string, string | undefined>;
  original: string;
  embedding: { model: string; dimensions: number };
}

interface Detector {
  refusals: Record<string, number>;
  requests: number;
  auditFrom: number;
  jobsFrom: number;
  output: string[];
}

interface CaseState {
  brain: ContractBrain;
  sourceId: string;
  dir: string;
  ctx: OperationContext;
  emailSlug: string;
  detector: Detector;
}

/** Installs the managed brain and the detector. Call once per file. */
export async function setupContractBrain(engine: BrainEngine): Promise<ContractBrain> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-connector-job-contract-'));
  const env = { GBRAIN_HOME: home, CONNECTOR_TEST_TOKEN: 'synthetic-local-fixture', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, ...FAKE_ENV };
  return withEnv(env, async () => {
    const root = join(home, 'content'); mkdirSync(root);
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    await claimWorktree(engine, 'default', root);
    await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
    const [fn] = await engine.executeRaw<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE proname='gbrain_require_managed_writer'");
    const original = fn.src;
    await installDetector(engine, original);
    await engine.setConfig('loops.extraction_enabled', 'true');
    // Facts extraction is on only for the facts-lane cases, so no other case's
    // publications queue facts-absorb work into a later case.
    await engine.setConfig('facts.extraction_enabled', 'false');
    await engine.setConfig('models.chat', CHAT_MODEL);
    const embedding = { model: await engine.getConfig('embedding_model') ?? 'openai:text-embedding-3-large',
      dimensions: Number(await engine.getConfig('embedding_dimensions') ?? 1536) };
    return { engine, home, env, original, embedding };
  });
}

export async function teardownContractBrain(brain: ContractBrain | undefined): Promise<void> {
  if (!brain) return;
  __setChatTransportForTests(null); __setEmbedTransportForTests(null); resetGateway();
  try {
    await disposePersistenceConsumer(brain.engine);
    await brain.engine.executeRaw(`CREATE OR REPLACE FUNCTION gbrain_require_managed_writer() RETURNS trigger LANGUAGE plpgsql AS $fn$${brain.original}$fn$`);
  } finally { rmSync(brain.home, { recursive: true, force: true }); }
}

const REFUSAL = "RAISE EXCEPTION USING ERRCODE='P0001'";
function instrumentedGuard(original: string): string {
  const count = original.split(REFUSAL).length - 1;
  if (count < 3) throw new Error(`detector: expected the managed writer guard's RAISE statements, found ${count}`);
  return original.replaceAll(REFUSAL, `PERFORM nextval(('gbrain_contract_refusal_' || TG_TABLE_NAME)::regclass); ${REFUSAL}`);
}

async function installDetector(engine: BrainEngine, original: string): Promise<void> {
  for (const table of GUARDED_TABLES) await engine.executeRaw(`CREATE SEQUENCE IF NOT EXISTS gbrain_contract_refusal_${table}`);
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION gbrain_require_managed_writer() RETURNS trigger LANGUAGE plpgsql AS $fn$${instrumentedGuard(original)}$fn$`);
  const [check] = await engine.executeRaw<{ src: string }>("SELECT prosrc AS src FROM pg_proc WHERE proname='gbrain_require_managed_writer'");
  if (check.src.replace(/PERFORM nextval\(\('gbrain_contract_refusal_' \|\| TG_TABLE_NAME\)::regclass\); /g, '') !== original) {
    throw new Error('detector: the instrumented guard differs from the installed guard beyond its counters');
  }
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS gbrain_contract_changes (
    id bigserial PRIMARY KEY, tbl text NOT NULL, op text NOT NULL, source_id text, row_key text,
    capability text, topology text, brain_enabled boolean NOT NULL, freshness boolean NOT NULL, txid text NOT NULL)`);
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS gbrain_contract_receipts (
    id bigserial PRIMARY KEY, request_id uuid NOT NULL, source_id text NOT NULL, slug text NOT NULL, kind text, txid text NOT NULL)`);
  // Mirrors the guard's exemptions so physical projection updates (embeddings,
  // retrieval telemetry, non-canonical page columns, source config) are not
  // counted as canonical changes.
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION gbrain_contract_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE row_data jsonb; old_data jsonb; src text; freshness boolean := false;
BEGIN
  row_data := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  IF TG_OP='UPDATE' THEN old_data := to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME='pages' AND TG_OP='UPDATE' THEN
    IF (NEW.source_id,NEW.slug,NEW.type,NEW.page_kind,NEW.title,NEW.compiled_truth,NEW.timeline,NEW.frontmatter,NEW.deleted_at,NEW.knowledge_revision)
      IS NOT DISTINCT FROM (OLD.source_id,OLD.slug,OLD.type,OLD.page_kind,OLD.title,OLD.compiled_truth,OLD.timeline,OLD.frontmatter,OLD.deleted_at,OLD.knowledge_revision) THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME='sources' AND TG_OP='UPDATE' THEN
    IF (NEW.id,NEW.incarnation,NEW.local_path,NEW.archived,NEW.last_commit,NEW.last_sync_at,NEW.newest_content_at)
      IS NOT DISTINCT FROM (OLD.id,OLD.incarnation,OLD.local_path,OLD.archived,OLD.last_commit,OLD.last_sync_at,OLD.newest_content_at) THEN RETURN NULL; END IF;
    freshness := (NEW.id,NEW.incarnation,NEW.local_path,NEW.archived) IS NOT DISTINCT FROM (OLD.id,OLD.incarnation,OLD.local_path,OLD.archived);
  ELSIF TG_TABLE_NAME IN ('facts','takes') AND TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='facts' THEN
      row_data := row_data - ARRAY['embedding_model','embedded_text_hash'];
      old_data := old_data - ARRAY['embedding_model','embedded_text_hash'];
    END IF;
    IF (row_data - ARRAY['embedding','embedded_at','last_retrieved_at','retrieval_count','updated_at'])
      = (old_data - ARRAY['embedding','embedded_at','last_retrieved_at','retrieval_count','updated_at']) THEN RETURN NULL; END IF;
  END IF;
  IF TG_TABLE_NAME='sources' THEN src := row_data->>'id';
  ELSIF row_data ? 'source_id' THEN src := row_data->>'source_id';
  ELSE SELECT source_id INTO src FROM pages WHERE id=(row_data->>'page_id')::integer; END IF;
  INSERT INTO gbrain_contract_changes(tbl,op,source_id,row_key,capability,topology,brain_enabled,freshness,txid)
  VALUES (TG_TABLE_NAME, TG_OP, src, COALESCE(row_data->>'slug', row_data->>'id', row_data->>'page_id'),
    NULLIF(current_setting('gbrain.write_sources',true),''), NULLIF(current_setting('gbrain.topology_change',true),''),
    EXISTS (SELECT 1 FROM persistence_brain WHERE singleton=1 AND enabled), freshness, txid_current()::text);
  RETURN NULL;
END $fn$`);
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION gbrain_contract_receipt() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.state='committed' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM 'committed') THEN
    INSERT INTO gbrain_contract_receipts(request_id,source_id,slug,kind,txid) VALUES (NEW.id,NEW.source_id,NEW.slug,COALESCE(NEW.intent->>'kind',NEW.operation),txid_current()::text);
  END IF;
  RETURN NULL;
END $fn$`);
  for (const table of GUARDED_TABLES) {
    await engine.executeRaw(`DROP TRIGGER IF EXISTS gbrain_contract_audit ON ${table}`);
    await engine.executeRaw(`CREATE TRIGGER gbrain_contract_audit AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION gbrain_contract_audit()`);
    await engine.executeRaw(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER gbrain_contract_audit`);
  }
  await engine.executeRaw('DROP TRIGGER IF EXISTS gbrain_contract_receipt ON persistence_requests');
  await engine.executeRaw('CREATE TRIGGER gbrain_contract_receipt AFTER INSERT OR UPDATE ON persistence_requests FOR EACH ROW EXECUTE FUNCTION gbrain_contract_receipt()');
}

async function refusalCounts(engine: BrainEngine): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of GUARDED_TABLES) {
    const [row] = await engine.executeRaw<{ n: string | number; called: boolean }>(`SELECT last_value AS n, is_called AS called FROM gbrain_contract_refusal_${table}`);
    out[table] = row.called ? Number(row.n) : 0;
  }
  return out;
}

async function maxId(engine: BrainEngine, table: string): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number | null }>(`SELECT max(id)::int AS n FROM ${table}`);
  return row?.n ?? 0;
}

const realStderr = process.stderr.write.bind(process.stderr);
const debug = (label: string, value: unknown) => { if (process.env.CONNECTOR_CONTRACT_DEBUG) realStderr(`[contract] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`); };

const STRUCTURAL = /writer_coordinator_required|owner_unavailable/;

async function startDetector(engine: BrainEngine): Promise<Detector> {
  return { refusals: await refusalCounts(engine), requests: 0, auditFrom: await maxId(engine, 'gbrain_contract_changes'),
    jobsFrom: await maxId(engine, 'minion_jobs'), output: [] };
}

/** The detector verdict for everything that happened since startDetector. */
export async function detectorFindings(state: Pick<CaseState, 'brain' | 'detector'> & { sourceId?: string }, opts: { allowedSources?: string[] } = {}): Promise<string[]> {
  const { engine } = state.brain;
  const d = state.detector;
  const findings: string[] = [];
  const now = await refusalCounts(engine);
  const refused = Object.entries(now).filter(([t, n]) => n > (d.refusals[t] ?? 0)).map(([t, n]) => `${t}=${n - (d.refusals[t] ?? 0)}`);
  if (refused.length) findings.push(`guard refusals: ${refused.join(' ')}`);
  const changes = await engine.executeRaw<{ tbl: string; op: string; source_id: string | null; row_key: string | null; capability: string | null; topology: string | null; brain_enabled: boolean; txid: string }>(
    'SELECT tbl,op,source_id,row_key,capability,topology,brain_enabled,txid FROM gbrain_contract_changes WHERE id > $1 ORDER BY id', [d.auditFrom]);
  const allowed = new Set(opts.allowedSources ?? (state.sourceId ? [state.sourceId] : []));
  for (const c of changes) {
    if (!c.brain_enabled) { findings.push(`unguarded change (brain disabled): ${c.tbl} ${c.op} ${c.source_id}/${c.row_key}`); continue; }
    if (c.tbl === 'sources' && c.topology === 'on') continue;
    const capability: string[] = c.capability ? JSON.parse(c.capability) : [];
    if (c.source_id && !capability.includes(c.source_id)) findings.push(`change outside a coordinator publication: ${c.tbl} ${c.op} ${c.source_id}/${c.row_key}`);
    if (c.source_id && allowed.size && !allowed.has(c.source_id)) findings.push(`change outside the case source: ${c.tbl} ${c.op} ${c.source_id}/${c.row_key}`);
  }
  // A canonical change must commit in the same transaction as a committed
  // persistence request (its receipt). The one direct coordinated writer
  // allowed without a request is the connector lease's freshness stamp
  // (last_sync_at / newest_content_at / last_commit on its own source row).
  const unreceipted = await engine.executeRaw<{ tbl: string; op: string; source_id: string | null; row_key: string | null }>(
    `SELECT c.tbl, c.op, c.source_id, c.row_key FROM gbrain_contract_changes c WHERE c.id > $1 AND c.brain_enabled AND NOT c.freshness
      AND COALESCE(c.topology,'') <> 'on' AND NOT EXISTS (SELECT 1 FROM gbrain_contract_receipts r WHERE r.txid=c.txid) ORDER BY c.id`, [d.auditFrom]);
  for (const c of unreceipted) findings.push(`change without a coordinator publication receipt: ${c.tbl} ${c.op} ${c.source_id}/${c.row_key}`);
  const jobs = await engine.executeRaw<{ id: number; name: string; status: string; attempts_started: number; error_text: string | null }>(
    'SELECT id,name,status,attempts_started,error_text FROM minion_jobs WHERE id > $1 ORDER BY id', [d.jobsFrom]);
  for (const job of jobs) {
    if (job.status === 'dead') findings.push(`dead letter: ${job.name}#${job.id} after ${job.attempts_started} attempt(s): ${job.error_text ?? ''}`);
    else if (job.error_text && STRUCTURAL.test(job.error_text)) findings.push(`structural refusal: ${job.name}#${job.id}: ${job.error_text}`);
  }
  const text = d.output.join('\n');
  const structural = text.match(new RegExp(STRUCTURAL.source, 'g'));
  if (structural) findings.push(`structural refusal in output (${structural.length}x): ${[...new Set(structural)].join(',')}`);
  return findings;
}

/** Committed canonical changes since the case started, with request attribution. */
async function changesSince(state: CaseState) {
  return state.brain.engine.executeRaw<{ tbl: string; op: string; row_key: string | null; request_kind: string | null }>(
    `SELECT c.tbl, c.op, c.row_key, (SELECT r.kind FROM gbrain_contract_receipts r WHERE r.txid=c.txid LIMIT 1) AS request_kind
       FROM gbrain_contract_changes c WHERE c.id > $1 AND c.source_id = $2 ORDER BY c.id`, [state.detector.auditFrom, state.sourceId]);
}

function capture<T>(sink: string[], fn: () => Promise<T>): Promise<T> {
  const write = process.stderr.write.bind(process.stderr);
  const outWrite = process.stdout.write.bind(process.stdout);
  const { log, warn, error, info } = console;
  const push = (...args: unknown[]) => { sink.push(`${args.map(a => typeof a === 'string' ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a)).join(' ')}\n`); };
  process.stderr.write = ((chunk: string | Uint8Array) => { sink.push(String(chunk)); return true; }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { sink.push(String(chunk)); return true; }) as typeof process.stdout.write;
  console.log = push; console.warn = push; console.error = push; console.info = push;
  return fn().finally(() => {
    process.stderr.write = write; process.stdout.write = outWrite;
    console.log = log; console.warn = warn; console.error = error; console.info = info;
  });
}

/** Submits jobs and runs them on a real worker until every one is terminal. */
async function runJobs(engine: BrainEngine, jobs: Array<{ name: string; data: Record<string, unknown> }>, timeoutMs = 60_000) {
  const queue = new MinionQueue(engine);
  const ids: number[] = [];
  for (const job of jobs) {
    const row = await queue.add(job.name, job.data, { queue: 'default', max_attempts: 3, backoff_type: 'fixed', backoff_delay: 10 }, { allowProtectedSubmit: true });
    ids.push(row.id);
  }
  return drainQueue(engine, ids, timeoutMs);
}

async function drainQueue(engine: BrainEngine, ids: number[], timeoutMs = 60_000) {
  const worker = new MinionWorker(engine, { pollInterval: 20, healthCheckInterval: 0, stalledInterval: 600_000 });
  await registerBuiltinHandlers(worker, engine, { quiet: true });
  const running = worker.start();
  const deadline = Date.now() + timeoutMs;
  let rows: Array<{ id: number; name: string; status: string; attempts_started: number; attempts_made: number; max_attempts: number; result: unknown; error_text: string | null }> = [];
  try {
    for (;;) {
      rows = await engine.executeRaw('SELECT id,name,status,attempts_started,attempts_made,max_attempts,result,error_text FROM minion_jobs WHERE id = ANY($1::int[]) ORDER BY id', [ids]);
      const done = rows.every(r => ['completed', 'dead', 'cancelled'].includes(r.status) || r.status === 'failed' && r.attempts_made >= r.max_attempts);
      if (done) break;
      if (Date.now() > deadline) throw new Error(`jobs did not settle: ${JSON.stringify(rows.map(r => [r.name, r.status, r.attempts_started, r.error_text]))}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally { worker.stop(); await running; }
  debug('jobs', rows.map(r => ({ name: r.name, status: r.status, attempts: r.attempts_started, result: r.result, error: r.error_text })));
  return rows.map(r => ({ ...r, result: typeof r.result === 'string' ? JSON.parse(r.result) : r.result }));
}

function requireCompleted(rows: Awaited<ReturnType<typeof drainQueue>>): void {
  for (const r of rows) if (r.status !== 'completed') throw new Error(`${r.name} ended ${r.status} after ${r.attempts_started} attempt(s): ${r.error_text ?? ''}`);
}

/** A fresh unbound Google connector source whose email page arrived through a real managed Gmail sweep. */
async function connectorSource(brain: ContractBrain): Promise<CaseState> {
  const { engine } = brain;
  const sourceId = `gmail-${randomUUID().slice(0, 8)}`;
  const dir = join(brain.home, sourceId); mkdirSync(dir);
  const config = { ...googleConfig, g_services: 'gmail', g_history_days: 7 };
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [sourceId, dir, JSON.stringify(config)]);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const ctx = { engine, config: { engine: engine.kind }, sourceId, remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'people/alice-example', request_id: randomUUID(),
    content: '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nA colleague who reviews plans.\n' } });
  await disposePersistenceConsumer(engine);
  return { brain, sourceId, dir, ctx, emailSlug: '', detector: await startDetector(engine) };
}

/** The managed Gmail sweep with the autopilot sync defaults (noExtract: true, as the sync handler sets it). */
async function gmailSweep(state: CaseState) {
  const cfg = parseGoogleSourceConfig({ ...googleConfig, g_services: 'gmail', g_history_days: 7 }, state.dir);
  const sent = Date.now() - 3 * 3600_000;
  let listed = false;
  const fetcher = async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
    if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: cfg.account, historyId: '1000' });
    if (u.pathname.endsWith('/users/me/messages')) {
      const messages = listed ? [] : [{ id: MESSAGE_ID, threadId: THREAD_ID }];
      listed = true;
      return json({ messages });
    }
    if (u.pathname.endsWith('/users/me/history')) return json({ historyId: '1000', history: [] });
    if (/\/users\/me\/threads\/[^/]+$/.test(u.pathname)) {
      return json({ id: THREAD_ID, messages: [{ id: MESSAGE_ID, threadId: THREAD_ID, labelIds: ['INBOX'], internalDate: String(sent),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Alice Example <alice@example.invalid>' }, { name: 'To', value: cfg.account },
          { name: 'Subject', value: 'Quarterly plan' }], body: { data: b64url(EMAIL_BODY) } } }] });
    }
    return json({ error: { message: `unexpected fixture route ${u.pathname}` } }, 400);
  };
  const result = await runGoogleSync(state.brain.engine, state.sourceId, cfg, { noEmbed: true, noExtract: true, noSchemaPack: true } as never,
    withGoogleAccount(fetcher, cfg.account));
  await disposePersistenceConsumer(state.brain.engine);
  const [page] = await state.brain.engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND type='email' AND deleted_at IS NULL", [state.sourceId]);
  if (!page) throw new Error(`fixture: the managed Gmail sweep landed no email page (${JSON.stringify(result)})`);
  state.emailSlug = page.slug;
  return result;
}

async function loopsJobs(state: CaseState) {
  return state.brain.engine.executeRaw<{ id: number; data: Record<string, unknown> }>(
    "SELECT id,data FROM minion_jobs WHERE name='loops_extract' AND data->>'sourceId'=$1 AND id > $2", [state.sourceId, state.detector.jobsFrom]);
}

async function extractLoops(state: CaseState) {
  const rows = await runJobs(state.brain.engine, [{ name: 'loops_extract', data: { slug: state.emailSlug, sourceId: state.sourceId, threadId: THREAD_ID } }]);
  requireCompleted(rows);
  return rows[0];
}

async function activeFacts(state: CaseState) {
  return state.brain.engine.executeRaw<{ id: number; fact: string; expired_at: string | null }>(
    'SELECT id,fact,expired_at::text FROM facts WHERE source_id=$1 ORDER BY id', [state.sourceId]);
}

async function staleCount(state: CaseState): Promise<number> {
  return state.brain.engine.countStalePagesForExtraction({ sourceId: state.sourceId });
}

const cases: Record<ContractCase, (state: CaseState) => Promise<void>> = {
  async detector_self_test(state) {
    const { engine } = state.brain;
    const refused = await engine.executeRaw("INSERT INTO facts(source_id,entity_slug,fact,kind,source) VALUES($1,'people/alice-example','Raw write','fact','contract')", [state.sourceId])
      .then(() => null, (e: Error) => e.message);
    expect(refused).toContain('writer_coordinator_required');
    const findings = await detectorFindings(state);
    expect(findings).toEqual(['guard refusals: facts=1']);
    state.detector.refusals = await refusalCounts(engine);
    await submitPageMutation(state.ctx, { operation: 'put_page', params: { slug: 'notes/detector', request_id: randomUUID(),
      content: '---\ntitle: Detector\ntype: note\n---\nA coordinated write.\n' } });
    const changes = await changesSince(state);
    const page = changes.find(c => c.tbl === 'pages' && c.row_key === 'notes/detector');
    expect(page?.request_kind).toBeTruthy();
  },

  async gmail_sweep_loops_enqueue(state) {
    await gmailSweep(state);
    const jobs = await loopsJobs(state);
    if (jobs.length === 0) throw new Error('loops_extract jobs enqueued by the managed sweep: 0');
    expect(jobs.map(j => j.data.slug)).toContain(state.emailSlug);
    requireCompleted(await drainQueue(state.brain.engine, jobs.map(j => j.id)));
  },

  async loops_extract_run(state) {
    await gmailSweep(state);
    const job = await extractLoops(state);
    expect(job.result).toMatchObject({ status: 'extracted', commitments: 1 });
    const facts = await activeFacts(state);
    expect(facts.map(f => [f.fact, f.expired_at])).toEqual([['Send the quarterly plan by Friday', null]]);
    const factChanges = (await changesSince(state)).filter(c => c.tbl === 'facts');
    expect(factChanges.length).toBeGreaterThan(0);
  },

  async loops_close(state) {
    await gmailSweep(state);
    await extractLoops(state);
    const [loop] = await state.brain.engine.executeRaw<{ id: number; fact_id: number | null }>(
      "SELECT id,fact_id FROM open_loops WHERE source_id=$1 AND status='open' AND fact_id IS NOT NULL", [state.sourceId]);
    if (!loop) throw new Error('fixture: loops_extract opened no commitment loop with a fact');
    const result = await operationsByName.loops_close.handler(state.ctx, { id: loop.id, status: 'done', source_id: state.sourceId }) as Record<string, unknown>;
    const [fact] = await state.brain.engine.executeRaw<{ expired_at: string | null }>('SELECT expired_at::text FROM facts WHERE id=$1', [loop.fact_id]);
    if (result.fact_expired === true && fact.expired_at === null) throw new Error('loops_close reported fact_expired=true but the fact is still active');
    expect(result).toMatchObject({ closed: true, fact_expired: true });
    expect(fact.expired_at).not.toBeNull();
  },

  async cycle_extract(state) {
    await gmailSweep(state);
    const { engine } = state.brain;
    // Settle the jobs the sweep queued (loops_extract) first: the cycle's worker would
    // otherwise run them beside the extract phase and leave a page rewritten after it.
    const queued = await engine.executeRaw<{ id: number }>("SELECT id FROM minion_jobs WHERE status IN ('waiting','delayed')");
    if (queued.length) await drainQueue(engine, queued.map(row => Number(row.id)));
    await submitPageMutation(state.ctx, { operation: 'put_page', params: { slug: 'notes/plan-review', request_id: randomUUID(),
      content: '---\ntitle: Plan review\ntype: note\n---\nReviewed with [[people/alice-example]].\n' } });
    await engine.executeRaw("DELETE FROM links WHERE from_page_id IN (SELECT id FROM pages WHERE source_id=$1 AND slug='notes/plan-review')", [state.sourceId]);
    await engine.executeRaw("UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1", [state.sourceId]);
    expect(await staleCount(state)).toBeGreaterThan(0);
    // The sweep queued loops_extract (priority 5). Left waiting, the cycle's worker can
    // claim it once the cycle job finishes; its commitment fact then republishes
    // people/alice-example after the extract phase stamped it, and that page reads stale.
    await engine.executeRaw("UPDATE minion_jobs SET status='cancelled' WHERE id > $1 AND status IN ('waiting','delayed')", [state.detector.jobsFrom]);
    const [job] = await runJobs(engine, [{ name: 'autopilot-cycle', data: { source_id: state.sourceId, phases: ['extract'] } }], 120_000);
    requireCompleted([job]);
    const extract = (job.result as { report?: { phases?: Array<{ phase: string; status: string; details?: Record<string, unknown> }> } }).report?.phases?.find(p => p.phase === 'extract');
    if (extract?.status === 'skipped') throw new Error(`cycle extract phase: skipped (${String(extract.details?.reason)})`);
    expect(extract?.status).toBe('ok');
    expect(await staleCount(state)).toBe(0);
    const links = await engine.executeRaw(`SELECT 1 FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
      WHERE f.source_id=$1 AND f.slug='notes/plan-review' AND t.slug='people/alice-example'`, [state.sourceId]);
    expect(links).toHaveLength(1);
  },

  /**
   * #5961 bound: a loops_extract the sweep queued can republish a page after
   * the extract phase stamped it (eventual consistency, no lock between the
   * two). Worst-case order: the cycle stamps every page, then the competing
   * job republishes people/alice-example, which reads stale again; the next
   * cycle re-extracts it, so staleness is bounded by one cycle.
   */
  async cycle_extract_loops_race(state) {
    await gmailSweep(state);
    const { engine } = state.brain;
    await engine.executeRaw("UPDATE minion_jobs SET status='cancelled' WHERE id > $1 AND status IN ('waiting','delayed')", [state.detector.jobsFrom]);
    await engine.executeRaw("UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1", [state.sourceId]);
    const cycle = async () => {
      const [job] = await runJobs(engine, [{ name: 'autopilot-cycle', data: { source_id: state.sourceId, phases: ['extract'] } }], 120_000);
      requireCompleted([job]);
      const extract = (job.result as { report?: { phases?: Array<{ phase: string; status: string }> } }).report?.phases?.find(p => p.phase === 'extract');
      expect(extract?.status).toBe('ok');
    };
    await cycle();
    expect(await staleCount(state)).toBe(0);
    const competing = await extractLoops(state);
    expect(competing.result).toMatchObject({ status: 'extracted', commitments: 1 });
    expect(await staleCount(state)).toBeGreaterThan(0);
    await engine.executeRaw("UPDATE minion_jobs SET status='cancelled' WHERE id > $1 AND status IN ('waiting','delayed')", [state.detector.jobsFrom]);
    await cycle();
    expect(await staleCount(state)).toBe(0);
  },

  async cycle_extract_facts(state) {
    await gmailSweep(state);
    const [job] = await runJobs(state.brain.engine, [{ name: 'autopilot-cycle', data: { source_id: state.sourceId, phases: ['extract_facts'] } }], 120_000);
    requireCompleted([job]);
    const phase = (job.result as { report?: { phases?: Array<{ phase: string; status: string; details?: Record<string, unknown> }> } }).report?.phases?.find(p => p.phase === 'extract_facts');
    expect(phase).toBeDefined();
    expect(phase!.status).not.toBe('fail');
  },

  async extract_conversation_facts(state) {
    await gmailSweep(state);
    const [job] = await runJobs(state.brain.engine, [{ name: 'extract-conversation-facts', data: { sourceId: state.sourceId } }]);
    requireCompleted([job]);
  },

  async facts_absorb(state) {
    await gmailSweep(state);
    const { engine } = state.brain;
    const slug = 'notes/plan-preferences';
    await submitPageMutation(state.ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
      content: '---\ntitle: Plan preferences\ntype: note\n---\n[[people/alice-example]] reviews the quarterly plan on Mondays and wants the finance appendix attached to the first draft.\n' } });
    // The put_page publication's facts-backstop effect enqueues facts-absorb
    // with its write authority (persistence_request_id), as in production.
    let jobs: Array<{ id: number }> = [];
    for (let i = 0; i < 200 && jobs.length === 0; i++) {
      jobs = await engine.executeRaw("SELECT id FROM minion_jobs WHERE name='facts-absorb' AND data->>'sourceId'=$1 AND data->>'slug'=$2", [state.sourceId, slug]);
      if (!jobs.length) await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (!jobs.length) throw new Error('fixture: the put_page publication enqueued no facts-absorb job');
    const [job] = await drainQueue(engine, jobs.map(j => j.id));
    requireCompleted([job]);
    const facts = await activeFacts(state);
    expect(facts.map(f => f.fact)).toContain('Alice Example reviews the quarterly plan on Mondays.');
    const written = (await changesSince(state)).filter(c => c.tbl === 'facts');
    expect(written.length).toBeGreaterThan(0);
  },

  async atom_drain_opted_out(state) {
    await gmailSweep(state);
    const { engine } = state.brain;
    // Opted out, connector email/meeting pages are outside discovery and the backlog (#5856).
    await engine.setConfig(CONNECTOR_ATOMS_SETTING.key, CONNECTOR_ATOMS_SETTING.off);
    try {
      expect(await countExtractAtomsBacklog(engine, state.sourceId)).toBe(0);
      const [job] = await runJobs(engine, [{ name: 'extract-atoms-drain', data: { sourceId: state.sourceId, window: 60 } }]);
      if (job.status !== 'completed') throw new Error(`extract-atoms-drain ended ${job.status} after ${job.attempts_started} attempt(s): ${job.error_text ?? ''}`);
      expect(job.attempts_started).toBe(1);
      const atoms = await engine.executeRaw("SELECT 1 FROM pages WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL", [state.sourceId]);
      expect(atoms).toHaveLength(0);
    } finally { await engine.executeRaw('DELETE FROM config WHERE key=$1', [CONNECTOR_ATOMS_SETTING.key]); }
  },

  async atom_drain_default_on(state) {
    await gmailSweep(state);
    const { engine } = state.brain;
    // No setting: connector email/meeting pages are extracted by default (#5856).
    await engine.executeRaw('DELETE FROM config WHERE key=$1', [CONNECTOR_ATOMS_SETTING.key]);
    {
      expect(await countExtractAtomsBacklog(engine, state.sourceId)).toBeGreaterThan(0);
      const [job] = await runJobs(engine, [{ name: 'extract-atoms-drain', data: { sourceId: state.sourceId, window: 60 } }]);
      if (job.status !== 'completed') throw new Error(`extract-atoms-drain ended ${job.status} after ${job.attempts_started} attempt(s): ${job.error_text ?? ''}`);
      expect(job.attempts_started).toBe(1);
      const atoms = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL", [state.sourceId]);
      expect(atoms.length).toBeGreaterThan(0);
      const atomChanges = (await changesSince(state)).filter(c => c.tbl === 'pages' && atoms.some(a => a.slug === c.row_key));
      expect(atomChanges.length).toBeGreaterThan(0);
      expect(atomChanges.every(c => c.request_kind !== null)).toBe(true);
    }
  },

  async atom_dispatch(state) {
    await gmailSweep(state);
    const { engine } = state.brain;
    const { dispatchAutopilotTick } = await import('../../src/commands/autopilot-dispatch.ts');
    await submitPageMutation(state.ctx, { operation: 'put_page', params: { slug: 'emails/2026/10/second-thread', request_id: randomUUID(),
      content: `---\ntitle: Second thread\ntype: email\nthread_id: second\n---\n${EMAIL_BODY.replaceAll('quarterly plan', 'hiring plan')}\n` } });
    await disposePersistenceConsumer(engine);
    const tick = async () => {
      await dispatchAutopilotTick(engine, { lastFullCycleAt: Date.now() } as never, { repoPath: '', baseInterval: 300, jsonMode: true });
      await engine.executeRaw("UPDATE minion_jobs SET status='cancelled' WHERE id > $1 AND status IN ('waiting','delayed') AND name <> 'extract-atoms-drain'", [state.detector.jobsFrom]);
      return engine.executeRaw<{ id: number }>("SELECT id FROM minion_jobs WHERE name='extract-atoms-drain' AND data->>'sourceId'=$1 AND id > $2", [state.sourceId, state.detector.jobsFrom]);
    };
    await engine.setConfig('autopilot.auto_drain.threshold', '1');
    await engine.setConfig(CONNECTOR_ATOMS_SETTING.key, CONNECTOR_ATOMS_SETTING.off);
    try {
      expect(await countExtractAtomsBacklog(engine, state.sourceId)).toBe(0);
      const off = await tick();
      // PGLite: the auto-drain dispatch is Postgres-only, so nothing is submitted.
      if (engine.kind === 'pglite') { expect(off).toHaveLength(0); return; }
      if (off.length) {
        await engine.executeRaw("UPDATE minion_jobs SET status='cancelled' WHERE id = ANY($1::int[]) AND status IN ('waiting','delayed')", [off.map(j => j.id)]);
        throw new Error('auto-drain submitted extract-atoms-drain for the connector source with connector atoms opted out');
      }
      await engine.executeRaw('DELETE FROM config WHERE key=$1', [CONNECTOR_ATOMS_SETTING.key]);
      expect(await countExtractAtomsBacklog(engine, state.sourceId)).toBeGreaterThan(1);
      const on = await tick();
      expect(on).toHaveLength(1);
      const [job] = await drainQueue(engine, on.map(j => j.id));
      requireCompleted([job]);
      expect(job.attempts_started).toBe(1);
    } finally {
      await engine.setConfig('autopilot.auto_drain.threshold', '25');
      await engine.executeRaw('DELETE FROM config WHERE key=$1', [CONNECTOR_ATOMS_SETTING.key]);
    }
  },

  async embed_backfill(state) {
    await gmailSweep(state);
    const { engine } = state.brain;
    if (engine.kind === 'pglite') {
      // PGLite has no persistent worker surface: the queue refuses the job up
      // front and names the inline command, which this lane then runs.
      const refused = await runJobs(engine, [{ name: 'embed-backfill', data: { sourceId: state.sourceId } }]).then(() => null, (e: Error) => e.message);
      expect(refused).toContain(`gbrain embed --stale --source ${state.sourceId}`);
      await runEmbed(engine, ['--stale', '--source', state.sourceId]);
    } else {
      requireCompleted(await runJobs(engine, [{ name: 'embed-backfill', data: { sourceId: state.sourceId } }]));
    }
    const [row] = await engine.executeRaw<{ total: number; embedded: number }>(
      `SELECT count(*)::int AS total, count(c.embedding)::int AS embedded FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1`, [state.sourceId]);
    expect(row.total).toBeGreaterThan(0);
    expect(row.embedded).toBe(row.total);
  },

  async synthesize_publish(state) {
    await gmailSweep(state);
    const { engine } = state.brain;
    const slug = 'wiki/personal/reflections/plan-cadence';
    const authority = await maintenancePreflight(engine, state.sourceId);
    if (!authority) throw new Error('fixture: managed maintenance preflight returned null on a managed brain');
    expect(authority.writer.databaseOnlyReason).toBe('connector_database');
    const receipt = await publishMaintenancePage(engine, authority, slug,
      '---\ntitle: Plan cadence\ntype: note\n---\nPlans are reviewed with [[people/alice-example]] on Mondays.\n', { expectedRevision: null });
    expect(receipt).toBeTruthy();
    const page = await engine.readPageSnapshot(slug, { sourceId: state.sourceId });
    expect(page?.page.compiled_truth).toContain('reviewed with');
    const published = (await changesSince(state)).filter(c => c.tbl === 'pages' && c.row_key === slug);
    expect(published.length).toBeGreaterThan(0);
    expect(published.every(c => c.request_kind === 'managed_maintenance_page')).toBe(true);
  },

  async synthesize_publish_busy_writer(state) {
    await gmailSweep(state);
    const { engine } = state.brain;
    const slug = 'wiki/personal/reflections/plan-busy';
    const authority = (await maintenancePreflight(engine, state.sourceId))!;
    // A second session holds the target page key for 6.5 s: longer than the
    // 5 s default write wait, well inside the 30 s maintenance wait (#5854).
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const lockedP = new Promise<void>(resolve => { locked = resolve; });
    const holder = engine.transaction(async tx => {
      await tx.lockPageKeys([{ sourceId: state.sourceId, slug }]);
      locked();
      await Promise.race([held, new Promise(resolve => setTimeout(resolve, 6_500))]);
    });
    await lockedP;
    try {
      const receipt = await publishMaintenancePage(engine, authority, slug,
        '---\ntitle: Plan busy\ntype: note\n---\nPublished while another writer held the page.\n', { expectedRevision: null });
      expect(receipt).toBeTruthy();
    } finally { release(); await holder; }
    const page = await engine.readPageSnapshot(slug, { sourceId: state.sourceId });
    expect(page?.page.compiled_truth).toContain('another writer');
  },

  async extract_timeline_db(state) {
    await gmailSweep(state);
    const { engine } = state.brain;
    const count = async () => (await engine.executeRaw<{ n: number }>(
      'SELECT count(*)::int AS n FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2', [state.sourceId, state.emailSlug]))[0].n;
    // The connector import projected the row; drop it outside the protocol (as
    // the fixture does for source setup) to model a page whose timeline was
    // never projected, which is the work `extract timeline --source db` exists for.
    expect(await count()).toBe(1);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('DELETE FROM timeline_entries WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)', [state.sourceId, state.emailSlug]);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    state.detector = { ...await startDetector(engine), output: state.detector.output };
    expect(await count()).toBe(0);
    const exitBefore = process.exitCode;
    process.exitCode = 0;
    let exit: number | string | undefined;
    try {
      await runExtract(engine, ['timeline', '--source', 'db', '--source-id', state.sourceId]);
    } finally { exit = process.exitCode; process.exitCode = exitBefore; }
    const findings = await detectorFindings(state);
    if (findings.length) throw new Error(`${findings.join('; ')} (exit ${String(exit ?? 0)}, timeline rows ${await count()})`);
    expect(await count()).toBe(1);
    expect(exit ?? 0).toBe(0);
    const rows = (await changesSince(state)).filter(c => c.tbl === 'timeline_entries');
    expect(rows.length).toBe(1);
  },

  async handler_enumeration(state) {
    const names: string[] = [];
    const worker = { register: (name: string) => { names.push(name); } } as unknown as MinionWorker;
    await registerBuiltinHandlers(worker, state.brain.engine, { quiet: true });
    const uncovered = names.filter(name => !(name in HANDLER_COVERAGE));
    expect(uncovered).toEqual([]);
    const stale = Object.keys(HANDLER_COVERAGE).filter(name => !names.includes(name));
    expect(stale).toEqual([]);
    for (const entry of Object.values(HANDLER_COVERAGE)) {
      if ('covered' in entry) expect(contractCases).toContain(entry.covered);
      else expect(entry.exempt.length).toBeGreaterThan(10);
    }
  },
};

const ATOM_CASES: ReadonlySet<ContractCase> = new Set(['atom_drain_opted_out', 'atom_drain_default_on', 'atom_dispatch']);
const FACTS_CASES: ReadonlySet<ContractCase> = new Set(['cycle_extract_facts', 'extract_conversation_facts', 'facts_absorb']);

async function runCase(brain: ContractBrain, id: ContractCase): Promise<void> {
  const { model, dimensions } = brain.embedding;
  configureGateway({ chat_model: CHAT_MODEL, embedding_model: model, embedding_dimensions: dimensions, env: { ANTHROPIC_API_KEY: FAKE_ENV.ANTHROPIC_API_KEY, OPENAI_API_KEY: FAKE_ENV.OPENAI_API_KEY } });
  __setChatTransportForTests(async opts => fakeChat(opts));
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => new Array(dimensions).fill(0.01)), usage: { tokens: values.length } })) as never);
  const output: string[] = [];
  const firstJob = await maxId(brain.engine, 'minion_jobs');
  if (FACTS_CASES.has(id)) await brain.engine.setConfig('facts.extraction_enabled', 'true');
  await capture(output, async () => {
    const state = await connectorSource(brain);
    state.detector.output = output;
    try {
      const failure = await cases[id](state).then(() => null, (e: unknown) => e instanceof Error ? e : new Error(String(e)));
      const findings = await detectorFindings(state);
      if (failure) {
        if (findings.length) failure.message += ` [detector: ${findings.join('; ')}]`;
        throw failure;
      }
      if (findings.length) throw new Error(findings.join('; '));
    } finally {
      // Jobs this case left queued (backoff retries, follow-ups) never leak into the next case's worker.
      await brain.engine.executeRaw("UPDATE minion_jobs SET status='cancelled' WHERE id > $1 AND status IN ('waiting','delayed','paused','waiting-children')", [firstJob]);
      await brain.engine.setConfig('facts.extraction_enabled', 'false');
      await disposePersistenceConsumer(brain.engine);
    }
  }).catch((error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    (failure as Error & { output?: string }).output = output.join('').split('\n').slice(-60).join('\n');
    throw failure;
  });
}

/** Runs one case and applies its expected-failure entry, if any. */
export async function exerciseConnectorJobContract(brain: ContractBrain, id: ContractCase): Promise<void> {
  await withEnv({ ...brain.env, GBRAIN_SCHEMA_PACK: ATOM_CASES.has(id) ? 'gbrain-base-v2' : undefined }, async () => {
    const listed = EXPECTED_FAILURES[id];
    const expected = listed && (!listed.engines || listed.engines.includes(brain.engine.kind)) ? listed : undefined;
    const error = await runCase(brain, id).then(() => null, (e: unknown) => e instanceof Error ? e : new Error(String(e)));
    if (error) debug(`${id} failure`, `${error.message}\n${(error as Error & { output?: string }).output ?? ''}`);
    if (!expected) { if (error) throw error; return; }
    if (!error) throw new Error(`flip me: ${id} now passes; remove EXPECTED_FAILURES.${id} (${expected.issue})`);
    if (!expected.signature.test(error.message)) {
      throw new Error(`${id} (${expected.issue}) failed with an unexpected signature: ${error.message}`);
    }
  });
}
