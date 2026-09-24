import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { readProjectionSnapshot } from '../page-state/projections.ts';
import { safeChunksFilter, currentTextProjectionFilter } from '../search/safe-chunks.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { memoryCueColumn } from './settings.ts';
import { cueSnapshotSql } from './storage.ts';
import { assertCueBuildAuthority, enqueueCueBuild, type CueBuildRow } from './builds.ts';
import { buildCueWindows, validateCueOutput, groundCueQuote } from './windows.ts';
import { CUE_SYSTEM_PROMPT, liveMemoryCueProviders } from './providers.ts';
import { reserveCueAttempt, settleCueAttempt, withCueSpend, type CueBudgetContext } from './budget.ts';
import type { MemoryCueProviders, CueOutput, CueWindow } from './types.ts';

async function capture(engine: BrainEngine, pageId: number) {
  const [page] = await engine.executeRaw<{ slug: string; source_id: string }>('SELECT slug,source_id FROM pages WHERE id=$1', [pageId]);
  if (!page) return null;
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
    const params: unknown[] = [pageId];
    const policy = pageReadFilter('p', undefined, params, true);
    const [stamp] = await tx.executeRaw<{ snapshot: string }>(`SELECT ${cueSnapshotSql} AS snapshot FROM pages p WHERE p.id=$1 AND ${policy}
      AND ${safeChunksFilter('p')} AND ${currentTextProjectionFilter('p')} AND COALESCE(p.frontmatter->>'status','') NOT IN ('withdrawn','superseded')`, params);
    if (!stamp) return null;
    const prepared = await readProjectionSnapshot(tx, page.slug, page.source_id);
    if (!prepared) return null;
    return { ...prepared, digest: stamp.snapshot };
  });
}

type Capture = NonNullable<Awaited<ReturnType<typeof capture>>>;

async function publish(engine: BrainEngine, context: CueBudgetContext, captured: Capture, window: CueWindow, cues: CueOutput[], vectors: Float32Array[]): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw('SELECT id FROM memory_cue_builds WHERE id=$1::uuid FOR UPDATE', [context.build.id]);
    await assertCueBuildAuthority(tx, context.build, context.token);
    await tx.lockPageKeys([{ sourceId: captured.snapshot.page.source_id, slug: captured.snapshot.page.slug }]);
    const current = await capture(tx, captured.snapshot.page.id);
    if (!current || current.digest !== captured.digest || current.snapshot.revision !== captured.snapshot.revision
      || current.snapshot.sourceIncarnation !== captured.snapshot.sourceIncarnation || current.snapshot.page.id !== captured.snapshot.page.id
      || current.indexingContext !== captured.indexingContext) throw new Error('snapshot_superseded');
    const id = randomUUID();
    const [inserted] = await tx.executeRaw<{ id: string }>(`INSERT INTO memory_cue_windows(id,build_id,page_id,source_incarnation,revision,snapshot,window_index,signature,prompt_version,generation_model,status)
      VALUES($1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6,$7,$8,$9,$10,$11) ON CONFLICT(build_id,page_id,snapshot,window_index) DO NOTHING RETURNING id`,
      [id, context.build.id, captured.snapshot.page.id, captured.snapshot.sourceIncarnation, captured.snapshot.revision, captured.digest, window.index,
        context.build.signature, context.build.prompt_version, context.build.generation_model, cues.length ? 'ready' : 'empty']);
    if (inserted) {
      const column = await memoryCueColumn(tx);
      for (let i = 0; i < cues.length; i++) {
        const cue = cues[i]!;
        const grounding = groundCueQuote(window, cue.quote);
        if (!grounding) throw new Error('unsupported_cue');
        const chunkId = grounding[0]!.chunk_id;
        const vectorColumn = column.type === 'halfvec' ? 'embedding_half' : 'embedding';
        await tx.executeRaw(`INSERT INTO memory_cues(id,window_id,page_id,chunk_id,signature,family,relation,cue_text,quote,grounding,${vectorColumn})
          VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::text::jsonb,$11::${column.type}(${column.dimensions}))`,
          [randomUUID(), id, captured.snapshot.page.id, chunkId, context.build.signature, cue.family, cue.relation, cue.text, cue.quote, JSON.stringify(grounding), `[${Array.from(vectors[i]!).join(',')}]`]);
      }
    }
    await tx.executeRaw(`UPDATE memory_cue_pages SET cursor=GREATEST(cursor,$3),status=CASE WHEN $3>=total_windows THEN 'complete' ELSE 'pending' END,reason=NULL WHERE build_id=$1::uuid AND page_id=$2 AND snapshot=$4`,
      [context.build.id, captured.snapshot.page.id, window.index + 1, captured.digest]);
  });
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (error instanceof SyntaxError) return 'invalid_output';
  if (error instanceof Error && error.name === 'EmbeddingDisabledError') return 'embedding_disabled';
  const status = (error as { statusCode?: number; status?: number })?.statusCode ?? (error as { status?: number })?.status;
  if (status === 401 || status === 403) return 'provider_auth_failed';
  if (status === 429) return 'provider_rate_limited';
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return 'provider_timeout';
  const allowed = ['consent_revoked','model_changed','source_changed','budget_owner_missing','budget_exhausted','cancelled','snapshot_superseded',
    'invalid_output','unsupported_cue','unsupported_relation','unsupported_window','provider_refusal','incomplete_output','generation_model_changed','partial_embedding','pricing_unknown'];
  if (allowed.includes(message)) return message;
  if (/api.?key|credential|unauthoriz|authentication/i.test(message)) return 'provider_unconfigured';
  return 'provider_failed';
}

