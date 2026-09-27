import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimWorktree, type WorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { admitWrite, type WriteAdmission } from '../../src/core/persistence/journal.ts';
import { publishMutation, type PreparedMutation } from '../../src/core/persistence/coordinator.ts';
import type { Principal, WriteAuthority, WriteRequest } from '../../src/core/persistence/model.ts';
import { assertSafeE2eDatabaseUrl } from '../../test/helpers/db-guard.ts';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { localHostId, persistenceHome } from '../../src/core/persistence/identity.ts';

/** Synthetic fixtures only. The runner supplies a fresh datastore and scratch home. */
export interface HarnessConfig {
  kind: 'pglite' | 'postgres'; root: string; dataDir: string; databaseUrl?: string;
  hostId: string; seed: number; schedules: number; operations: number;
  sourceIds: string[]; principalIds: string[];
  poolSize?: number; seedReadProbe?: boolean;
}
/** Synthetic host switching is confined to the runner's fresh child home. */
export function selectFixtureHost(hostId: string): void {
  const home = process.env.GBRAIN_PERSISTENCE_FIXTURE_HOME;
  assert(home && home === process.env.GBRAIN_HOME, 'Fixture host identity requires the isolated runner home');
  const relativeHome = relative(resolve(home), persistenceHome());
  assert(relativeHome && !relativeHome.startsWith('..') && !relativeHome.startsWith('/'), 'Fixture identity must remain inside its scratch home');
  mkdirSync(persistenceHome(), { recursive: true, mode: 0o700 });
  const path = join(persistenceHome(), 'host.json');
  if (!existsSync(path) || JSON.parse(readFileSync(path, 'utf8')).id !== hostId) {
    const staged = `${path}.${randomUUID()}.fixture`;
    writeFileSync(staged, JSON.stringify({ version: 1, id: hostId }), { mode: 0o600 });
    renameSync(staged, path);
  }
  assert.equal(localHostId(), hostId);
}
export async function openEngine(config: HarnessConfig, initialize = false): Promise<BrainEngine> {
  selectFixtureHost(config.hostId);
  const engine: BrainEngine = config.kind === 'pglite' ? new PGLiteEngine() : new PostgresEngine();
  if (engine instanceof PostgresEngine) {
    assertSafeE2eDatabaseUrl(config.databaseUrl!);
    await engine.connect({ database_url: config.databaseUrl!, poolSize: config.poolSize ?? 4 });
  } else await engine.connect({ database_path: config.dataDir });
  if (initialize) await engine.initSchema();
  else assert.equal((await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1'))[0].enabled,
    true, 'Every stress worker must exercise activated managed persistence');
  return engine;
}
export async function initializeFixtures(engine: BrainEngine, config: HarnessConfig): Promise<void> {
  for (let i = 0; i < config.sourceIds.length; i++) {
    const root = join(config.root, `source-${i}`); mkdirSync(root, { recursive: true });
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [config.sourceIds[i], root]);
    await claimWorktree(engine, config.sourceIds[i], root, config.hostId);
  }
  if (config.seedReadProbe) for (const sourceId of config.sourceIds.slice(0, 2)) {
    await engine.putPage('rls-probe', { type: 'note', title: 'RLS fixture', compiled_truth: sourceId, timeline: '', frontmatter: {} }, { sourceId });
  }
  assert.equal((await activatePersistence(engine, { confirmQuiesced: true })).enabled, true);
  for (const id of config.principalIds) await engine.executeRaw(`INSERT INTO persistence_local_writers
    (id,lane,credential_hash,grant_ceiling) VALUES($1::uuid,'cli',$2,$3::text::jsonb)`,
  [id, `synthetic-${id}`, JSON.stringify({ sourceIds: config.sourceIds, scopes: ['read', 'write'], operations: null, slugPrefixes: null })]);
}
export interface FixtureSource { id: string; incarnation: string; binding: WorktreeBinding; root: string; }
export async function fixtures(engine: BrainEngine, config: HarnessConfig): Promise<FixtureSource[]> {
  const result: FixtureSource[] = [];
  for (let i = 0; i < config.sourceIds.length; i++) {
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [config.sourceIds[i]]);
    const [binding] = await engine.executeRaw<WorktreeBinding>(`SELECT s.*,w.owner_host_id,w.owner_epoch,w.state,
      h.local_path,h.coordination_path FROM persistence_source_bindings s
      JOIN persistence_worktrees w ON w.id=s.worktree_id
      JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=$2::uuid WHERE s.source_id=$1`, [config.sourceIds[i], config.hostId]);
    result.push({ id: config.sourceIds[i], incarnation: source.incarnation, binding, root: join(config.root, `source-${i}`) });
  }
  return result;
}
export function admission(config: HarnessConfig, source: FixtureSource, slug: string, content: string,
  principalIndex = 0, options: Partial<WriteAdmission> = {}): WriteAdmission {
  const principal: Principal = { kind: 'local_cli', id: config.principalIds[principalIndex] };
  const authority: WriteAuthority = { version: 1, principal, remote: false, sourceId: source.id,
    sourceIncarnation: source.incarnation, scopes: ['read', 'write'], operations: null, slugPrefixes: null };
  return { principal, authority, sourceId: source.id, sourceIncarnation: source.incarnation,
    operation: 'put_page', slug, pageId: null, requestId: randomUUID(),
    worktreeId: source.binding.worktree_id, topologyGeneration: source.binding.topology_generation,
    callerIntent: { content }, intent: { content }, ...options };
}
export function prepared(row: WriteRequest, sources: FixtureSource[], observedRevision: string | null = null,
  file = false): PreparedMutation {
  const source = sources.find(s => s.id === row.source_id)!;
  const content = String(row.intent!.content);
  return { observedRevision,
    ...(file ? { file: { root: source.root, path: join(source.root, `${row.slug}.md`), content } } : {}),
    apply: async tx => {
      await tx.putPage(row.slug, { type: 'note', title: row.slug, compiled_truth: content,
        timeline: `timeline:${content}`, frontmatter: {} }, { sourceId: source.id });
      await tx.addTag(row.slug, `tag:${content}`, { sourceId: source.id });
      return { status: 'written' };
    } };
}
export async function publish(engine: BrainEngine, row: WriteRequest, sources: FixtureSource[], config: HarnessConfig): Promise<WriteRequest> {
  return publishMutation(engine, row, prepared(row, sources), config.hostId);
}

