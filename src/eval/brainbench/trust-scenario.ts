/**
 * BrainBench memory-trust scenario runner (#5575: trust, state-resolution,
 * poisoning, deletion suites).
 *
 * The four suites never use the coordinator-bypassing seeder: every write goes
 * through the channel a real user or agent would use, on a persistence-enabled
 * in-memory PGLite brain, so the tier stamp, the write gate, guarded
 * supersession and purge run exactly as shipped.
 *
 *   owner         files in the fixture's own git-backed source, imported by the
 *                 managed sync (operator_curated); owner actions (confirm,
 *                 purge) run as the local CLI on a terminal where the owner
 *                 types the confirmation token (the CEO-14 `isInteractive`
 *                 test seam: a probe that reports a TTY and an input stream
 *                 that answers the prompt).
 *   local_agent   operations as the local CLI without a terminal.
 *   remote_agent  operations as an MCP connection holding read+write scopes on
 *                 the fixture's source (the shape serve-http hands handlers).
 *   connector     the GitHub connector (runGitHubSync over a synthetic issue feed) in
 *                 the fixture's own connector source: an attacker-controllable issue
 *                 body imported through the journaled connector mutation
 *                 (external_untrusted, gated). Webhook captures (ingest_capture)
 *                 are a legacy job on managed brains, so the connector path is the
 *                 managed one.
 *   raw           a direct `UPDATE ... SET trust_tier` without the promotion
 *                 setting (the database backstop for self-promotion).
 *
 * One brain serves every trust fixture; each fixture gets its own source,
 * repository and connection, so fixtures cannot see each other's rows and no
 * table reset is needed. Hermetic: no embedding provider, no model calls.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { configureGateway, resetGateway } from '../../core/ai/gateway.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { parseGitHubSourceConfig, runGitHubSync } from '../../core/github-source.ts';
import { OperationError, type OperationContext } from '../../core/ops/contract.ts';
import { operationsByName } from '../../core/operations.ts';
import { registerLocalWriter, readLocalWriter } from '../../core/persistence/identity.ts';
import { claimWorktree } from '../../core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../core/persistence/service.ts';
import { performManagedSync } from '../../core/persistence/sync-run.ts';
import { PGLiteEngine } from '../../core/pglite-engine.ts';
import { mintLegacyToken } from '../../core/token-mint.ts';
import { __setConfirmationIoForTests } from '../../core/trust/confirm.ts';
import { storedTrustTier, type TrustTier } from '../../core/trust/tier.ts';
import type { BrainBenchFixture, TrustStep } from './types.ts';

/** The tables a scenario row can live in. */
export type TrustRowTable = 'facts' | 'pages';
export interface TrustRowRef { table: TrustRowTable; id: number }

export interface StepOutcome {
  ok: boolean;
  /** Canonical error code when the step was refused or failed. */
  code?: string;
  message?: string;
  result?: Record<string, unknown>;
}

export interface StepRecord {
  step: TrustStep;
  outcome: StepOutcome;
  /** The page the step wrote (write_file, put_page, capture), and its source. */
  pageSlug?: string;
  pageSource?: string;
  /** The fact the step wrote (remember). */
  factId?: number;
  /** The row a targeted step acted on, and its tier just before and just after. */
  target?: TrustRowRef;
  targetTierBefore?: TrustTier | null;
  targetTierAfter?: TrustTier | null;
  /** owner purge: tables holding the claim just before the purge (independent probe). */
  prePurgeHits?: Record<string, number>;
  /** owner purge: the claim purged. */
  purgedClaim?: string;
  /** owner purge: tables, and canonical files, still holding the claim right after the purge. */
  postPurgeHits?: Record<string, number>;
  postPurgeFiles?: string[];
  /** The step's post-commit effects had not finished within EFFECT_SETTLE_MS. */
  unsettled?: boolean;
}

interface SyntheticIssue {
  number: number; title: string; state: 'open'; body: string; created_at: string; updated_at: string;
  labels: never[]; assignees: never[]; user: { login: string }; html_url: string;
}

