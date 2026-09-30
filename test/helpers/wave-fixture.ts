/**
 * A managed brain carrying one instance of each wave finding the recovery
 * layer classifies (fix wave 3, Lane D): repairable (timeline_history,
 * derived_visibility, safe_index_pending), operator-required
 * (persistence_capacity, parked_effects, self_capture) and unsupported
 * (stale_embedding_effects). PGLite by default; pass a database URL for
 * Postgres. Seeding goes through coordinated writes plus the persistence
 * protocol, the same way the scenario helpers in w5-scenarios.ts do.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { declarePersistenceProtocol } from '../../src/core/persistence/protocol.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { CLAUDE_CLI_CWD_PREFIX } from '../../src/core/ai/providers/claude-cli-scratch.ts';
import { managedBrain, type ManagedBrain } from './managed-brain.ts';
import { withEnv } from './with-env.ts';

export type WaveFindingKind = 'timeline' | 'visibility' | 'safe_index' | 'capacity' | 'parked' | 'self_capture' | 'stale_embedding' | 'old_writer';
export const ALL_WAVE_FINDINGS: WaveFindingKind[] = ['timeline', 'visibility', 'safe_index', 'capacity', 'parked', 'self_capture', 'stale_embedding', 'old_writer'];

export const put = (ctx: OperationContext, slug: string, body: string, type = 'note', extra = '') => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: ${type}\ntitle: ${slug}\n${extra}---\n\n${body}\n` } });

async function protocol(engine: BrainEngine, sql: string, params: unknown[] = []) {
  await engine.transaction(async tx => { await declarePersistenceProtocol(tx); await tx.executeRaw(sql, params); });
}

/** Seed the requested findings; returns the directory holding the fake Claude config (CLAUDE_CONFIG_DIR). */
export async function seedWaveFindings(brain: ManagedBrain, home: string, kinds: WaveFindingKind[] = ALL_WAVE_FINDINGS): Promise<{ claudeDir: string; corpus: string }> {
  const { engine, ctx } = brain;
  const claudeDir = join(home, 'claude');
  const corpus = join(home, 'corpus');
  await put(ctx, 'notes/base', 'A base page.');
  if (kinds.includes('timeline')) {
    await put(ctx, 'notes/history', 'Body with history.');
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
      `INSERT INTO timeline_entries(page_id,date,source,summary,detail) SELECT id,'2026-07-01','legacy','A database-only event','' FROM pages WHERE source_id='default' AND slug='notes/history'`)));
  }
  if (kinds.includes('visibility')) await put(ctx, 'atoms/unstamped', 'An extracted atom with no visibility.', 'atom');
  if (kinds.includes('safe_index')) {
    await put(ctx, 'notes/unsealed', 'A page chunked before the safe-chunk fence.');
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
      "UPDATE pages SET chunker_version=3 WHERE source_id='default' AND slug='notes/unsealed'")));
  }
  await disposePersistenceConsumer(engine);
  if (kinds.includes('capacity')) {
    // 85% of a principal's permanent request ids, with room left under the 90% stop for the repairs.
    await engine.setConfig('persistence.limits.principal_lifetime_ids', '1000');
    await protocol(engine, "UPDATE persistence_counters SET lifetime_ids=850 WHERE key LIKE 'principal:%'");
  }
  if (kinds.includes('parked')) {
    await protocol(engine, `UPDATE persistence_effects SET state='failed',error_code='targets_parked',
      data=jsonb_set(data,'{parked}','[{"slug":"notes/base","error_code":"git_target_unsafe"}]'::jsonb)
      WHERE id=(SELECT e.id FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.kind='git' AND r.slug='notes/base' LIMIT 1)`);
  }
  if (kinds.includes('stale_embedding')) {
    // A committed write whose embedding effect nobody claims (#5629): queued, parked in the future, last touched hours ago.
    await put(ctx, 'notes/orphan-embedding', 'Its embedding effect never runs.');
    await disposePersistenceConsumer(engine);
    const [request] = await engine.executeRaw<{ id: string; source_id: string; source_incarnation: string; worktree_id: string | null }>(
      "SELECT id,source_id,source_incarnation,worktree_id FROM persistence_requests WHERE slug='notes/orphan-embedding' AND state='committed' LIMIT 1");
    const [existing] = await engine.executeRaw<{ id: number }>("SELECT id FROM persistence_effects WHERE request_id=$1::uuid AND kind='embedding'", [request!.id]);
    if (existing) {
      await protocol(engine, `UPDATE persistence_effects SET state='queued',execution_token=NULL,next_attempt_at=now()+interval '10 years',
        updated_at=now()-interval '3 hours' WHERE id=$1`, [existing.id]);
    } else {
      await protocol(engine, `INSERT INTO persistence_effects(request_id,kind,data,state,source_id,source_incarnation,worktree_id,next_attempt_at,updated_at)
        VALUES($1::uuid,'embedding','{}'::jsonb,'queued',$2,$3::uuid,$4::uuid,now()+interval '10 years',now()-interval '3 hours')`,
      [request!.id, request!.source_id, request!.source_incarnation, request!.worktree_id]);
    }
  }
  if (kinds.includes('old_writer')) {
    // A recent write published by a consumer older than v0.60.5.0 (writer_version).
    await protocol(engine, `UPDATE persistence_requests SET consumer_version='0.60.4.0',published_at=now()
      WHERE id=(SELECT id FROM persistence_requests WHERE slug='notes/base' AND state='committed' ORDER BY sequence LIMIT 1)`);
  }
  if (kinds.includes('self_capture')) {
    const self = join(claudeDir, 'projects', `-tmp-${CLAUDE_CLI_CWD_PREFIX}9001`);
    mkdirSync(self, { recursive: true });
    mkdirSync(corpus, { recursive: true });
    writeFileSync(join(self, 'self-session.jsonl'), '{}\n');
    writeFileSync(join(corpus, 'self-session.txt'), 'captured from a gbrain claude-cli call');
    await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
  }
  return { claudeDir, corpus };
}

/** A managed brain seeded with wave findings, run with CLAUDE_CONFIG_DIR pointing at the fixture. */
export async function waveBrain(run: (brain: ManagedBrain & { corpus: string }) => Promise<void>,
  opts: { databaseUrl?: string; kinds?: WaveFindingKind[] } = {}): Promise<void> {
  await managedBrain(async brain => {
    const home = process.env.GBRAIN_HOME!;
    const { claudeDir, corpus } = await seedWaveFindings(brain, home, opts.kinds);
    await withEnv({ CLAUDE_CONFIG_DIR: claudeDir }, () => run({ ...brain, corpus }));
  }, { databaseUrl: opts.databaseUrl });
}
