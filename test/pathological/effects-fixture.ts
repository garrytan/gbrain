/**
 * Effect-runner builders for the GBRA-130 effects cases (A-11, A-12, A-13): a
 * fresh engine per arm whose default source is a claimed worktree in a durable
 * Git repository, three pages that carry one world claim in their facts fence
 * (plus one untouched page), and helpers that drive the effect runner one pass
 * at a time with every effect due, an embedding stub, and the text projections
 * a withdrawal invalidates rebuilt the way the projection worker would.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { recordFactWithdrawal } from '../../src/core/facts/withdrawal.ts';
import { installPageProjection, readProjectionSnapshot } from '../../src/core/page-state/projections.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { admitWrite, completeWrite } from '../../src/core/persistence/journal.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { runPersistenceEffects, type EffectWorkerOptions } from '../../src/core/persistence/effects.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { durableGitRepo, git } from '../helpers/git-publication.ts';
import { withEnv } from '../helpers/with-env.ts';

export const SOURCE = 'default';
export const CLAIM = 'acme-example closed a seed round';
export const TARGETS = ['notes/w-1', 'notes/w-2', 'notes/w-3'];
export const UNTOUCHED = 'notes/untouched';
export const SIGNATURE = 'test:model:1536';
export const MODEL = 'test:model';
export const vector = () => new Float32Array(1536).fill(0.1);
export type Embed = NonNullable<EffectWorkerOptions['embedding']>['embed'];
export const embedAll: Embed = async texts => texts.map(() => vector());

export interface WithdrawalBrain {
  engine: BrainEngine; root: string; ctx: OperationContext;
  /** The forget request: journal row id (effects reference it) and public receipt id. */
  request: { id: string; request_id: string };
}

const body = (slug: string) => `# ${slug}\n\n${renderFactsTable([{ rowNum: 1, claim: CLAIM, kind: 'fact', confidence: 1, visibility: 'world', notability: 'medium', active: true }])}`;

/**
 * Seeds the pages, their files and chunks, commits them, then commits one forget request whose withdrawal queues mirror, Git and embedding effects.
 * `untracked` pages keep their files on disk but out of the seed commit, so a later commit of their bytes shows in the history.
 */
export async function withdrawalBrain(databaseUrl: string | undefined, run: (brain: WithdrawalBrain) => Promise<void>, opts: { untracked?: string[] } = {}): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-pathological-effects-'));
  try {
    await withEnv({ GBRAIN_HOME: join(home, 'home'), GBRAIN_AUDIT_DIR: join(home, 'audit'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      const root = join(home, 'brain'); mkdirSync(join(root, 'notes'), { recursive: true });
      try {
        await registerLocalWriter(engine, 'cli');
        await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, SOURCE]);
        const binding = await claimWorktree(engine, SOURCE, root, localHostId());
        const files: string[] = [];
        for (const slug of [...TARGETS, UNTOUCHED]) {
          const text = slug === UNTOUCHED ? 'Exact untouched bytes.' : body(slug);
          await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: text }, { sourceId: SOURCE });
          await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text }], { sourceId: SOURCE });
          const snapshot = (await engine.readPageSnapshot(slug, { sourceId: SOURCE }))!;
          writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
          if (!opts.untracked?.includes(slug)) files.push(`${slug}.md`);
        }
        durableGitRepo(root, files);
        const ctx: OperationContext = { engine, remote: false, sourceId: SOURCE, config: { engine: engine.kind, embedding_disabled: false }, dryRun: false,
          logger: { info() {}, warn() {}, error() {} } };
        const fact = await engine.insertFact({ fact: CLAIM, source: 'synthetic', visibility: 'world' }, { source_id: SOURCE });
        const authority = await submissionAuthority(ctx, 'forget', SOURCE, binding.source_incarnation, TARGETS[0]);
        const request = await admitWrite(engine, { authority, principal: authority.principal, operation: 'forget', sourceId: SOURCE,
          sourceIncarnation: binding.source_incarnation, slug: TARGETS[0], pageId: null, requestId: randomUUID(),
          intent: { id: fact.id }, callerIntent: { id: fact.id }, worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation });
        await engine.transaction(async tx => {
          await recordFactWithdrawal(tx, fact.id, SOURCE, false, { requestId: request.id });
          await completeWrite(tx, request, 'committed', { status: 'forgotten' });
        });
        await run({ engine, root, ctx, request: { id: request.id, request_id: request.request_id } });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Rebuilds and seals the text projection of every listed page whose projection the withdrawal invalidated. */