export interface ConnectorSource { id: string; dir: string; repo: string; config: Record<string, unknown>; issues: SyntheticIssue[] }

export interface TrustFixtureRun {
  fixtureId: string;
  /** The owner's git-backed source: owner files, agent writes. */
  sourceId: string;
  /** Every source the fixture wrote into (the owner source, plus its connector source when it has one). */
  sourceIds: string[];
  connector?: ConnectorSource;
  repoDir: string;
  engine: PGLiteEngine;
  remote: OperationContext;
  local: OperationContext;
  steps: Map<string, StepRecord>;
}

export interface TrustBrain {
  engine: PGLiteEngine;
  root: string;
  close(): Promise<void>;
}

const quiet = { info() {}, warn() {}, error() {} };
/** The connector reads its token from this variable; a synthetic value, set only for the trust phase. */
const CONNECTOR_TOKEN_ENV = 'BRAINBENCH_CONNECTOR_TOKEN';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'bench-owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid',
  GIT_COMMITTER_NAME: 'bench-owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid',
};

/** Sets GBRAIN_HOME for the scenario phase (the local writer registration lives there); restores on close. */
/**
 * `protections`: true turns on the owner's opt-in protections (write_gate.external_mode=quarantine,
 * trust.agent_activation=suppress) that the protection cells probe; false keeps the shipped defaults
 * (flag / allow since the preregistered paid eval, gbrain-evals
 * docs/benchmarks/2026-10-08-memory-trust-results-paid.md).
 */
export async function createTrustBrain(opts: { protections: boolean }): Promise<TrustBrain> {
  const root = mkdtempSync(join(tmpdir(), 'brainbench-trust-'));
  const priorHome = process.env.GBRAIN_HOME;
  const priorToken = process.env[CONNECTOR_TOKEN_ENV];
  process.env.GBRAIN_HOME = root;
  process.env[CONNECTOR_TOKEN_ENV] = 'synthetic-local-fixture';
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} } as never);
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await registerLocalWriter(engine, 'cli');
  if (opts.protections) {
    await engine.setConfig('write_gate.external_mode', 'quarantine');
    await engine.setConfig('trust.agent_activation', 'suppress');
  }
  return {
    engine, root,
    async close() {
      __setConfirmationIoForTests(null);
      try { await disposePersistenceConsumer(engine); } catch { /* best effort */ }
      await engine.disconnect();
      resetGateway();
      if (priorHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = priorHome;
      if (priorToken === undefined) delete process.env[CONNECTOR_TOKEN_ENV]; else process.env[CONNECTOR_TOKEN_ENV] = priorToken;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The source id a trust fixture writes into. */
export function trustSourceId(fixtureId: string): string {
  return `bb-${fixtureId}`.slice(0, 60);
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...GIT_ENV } });
}

function errorOutcome(err: unknown): StepOutcome {
  if (err instanceof OperationError) return { ok: false, code: err.canonical ?? err.code, message: err.message };
  const e = err as { code?: unknown; message?: unknown };
  const msg = String(e?.message ?? err);
  const prefixed = /^([a-z_]+):/.exec(msg)?.[1];
  return { ok: false, code: typeof e?.code === 'string' ? e.code : prefixed ?? 'error', message: msg.slice(0, 500) };
}

async function op(ctx: OperationContext, name: string, params: Record<string, unknown>): Promise<StepOutcome> {
  const def = operationsByName[name];
  if (!def) return { ok: false, code: 'unsupported', message: `operation ${name} is not registered on this build` };
  try {
    const result = await def.handler(ctx, { request_id: randomUUID(), ...params }) as Record<string, unknown>;
    return { ok: true, result };
  } catch (err) {
    return errorOutcome(err);
  }
}

/** The owner at an interactive terminal: answers the typed-token prompt with the token it names. */
function withOwnerTerminal<T>(fn: () => Promise<T>): Promise<T> {
  const input = new PassThrough();
  const output = new Writable({
    write(chunk, _enc, cb) {
      const token = /Type (\S+) to confirm/.exec(String(chunk))?.[1];
      if (token) setImmediate(() => input.write(`${token}\n`));
      cb();
    },
  });
  __setConfirmationIoForTests({ probe: { env: { GBRAIN_INTERACTIVE: '1' }, stdinIsTTY: true, stdoutIsTTY: true }, input, output, timeoutMs: 5_000 });
  return fn().finally(() => { __setConfirmationIoForTests(null); input.end(); });
}