export async function runMemoryCueBuild(engine: BrainEngine, opts: { buildId: string; signal?: AbortSignal; providers?: MemoryCueProviders; boundary?: (name: 'before_completion_lock') => Promise<void> }) {
  const token = randomUUID();
  const [build] = await engine.executeRaw<CueBuildRow>(`UPDATE memory_cue_builds SET status='running',execution_token=$2::uuid,lease_until=now()+interval '2 minutes',updated_at=now()
    WHERE id=$1::uuid AND (status IN ('queued','partial','failed') OR status='running' AND lease_until<now()) RETURNING *`, [opts.buildId, token]);
  if (!build) return { status: 'not_claimed', windowsProcessed: 0 };
  let processed = 0;
  let activePage: number | undefined;
  try {
    await assertCueBuildAuthority(engine, build, token);
    const pages = await engine.executeRaw<{ page_id: number; snapshot: string | null; cursor: number }>(`SELECT page_id,snapshot,cursor FROM memory_cue_pages
      WHERE build_id=$1::uuid AND status<>'complete' ORDER BY page_id LIMIT $2`, [build.id, build.page_limit]);
    const column = await memoryCueColumn(engine);
    for (const page of pages) {
      activePage = page.page_id;
      opts.signal?.throwIfAborted();
      const captured = await capture(engine, page.page_id);
      if (!captured) {
        await engine.executeRaw("UPDATE memory_cue_pages SET status='ineligible',reason='projection_unavailable' WHERE build_id=$1::uuid AND page_id=$2", [build.id, page.page_id]);
        continue;
      }
      if (!build.source_ids.includes(captured.snapshot.page.source_id) || build.source_incarnations[captured.snapshot.page.source_id] !== captured.snapshot.sourceIncarnation) throw new Error('source_changed');
      const windows = buildCueWindows(captured.chunks.filter(c => c.chunk_source === 'compiled_truth' || c.chunk_source === 'timeline'));
      const cursor = page.snapshot === captured.digest ? page.cursor : 0;
      await engine.executeRaw(`UPDATE memory_cue_pages SET snapshot=$3,cursor=$4::int,total_windows=$5::int,status=CASE WHEN $4::int >= $5::int THEN 'complete' ELSE 'pending' END WHERE build_id=$1::uuid AND page_id=$2`,
        [build.id, page.page_id, captured.digest, cursor, windows.length]);
      const completed = new Set((await engine.executeRaw<{ window_index: number }>(`SELECT window_index FROM memory_cue_windows WHERE build_id=$1::uuid AND page_id=$2 AND snapshot=$3 AND status IN ('ready','empty')`,
        [build.id, page.page_id, captured.digest])).map(row => row.window_index));
      for (const window of windows.slice(cursor, cursor + build.window_limit)) {
        opts.signal?.throwIfAborted();
        await engine.executeRaw("UPDATE memory_cue_builds SET lease_until=now()+interval '2 minutes' WHERE id=$1::uuid AND execution_token=$2::uuid", [build.id, token]);
        const context: CueBudgetContext = { build, token, pageId: page.page_id, snapshot: captured.digest, windowIndex: window.index,
          inputTokenCeiling: Buffer.byteLength(CUE_SYSTEM_PROMPT + JSON.stringify({ includeBridge: build.include_bridge, evidence: window.text })) + 1024 };
        if (completed.has(window.index)) {
          await engine.executeRaw(`UPDATE memory_cue_pages SET cursor=$3::int,status=CASE WHEN $3::int>=total_windows THEN 'complete' ELSE 'pending' END
            WHERE build_id=$1::uuid AND page_id=$2 AND snapshot=$4`, [build.id, page.page_id, window.index + 1, captured.digest]);
          processed++;
          if (processed >= build.window_limit) break;
          continue;
        }
        const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
        const providers = opts.providers ?? liveMemoryCueProviders;
        const prepare = async () => {
          let testHold: { id: string; cents: number } | undefined;
          if (opts.providers) testHold = await reserveCueAttempt(engine, context, { operation: 'memory-cues-test-generate', model: build.generation_model,
            kind: 'chat', maxInputTokens: context.inputTokenCeiling, maxOutputTokens: 1200 });
          const output = await providers.generate({ evidence: window.text, includeBridge: build.include_bridge, model: build.generation_model, signal });
          if (testHold) await settleCueAttempt(engine, build, testHold.id, output.actualUsd * 100);
          const cues = validateCueOutput(output.output, window, build.include_bridge);
          await assertCueBuildAuthority(engine, build, token);
          signal.throwIfAborted();
          if (opts.providers && cues.length) await reserveCueAttempt(engine, context, { operation: 'memory-cues-test-embed', model: column.embeddingModel,
            kind: 'embedding', maxInputTokens: cues.reduce((n, c) => n + Buffer.byteLength(c.text), 0) + 256, maxOutputTokens: 0 });
          const vectors = cues.length ? await providers.embed(cues.map(c => c.text), column, signal) : [];
          if (vectors.length !== cues.length || vectors.some(v => v.length !== column.dimensions || !v.every(Number.isFinite) || !v.some(n => n !== 0))) throw new Error('partial_embedding');
          return { cues, vectors };
        };
        const prepared = opts.providers ? await prepare() : await withCueSpend(engine, context, prepare);
        signal.throwIfAborted();
        await publish(engine, context, captured, window, prepared.cues, prepared.vectors);
        processed++;
        if (processed >= build.window_limit) break;
      }
      if (processed >= build.window_limit) break;
    }
    await opts.boundary?.('before_completion_lock');
    const status = await engine.transaction(async tx => {
      await tx.executeRaw('SELECT id FROM memory_cue_builds WHERE id=$1::uuid FOR UPDATE', [build.id]);
      const [remaining] = await tx.executeRaw<{ count: number; ineligible: number }>(`SELECT count(*) FILTER (WHERE status='pending')::int AS count,
        count(*) FILTER (WHERE status='ineligible')::int AS ineligible FROM memory_cue_pages WHERE build_id=$1::uuid`, [build.id]);
      const status = remaining?.count ? 'partial' : remaining?.ineligible ? 'blocked' : 'complete';
      const [updated] = await tx.executeRaw(`UPDATE memory_cue_builds SET status=$3,reason=$4,execution_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1::uuid AND execution_token=$2::uuid RETURNING id`, [build.id, token, status, status === 'blocked' ? 'projection_unavailable' : null]);
      if (updated && status === 'partial') await enqueueCueBuild(tx, build);
      return updated ? status : 'not_claimed';
    });
    return { status, windowsProcessed: processed };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) throw error;
    const reason = opts.signal?.aborted ? 'cancelled' : failureReason(error);
    await engine.transaction(async tx => {
      const [updated] = await tx.executeRaw(`UPDATE memory_cue_builds SET status=$3,reason=$4,execution_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1::uuid AND execution_token=$2::uuid RETURNING id`,
        [build.id, token, reason === 'snapshot_superseded' ? 'partial' : 'failed', reason]);
      if (updated && activePage !== undefined) await tx.executeRaw("UPDATE memory_cue_pages SET status='pending',reason=$3 WHERE build_id=$1::uuid AND page_id=$2", [build.id, activePage, reason]);
      if (updated && reason === 'snapshot_superseded') await enqueueCueBuild(tx, build);
    });
    return { status: 'failed', reason, windowsProcessed: processed };
  }
}