/** Derive all counters from durable rows, independently of update statements. */
export async function assertConservation(engine: BrainEngine): Promise<void> {
  const rows = await engine.executeRaw<Record<string, string | number>>(`WITH r AS (
    SELECT *,state IN ('queued','running','recovering') AS pending FROM persistence_requests
  ), expected AS (
    SELECT 'brain' AS key,COUNT(*) FILTER(WHERE pending) AS outstanding_count,
      COALESCE(SUM(intent_bytes) FILTER(WHERE pending),0) AS intent_bytes,COUNT(*) AS lifetime_ids,
      COALESCE(SUM(terminal_reservation),0) AS terminal_bytes,COALESCE(SUM(recovery_bytes),0) AS recovery_bytes FROM r
    UNION ALL SELECT 'principal:'||principal_kind||':'||principal_id,
      COUNT(*) FILTER(WHERE pending),COALESCE(SUM(intent_bytes) FILTER(WHERE pending),0),COUNT(*),SUM(terminal_reservation),0
      FROM r GROUP BY principal_kind,principal_id
    UNION ALL SELECT 'worktree:'||worktree_id::text,0,0,0,0,SUM(recovery_bytes)
      FROM r WHERE worktree_id IS NOT NULL GROUP BY worktree_id
  ) SELECT COALESCE(c.key,e.key) AS key,
    COALESCE(c.outstanding_count,0)-COALESCE(e.outstanding_count,0) AS outstanding_count,
    COALESCE(c.intent_bytes,0)-COALESCE(e.intent_bytes,0) AS intent_bytes,
    COALESCE(c.lifetime_ids,0)-COALESCE(e.lifetime_ids,0) AS lifetime_ids,
    COALESCE(c.terminal_bytes,0)-COALESCE(e.terminal_bytes,0) AS terminal_bytes,
    COALESCE(c.recovery_bytes,0)-COALESCE(e.recovery_bytes,0) AS recovery_bytes
    FROM persistence_counters c FULL JOIN expected e ON e.key=c.key`);
  for (const row of rows) for (const key of ['outstanding_count', 'intent_bytes', 'lifetime_ids', 'terminal_bytes', 'recovery_bytes']) {
    assert.equal(Number(row[key]), 0, `${row.key} ${key} must equal durable request accounting`);
  }
}
export async function assertCommittedSnapshot(engine: BrainEngine, row: WriteRequest): Promise<void> {
  assert.equal(row.state, 'committed');
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  assert(snapshot);
  assert.equal(snapshot.revision, row.outcome!.revision);
  assert.equal(snapshot.page.compiled_truth, String(row.intent!.content));
  assert.equal(snapshot.page.timeline, `timeline:${row.intent!.content}`);
  assert(snapshot.tags.includes(`tag:${row.intent!.content}`));
}
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let n = Math.imul(state ^ state >>> 15, state | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61); return ((n ^ n >>> 14) >>> 0) / 4294967296; };
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
export function distribution(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return { count: values.length, p50_ms: at(.5), p95_ms: at(.95), p99_ms: at(.99), max_ms: at(1) };
}
export async function timedAdmission(engine: BrainEngine, input: WriteAdmission, timings: number[]): Promise<WriteRequest> {
  const started = performance.now(); const row = await admitWrite(engine, input); timings.push(performance.now() - started); return row;
}