/** A process with no terminal (an agent or a pipe): any typed-token prompt sees a non-interactive caller. */
function withoutTerminal<T>(fn: () => Promise<T>): Promise<T> {
  __setConfirmationIoForTests({ probe: { env: { GBRAIN_NON_INTERACTIVE: '1' }, stdinIsTTY: false, stdoutIsTTY: false } });
  return fn().finally(() => __setConfirmationIoForTests(null));
}

export async function rowTier(engine: BrainEngine, ref: TrustRowRef | undefined): Promise<TrustTier | null> {
  if (!ref) return null;
  const [row] = await engine.executeRaw<{ trust_tier: string }>(`SELECT trust_tier FROM ${ref.table} WHERE id = $1`, [ref.id]);
  return row ? storedTrustTier(row.trust_tier) : null;
}

export async function pageId(engine: BrainEngine, sourceId: string, slug: string): Promise<number | null> {
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
  return row ? Number(row.id) : null;
}

export async function factIdByClaim(engine: BrainEngine, sourceId: string, claim: string): Promise<number | null> {
  const [row] = await engine.executeRaw<{ id: number }>(
    'SELECT id FROM facts WHERE source_id = $1 AND fact = $2 ORDER BY id DESC LIMIT 1', [sourceId, claim]);
  return row ? Number(row.id) : null;
}

/** The row a step's outcome names: its fact, a claim within its page, or its page. */
export async function resolveStepRow(run: Pick<TrustFixtureRun, 'engine' | 'sourceId' | 'steps'>, stepId: string, claim?: string): Promise<TrustRowRef | undefined> {
  const rec = run.steps.get(stepId);
  if (!rec) return undefined;
  if (claim) {
    const id = await factIdByClaim(run.engine, run.sourceId, claim);
    return id ? { table: 'facts', id } : undefined;
  }
  if (rec.factId) return { table: 'facts', id: rec.factId };
  if (rec.target && !rec.pageSlug) return rec.target;
  if (rec.pageSlug) {
    const id = await pageId(run.engine, rec.pageSource ?? run.sourceId, rec.pageSlug);
    return id ? { table: 'pages', id } : undefined;
  }
  return undefined;
}

async function trustRef(engine: BrainEngine, ref: TrustRowRef): Promise<string> {
  if (ref.table === 'facts') return `f${ref.id}`;
  const [row] = await engine.executeRaw<{ slug: string; source_id: string }>('SELECT slug, source_id FROM pages WHERE id = $1', [ref.id]);
  return `p:${row?.source_id ?? ''}/${row?.slug ?? ''}`;
}

// ---------------------------------------------------------------------------
// Independent store probe (deletion suite): every text-bearing column of every
// table, never the purge's own discovery code.
// ---------------------------------------------------------------------------

interface ProbeColumn { table: string; column: string }
let probeColumnsCache: ProbeColumn[] | null = null;

