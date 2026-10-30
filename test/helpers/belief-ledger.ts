/**
 * Shared harness for the belief ledger probes (docs/designs/BELIEF_LEDGER.md
 * section 11): a brain whose source has active coverage, page writes through
 * the shared write path, and readers for the events it appended. Runs on
 * PGLite, and on Postgres when DATABASE_URL names a test database
 * (`beliefEngineCase`), so every probe asserts the same values on both.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { enableBeliefLedger } from '../../src/core/belief/coverage.ts';
import { managedBrain } from './managed-brain.ts';
import { isolatedPersistencePostgres } from './persistence-postgres.ts';
import { withEnv } from './with-env.ts';
import { requirePostgresTestDatabase, type TestBackend } from './test-backends.ts';

export interface BeliefEvent {
  id: number; source_id: string; source_incarnation: string; page_lifetime: string | null; slug: string; subject_kind: string; subject_key: string;
  event_type: string; origin: string; trust_tier: string; writer_tier: string | null; tier_basis: string; visibility: string; publication_id: string;
  ord: number; recorded_at: string; value: Record<string, unknown> | null; value_hash: string | null; prior_hash: string | null; state_hash: string;
  cause: Record<string, unknown>; claim_fp: string | null; purged: boolean; redacted_fields: string[] | null; event_key: string;
}

export interface BeliefBrain {
  engine: BrainEngine; ctx: OperationContext; root: string; sourceId: string;
  put(slug: string, content: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>>;
  op(operation: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  enable(): Promise<void>;
  /** Events after `afterId` (default all), in id order. */
  events(afterId?: number): Promise<BeliefEvent[]>;
  lastId(): Promise<number>;
}

/** One engine case per backend; call it as `testBackends().map(beliefEngineCase)` so check:postgres-lanes sees the gated arm. */
export const beliefEngineCase = (name: TestBackend): { name: TestBackend; databaseUrl?: string } =>
  name === 'postgres' ? { name, databaseUrl: requirePostgresTestDatabase() } : { name };

/** A source's events after `afterId`, in id order (for probes that build their own brain). */
export async function readEvents(engine: BrainEngine, sourceId: string, afterId = 0): Promise<BeliefEvent[]> {
  const rows = await engine.executeRaw<BeliefEvent>(`SELECT id, source_id, source_incarnation::text AS source_incarnation, page_lifetime::text AS page_lifetime,
      slug, subject_kind, subject_key, event_type, origin, trust_tier, writer_tier, tier_basis, visibility, publication_id::text AS publication_id, ord,
      recorded_at, value, value_hash, prior_hash, state_hash, cause, claim_fp, purged, redacted_fields, encode(event_key, 'hex') AS event_key
    FROM belief_events WHERE source_id = $1 AND id > $2 ORDER BY id`, [sourceId, afterId]);
  const json = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v;
  return rows.map(r => ({ ...r, id: Number(r.id), ord: Number(r.ord), value: json(r.value) as BeliefEvent['value'], cause: json(r.cause) as BeliefEvent['cause'] }));
}

/** The probe API over an engine the caller opened (the file-backed restore probes reopen theirs). */
export function brainApi(engine: BrainEngine, ctx: OperationContext, root: string, sourceId: string): BeliefBrain {
  const op = async (operation: string, params: Record<string, unknown>) =>
    await submitPageMutation(ctx as never, { operation: operation as never, params: { request_id: randomUUID(), ...params } as never }) as Record<string, unknown>;
  return {
    engine, ctx, root, sourceId, op,
    put: (slug, content, extra = {}) => op('put_page', { slug, content, force: true, ...extra }),
    enable: async () => { await enableBeliefLedger(engine, sourceId); },
    events: afterId => readEvents(engine, sourceId, afterId),
    lastId: async () => Number((await engine.executeRaw<{ id: number | null }>('SELECT max(id) AS id FROM belief_events WHERE source_id = $1', [sourceId]))[0]?.id ?? 0),
  };
}

/**
 * A brain with one source. `managed: true` runs the activated managed brain
 * (certified coverage); otherwise an unmanaged brain whose source owns a
 * claimed worktree. Coverage is enabled unless `enable: false`.
 */