export async function rebuildProjections(engine: BrainEngine, slugs = TARGETS): Promise<void> {
  for (const slug of slugs) {
    const prepared = await readProjectionSnapshot(engine, slug, SOURCE, { allowUnsealed: true });
    if (!prepared || prepared.snapshot.page.text_projection_revision === prepared.snapshot.revision) continue;
    await installPageProjection(engine, prepared, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: prepared.snapshot.page.compiled_truth }], { seal: true });
  }
}

/** Makes every unfinished effect due now. */
export async function due(engine: BrainEngine): Promise<void> {
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE state IN ('queued','running')");
  });
}

/**
 * Runs `passes` effect passes (limit 20 each unless `limit` is given), every effect due before each, with the given embedding stub; the
 * projections a withdrawal invalidated are rebuilt first unless `projections` is false (an archived source refuses them).
 */
export async function drain(engine: BrainEngine, passes: number, opts: { embed?: Embed; config?: GBrainConfig; projections?: boolean; limit?: number } = {}): Promise<void> {
  for (let i = 0; i < passes; i++) {
    await due(engine);
    if (opts.projections !== false) await rebuildProjections(engine);
    await runPersistenceEffects(engine, opts.config ?? { engine: engine.kind, embedding_disabled: false },
      { hostId: localHostId(), limit: opts.limit ?? 20, embedding: { signature: SIGNATURE, model: MODEL, embed: opts.embed ?? embedAll } });
  }
}

/** The outermost transactions' lockPageKeys throws error() whenever the keys include a listed slug; returns the restore. */
export function failLocks(engine: BrainEngine, slugs: Set<string>, error: () => unknown): () => void {
  const original = engine.transaction;
  engine.transaction = (async function (this: BrainEngine, fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) {
    if (this !== engine) return original.call(this, fn, opts as never);
    return original.call(engine, async (tx: BrainEngine) => {
      const real = tx.lockPageKeys;
      tx.lockPageKeys = (async (keys: ReadonlyArray<{ slug: string }>, ...rest: unknown[]) => {
        if (keys.some(key => slugs.has(key.slug))) throw error();
        return (real as (...a: unknown[]) => Promise<unknown>).call(tx, keys, ...rest);
      }) as BrainEngine['lockPageKeys'];
      try { return await fn(tx); } finally { delete (tx as { lockPageKeys?: unknown }).lockPageKeys; }
    }, opts as never);
  }) as BrainEngine['transaction'];
  return () => { engine.transaction = original; };
}

/** Runs `n` effect passes of a managed brain (no embedding stub), every effect due before each. */
export async function passes(engine: BrainEngine, config: GBrainConfig, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await due(engine);
    await runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 20 });
  }
}

export interface EffectRow { id: string; kind: string; state: string; error_code: string | null; attempts: number; data: Record<string, any>; outcome: Record<string, any> | null }

export async function effectsOf(engine: BrainEngine, requestId: string): Promise<Record<string, EffectRow>> {
  const rows = await engine.executeRaw<EffectRow>('SELECT id::text AS id,kind,state,error_code,attempts,data,outcome FROM persistence_effects WHERE request_id=$1::uuid ORDER BY kind', [requestId]);
  return Object.fromEntries(rows.map(row => [row.kind, { ...row, attempts: Number(row.attempts) }]));
}

/** Files Git has committed since the seed commit. */
export function committedSinceSeed(root: string): string[] {
  return git(root, 'log', '--name-only', '--pretty=format:', 'HEAD', '--not', git(root, 'rev-list', '--max-parents=0', 'HEAD').trim())
    .split('\n').filter(Boolean);
}

/** Paths whose committed bytes since the seed commit hold the active (unwithdrawn) facts row of CLAIM. */
export function committedActiveClaim(root: string): string[] {
  const seed = git(root, 'rev-list', '--max-parents=0', 'HEAD').trim();
  return [...new Set(committedSinceSeed(root))].filter(path => git(root, 'log', '-p', '--format=', 'HEAD', '--not', seed, '--', path)
    .split('\n').some(line => line.startsWith('+') && line.includes(`| ${CLAIM} |`))).sort();
}

export async function embeddedPages(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(`SELECT DISTINCT p.slug FROM pages p JOIN content_chunks c ON c.page_id=p.id
    WHERE p.source_id=$1 AND c.embedding IS NOT NULL AND c.embedded_at IS NOT NULL ORDER BY p.slug`, [SOURCE]);
  return rows.map(row => row.slug);
}