async function probeColumns(engine: BrainEngine): Promise<ProbeColumn[]> {
  if (probeColumnsCache) return probeColumnsCache;
  const rows = await engine.executeRaw<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND (c.data_type IN ('text', 'character varying', 'json', 'jsonb', 'ARRAY', 'USER-DEFINED') )
      ORDER BY c.table_name, c.column_name`);
  probeColumnsCache = rows.map(r => ({ table: r.table_name, column: r.column_name }));
  return probeColumnsCache;
}

/** Rows per table whose text-bearing columns contain `needle` (case-insensitive), across the whole brain. */
export async function probeStores(engine: BrainEngine, needle: string): Promise<Record<string, number>> {
  const byTable = new Map<string, string[]>();
  for (const c of await probeColumns(engine)) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c.column]);
  const hits: Record<string, number> = {};
  for (const [table, columns] of byTable) {
    const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const where = columns.map(col => `strpos(lower(${ident(col)}::text), lower($1)) > 0`).join(' OR ');
    try {
      const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${ident(table)} WHERE ${where}`, [needle]);
      if (Number(row?.n ?? 0) > 0) hits[table] = Number(row!.n);
    } catch {
      /* a column type that does not cast to text (e.g. a vector) carries no claim text */
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Fixture setup and step execution
// ---------------------------------------------------------------------------

async function setupFixtureSource(brain: TrustBrain, fixture: BrainBenchFixture): Promise<TrustFixtureRun> {
  const engine = brain.engine;
  const sourceId = trustSourceId(fixture.fixture_id);
  const repoDir = join(brain.root, 'repos', sourceId);
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, 'init', '-q');
  writeFileSync(join(repoDir, '.gitignore'), '.gbrain-tmp/\n');
  git(repoDir, 'add', '-A');
  git(repoDir, 'commit', '-qm', 'bench: empty owner source');

  const sourceIds = [sourceId];
  let connector: ConnectorSource | undefined;
  if ((fixture.trust_steps ?? []).some(st => st.actor === 'connector')) {
    const id = `${sourceId.slice(0, 56)}-gh`;
    const dir = join(brain.root, 'connectors', id);
    mkdirSync(dir, { recursive: true });
    const repo = `acme-example/${fixture.fixture_id}`;
    connector = { id, dir, repo, issues: [], config: { kind: 'github', gh_scope: 'repos', gh_repos: repo, gh_token_env: CONNECTOR_TOKEN_ENV } };
    sourceIds.push(id);
  }

  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled = false WHERE singleton = 1');
  let minted: { id: string };
  try {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, '{}'::jsonb)`, [sourceId, repoDir]);
    await claimWorktree(engine, sourceId, repoDir);
    if (connector) {
      await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)',
        [connector.id, connector.dir, JSON.stringify(connector.config)]);
    }
    minted = await mintLegacyToken(engine, {
      name: `bench-agent-${sourceId}`, scopes: ['read', 'write'], sourceGrant: sourceIds, takesHolders: ['world'],
    });
  } finally {
    await engine.executeRaw('UPDATE persistence_brain SET enabled = true WHERE singleton = 1');
  }
  await readLocalWriter(engine, 'cli');
  const base = { engine, config: { engine: 'pglite', embedding_disabled: true }, sourceId, dryRun: false, logger: quiet };
  const remote = {
    ...base, remote: true, transport: 'http', takesHoldersAllowList: ['world'],
    auth: {
      token: '', clientId: minted.id, principal: { kind: 'legacy_token', id: minted.id },
      sourceId, allowedSources: sourceIds, scopes: ['read', 'write'],
    },
  } as unknown as OperationContext;
  const local = { ...base, remote: false } as unknown as OperationContext;
  return { fixtureId: fixture.fixture_id, sourceId, sourceIds, connector, repoDir, engine, remote, local, steps: new Map() };
}

async function ownerSync(run: TrustFixtureRun): Promise<StepOutcome> {
  try {
    const result = await performManagedSync(run.engine, { sourceId: run.sourceId, noPull: true } as never) as unknown as Record<string, unknown>;
    return { ok: true, result };
  } catch (err) {
    return errorOutcome(err);
  }
}

function commitAll(run: TrustFixtureRun, message: string): void {
  git(run.repoDir, 'add', '-A');
  try { git(run.repoDir, 'commit', '-qm', message); } catch { /* nothing to commit */ }
}

async function executeStep(run: TrustFixtureRun, step: TrustStep): Promise<StepRecord> {
  const rec: StepRecord = { step, outcome: { ok: false, code: 'not_run' } };
  const targetRec = step.target ? run.steps.get(step.target) : undefined;
  if (step.target) {
    rec.target = await resolveStepRow(run, step.target, step.target_claim);
    rec.targetTierBefore = await rowTier(run.engine, rec.target);
  }
  const ctx = step.actor === 'remote_agent' ? run.remote : run.local;

  switch (step.op) {
    case 'write_file': {
      const path = join(run.repoDir, `${step.slug}.md`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, step.content!);
      commitAll(run, `owner: ${step.slug}`);
      rec.outcome = await ownerSync(run);
      rec.pageSlug = step.slug;
      break;
    }
    case 'sync':
      commitAll(run, 'owner: sync');
      rec.outcome = await ownerSync(run);
      break;
    case 'put_page':
      rec.outcome = await op(ctx, 'put_page', {
        slug: step.slug, content: step.content, force: true,
        ...(step.content_origin ? { content_origin: step.content_origin } : {}),
      });
      rec.pageSlug = step.slug;
      break;
    case 'capture':
      if (step.actor === 'connector') {
        const imported = await connectorImport(run, step);
        rec.outcome = imported.outcome;
        rec.pageSlug = imported.slug;
        rec.pageSource = run.connector?.id;
        break;
      } else {
        rec.outcome = await op(ctx, 'capture', {
          slug: step.slug, content: step.content,
          ...(step.content_origin ? { content_origin: step.content_origin } : {}),
        });
      }
      rec.pageSlug = step.slug;
      break;
    case 'remember': {
      const replaces = rec.target?.table === 'facts' ? String(rec.target.id) : undefined;
      rec.outcome = await op(ctx, 'remember', {
        fact: step.fact, provenance: 'bench', ...(step.entity ? { entity: step.entity } : {}),
        ...(step.kind ? { kind: step.kind } : {}), ...(replaces ? { replaces } : {}),
        ...(step.content_origin ? { content_origin: step.content_origin } : {}),
      });
      const id = Number(rec.outcome.result?.id);
      if (rec.outcome.ok && Number.isFinite(id) && id > 0) rec.factId = id;
      break;
    }
    case 'forget':
      rec.outcome = rec.target?.table === 'facts'
        ? await op(ctx, 'forget', { id: String(rec.target.id), reason: 'bench' })
        : { ok: false, code: 'bench_target_missing' };
      break;
    case 'confirm': {
      if (!rec.target) { rec.outcome = { ok: false, code: 'bench_target_missing' }; break; }
      const ref = await trustRef(run.engine, rec.target);
      const call = () => op(ctx, 'confirm_memory', { ref });
      rec.outcome = step.actor === 'owner' ? await withOwnerTerminal(call) : await withoutTerminal(call);
      break;
    }
    case 'purge': {
      if (rec.target?.table !== 'facts') { rec.outcome = { ok: false, code: 'bench_target_missing' }; break; }
      const [fact] = await run.engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE id = $1', [rec.target.id]);
      rec.purgedClaim = fact?.fact;
      if (rec.purgedClaim) rec.prePurgeHits = await probeStores(run.engine, rec.purgedClaim);
      const id = rec.target.id;
      if (step.actor === 'owner') {
        rec.outcome = await withOwnerTerminal(async () => {
          const dry = await op(ctx, 'purge_fact', { id, dry_run: true });
          if (!dry.ok) return dry;
          return op(ctx, 'purge_fact', { id, confirm: dry.result?.confirm_token, expected_revision: dry.result?.expected_revision });
        });
      } else {
        rec.outcome = await op(ctx, 'purge_fact', { id, dry_run: true });
      }
      break;
    }
    case 'raise_tier': {
      if (!rec.target) { rec.outcome = { ok: false, code: 'bench_target_missing' }; break; }
      try {
        await run.engine.executeRaw(`UPDATE ${rec.target.table} SET trust_tier = 'user_confirmed' WHERE id = $1`, [rec.target.id]);
        rec.outcome = { ok: true };
      } catch (err) {
        rec.outcome = errorOutcome(err);
      }
      break;
    }
  }
  if (targetRec && rec.target) rec.targetTierAfter = await rowTier(run.engine, rec.target);
  return rec;
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/**
 * One new GitHub issue (title = the content's first heading, body = the rest) and
 * a connector sync over the synthetic feed. Returns the imported page's slug.
 */
async function connectorImport(run: TrustFixtureRun, step: TrustStep): Promise<{ outcome: StepOutcome; slug?: string }> {
  const c = run.connector!;
  const lines = step.content!.split('\n');
  const heading = lines.findIndex(l => l.startsWith('# '));
  const title = heading >= 0 ? lines[heading].slice(2).trim() : step.step_id;
  const body = lines.filter((_, i) => i !== heading).join('\n').trim();
  const number = c.issues.length + 1;
  const day = String(number).padStart(2, '0');
  c.issues.push({
    number, title, state: 'open', body, created_at: '2026-01-01T00:00:00Z', updated_at: `2026-01-${day}T00:00:00Z`,
    labels: [], assignees: [], user: { login: 'example-user' }, html_url: `https://github.com/${c.repo}/issues/${number}`,
  });
  const fetcher = async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/issues')) return json(c.issues);
    if (path.endsWith('/pulls') || path.endsWith('/comments')) return json([]);
    const m = /\/issues\/(\d+)$/.exec(path);
    if (m) return json(c.issues.find(i => i.number === Number(m[1])));
    if (path === `/repos/${c.repo}`) return json({ full_name: c.repo, private: true, default_branch: 'main' });
    throw new Error(`unexpected connector route ${url}`);
  };
  try {
    const result = await runGitHubSync(run.engine, c.id, parseGitHubSourceConfig(c.config as never, c.dir),
      { noEmbed: true, noExtract: true, noSchemaPack: true } as never, fetcher as never) as unknown as Record<string, unknown>;
    return { outcome: { ok: true, result }, slug: `gh/${c.repo}/${number}` };
  } catch (err) {
    return { outcome: errorOutcome(err) };
  }
}