export async function beliefBrain(run: (brain: BeliefBrain) => Promise<void>,
  opts: { managed?: boolean; databaseUrl?: string; enable?: boolean; setup?: (brain: BeliefBrain) => Promise<void> } = {}): Promise<void> {
  if (opts.managed) {
    await managedBrain(async ({ engine, ctx, root }) => {
      const brain = brainApi(engine, ctx, root, 'default');
      await opts.setup?.(brain);
      if (opts.enable !== false) await brain.enable();
      await run(brain);
    }, { databaseUrl: opts.databaseUrl });
    return;
  }
  const home = mkdtempSync(join(tmpdir(), 'gbrain-belief-'));
  let engine: BrainEngine | undefined;
  let close: (() => Promise<void>) | undefined;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      if (opts.databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(opts.databaseUrl));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
      const root = join(home, 'brain'); mkdirSync(root);
      const sourceId = `belief-${randomUUID().slice(0, 8)}`;
      await engine!.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await claimWorktree(engine!, sourceId, root);
      const ctx: OperationContext = { engine: engine!, sourceId, remote: false, dryRun: false,
        config: { engine: engine!.kind, embedding_disabled: true } as never, logger: { info() {}, warn() {}, error() {} } as never };
      const brain = brainApi(engine!, ctx, root, sourceId);
      await opts.setup?.(brain);
      if (opts.enable !== false) await brain.enable();
      await run(brain);
    });
  } finally {
    if (engine) { await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); }
    rmSync(home, { recursive: true, force: true });
  }
}

/** A file-configured PGLite brain at `<home>/.gbrain/brain.pglite` (the backup format); `open` connects it for one step, so backups run between steps. */
export interface FileBeliefBrain { home: string; open<T>(fn: (brain: BeliefBrain) => Promise<T>): Promise<T> }

/** Connects the PGLite brain at `databasePath` (a restored one, say) as a probe brain; `close` disconnects it. */
export async function openFileBeliefBrain(databasePath: string, sourceId: string, root: string): Promise<{ brain: BeliefBrain; close: () => Promise<void> }> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  const ctx: OperationContext = { engine, sourceId, remote: false, dryRun: false,
    config: { engine: 'pglite', embedding_disabled: true } as never, logger: { info() {}, warn() {}, error() {} } as never };
  return { brain: brainApi(engine, ctx, root, sourceId), close: async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); } };
}

/** Runs `run` with GBRAIN_HOME at a new file-configured PGLite brain whose source `sourceId` has coverage enabled. */
export async function withFileBeliefBrain(sourceId: string, run: (brain: FileBeliefBrain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-belief-file-'));
  const databasePath = join(home, '.gbrain', 'brain.pglite');
  const root = join(home, 'content');
  mkdirSync(join(home, '.gbrain'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: databasePath }), { mode: 0o600 });
  const open = async <T>(fn: (brain: BeliefBrain) => Promise<T>): Promise<T> => {
    const { brain, close } = await openFileBeliefBrain(databasePath, sourceId, root);
    try { return await fn(brain); } finally { await close(); }
  };
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      mkdirSync(root);
      await open(async brain => {
        await brain.engine.initSchema();
        await brain.engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await claimWorktree(brain.engine, sourceId, root);
        await enableBeliefLedger(brain.engine, sourceId);
      });
      await run({ home, open });
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** A page body with a facts fence, a takes fence, prose and wikilinks. A fence is written when its list is given, so an empty list writes the empty fence that retires the stored rows (GBRA-161 PR 2: an omitted fence holds them). */
export function beliefPage(o: { title?: string; type?: string; prose?: string; facts?: Array<string | { claim: string; context?: string; confidence?: string; visibility?: string }>;
  takes?: Array<string | { claim: string; weight?: string; since?: string; who?: string }>; links?: string[]; frontmatter?: Record<string, string> } = {}): string {
  const fm = { type: o.type ?? 'company', title: o.title ?? 'Acme Example', ...o.frontmatter };
  const facts = (o.facts ?? []).map(f => typeof f === 'string' ? { claim: f } : f);
  const takes = (o.takes ?? []).map(t => typeof t === 'string' ? { claim: t } : t);
  const parts = [`---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---`,
    `${o.prose ?? 'Draft.'}${(o.links ?? []).map(l => ` See [[${l}]].`).join('')}`];
  if (o.facts) parts.push(['<!--- gbrain:facts:begin -->', '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
    '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
    ...facts.map((f, i) => `| ${i + 1} | ${f.claim} | fact | ${f.confidence ?? '1.0'} | ${f.visibility ?? 'world'} | medium | 2026-01-01 |  | remember | ${f.context ?? ''} |`),
    '<!--- gbrain:facts:end -->'].join('\n'));
  if (o.takes) parts.push(['<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |', '|---|-------|------|-----|--------|-------|--------|',
    ...takes.map((t, i) => `| ${i + 1} | ${t.claim} | take | ${t.who ?? 'brain'} | ${t.weight ?? '0.5'} | ${t.since ?? '2026-07'} | notes |`), '<!--- gbrain:takes:end -->'].join('\n'));
  return `${parts.join('\n\n')}\n`;
}

/** Events reduced to what probes assert exactly: type, kind and the subject key's readable parts. */
export const shape = (events: BeliefEvent[]) => events.map(e => `${e.subject_kind}:${e.event_type}`);