/** Bound on waiting for a step's post-commit effects (git commit, mirror rewrite, links). */
export const EFFECT_SETTLE_MS = 15_000;

/**
 * Post-commit effects (write-through commits, the purge mirror rewrite of the
 * canonical file) run after the operation returns. A user's next action
 * happens after they land, so every step waits for the fixture's queued and
 * running effects to finish (bounded) before the next step or any scoring.
 */
async function settleEffects(run: TrustFixtureRun): Promise<boolean> {
  const deadline = performance.now() + EFFECT_SETTLE_MS;
  for (;;) {
    const [row] = await run.engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
        WHERE r.source_id = ANY($1::text[]) AND e.state IN ('queued', 'running')`, [run.sourceIds]);
    if (Number(row?.n ?? 0) === 0) return true;
    if (performance.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export interface RunTrustStepsOpts {
  /** Runs before each step (mutation probes break one protection here). */
  beforeStep?: (run: TrustFixtureRun, step: TrustStep) => Promise<void>;
}

/** Runs every step of one trust fixture on its own source. Steps never throw; refusals are recorded. */
export async function runTrustSteps(brain: TrustBrain, fixture: BrainBenchFixture, opts: RunTrustStepsOpts = {}): Promise<TrustFixtureRun> {
  const run = await setupFixtureSource(brain, fixture);
  for (const step of fixture.trust_steps ?? []) {
    await opts.beforeStep?.(run, step);
    const rec = await executeStep(run, step);
    if (!await settleEffects(run)) rec.unsettled = true;
    if (rec.purgedClaim) await recordPostPurge(run, rec);
    run.steps.set(step.step_id, rec);
  }
  return run;
}

/** Right after a purge's effects settle: what still holds the claim (the deletion suite's residual). */
async function recordPostPurge(run: TrustFixtureRun, rec: StepRecord): Promise<void> {
  rec.postPurgeHits = await probeStores(run.engine, rec.purgedClaim!);
  const needle = rec.purgedClaim!.toLowerCase();
  const slugs = new Set([...run.steps.values()].map(r => r.pageSlug).filter((x): x is string => !!x));
  rec.postPurgeFiles = [...slugs].filter(slug => repoFileText(run, slug)?.toLowerCase().includes(needle));
}

/** The canonical markdown file of a page in the fixture repository (deletion residuals). */
export function repoFileText(run: Pick<TrustFixtureRun, 'repoDir'>, slug: string): string | null {
  const path = join(run.repoDir, `${slug}.md`);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
