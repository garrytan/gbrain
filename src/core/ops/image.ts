/**
 * Image-as-query operation cluster — pure move from operations.ts (v0.46.x
 * tranche 3): the v0.36 Phase 2 search_by_image op plus its cluster-local
 * budget/size config readers. Op const stays module-private;
 * `imageOperations` below is spliced into the canonical `operations` array
 * in ../operations.ts at the cluster's original position (between the
 * search and tags spreads). Never import from '../operations.ts' here
 * (cycle).
 */

import type { BrainEngine } from '../engine.ts';
import type { Operation } from './contract.ts';
import { resolveRequestedScope } from './context.ts';

// --- v0.36 Phase 2: search_by_image (image-as-query) ---

const search_by_image: Operation = {
  name: 'search_by_image',
  description:
    'v0.36 cross-modal Phase 2: image-as-query retrieval. Accepts a local path (CLI), data: URI, or http(s):// URL ' +
    '(SSRF-defended). Returns visually-similar image chunks plus any OCR text they carry. Optional `query` text ' +
    'refinement merges via weighted RRF (D13 hybrid intersect). True image→full-text-knowledge requires Phase 3 ' +
    '(`gbrain reindex --multimodal` + `search.unified_multimodal: true`).',
  params: {
    image_path: { type: 'string', description: 'Absolute path to image (local CLI callers only — rejected for remote MCP per D18).' },
    image_url: { type: 'string', description: 'http(s):// URL to image. SSRF-defended; max 3 redirect hops; 10MB cap.' },
    image_data: { type: 'string', description: 'Base64-encoded image bytes (preferred for remote MCP callers). PNG/JPEG/WebP only.' },
    image_mime: { type: 'string', description: 'Optional MIME hint when ambiguous. Magic-byte sniff is authoritative.' },
    query: { type: 'string', description: 'Optional text refinement; runs hybrid intersect via D13 weighted RRF.' },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: { type: 'number', description: 'Skip first N results (for pagination)' },
    source_id: { type: 'string', description: "Scope to a single source. Defaults to ctx.sourceId. '__all__' spans every source for trusted local callers, your granted sources for remote callers." },
  },
  scope: 'read',
  // NOT localOnly: remote MCP callers can pass image_url or image_data
  // (subject to D18 image_path ban + D12 size cap + D23-#6 spend cap).
  handler: async (ctx, p) => {
    const imagePath = p.image_path as string | undefined;
    const imageUrl = p.image_url as string | undefined;
    const imageData = p.image_data as string | undefined;
    const imageMime = (p.image_mime as string) || undefined;
    const queryRefinement = p.query as string | undefined;
    const sourceIdParam = typeof p.source_id === 'string' ? p.source_id : undefined;

    // D18 P0 — remote callers cannot pass image_path. Rejecting at handler
    // entry, before any file I/O fires. validateParams catches it too at the
    // dispatch layer; this is defense-in-depth.
    if (ctx.remote === true && imagePath) {
      throw new Error(
        'permission_denied: image_path is not permitted for remote callers (D18). ' +
        'Use image_url or image_data instead.',
      );
    }

    if (!imagePath && !imageUrl && !imageData) {
      throw new Error('search_by_image requires one of: image_path, image_url, image_data');
    }
    if ([imagePath, imageUrl, imageData].filter(Boolean).length > 1) {
      throw new Error('search_by_image accepts only one of: image_path, image_url, image_data');
    }

    // D23-#6 — remote OAuth clients are charged through the durable
    // reserve-then-settle ledger below. Local CLI callers bypass the cap
    // (clientId="") because they use their own provider credentials.
    const clientId = (ctx.remote === true ? (ctx.auth?.clientId ?? '') : '');

    // Resolve image bytes via the SSRF-defended loader. For remote callers,
    // tighter byte cap.
    const remoteCap = await getRemoteMaxBytes(ctx.engine);
    const localCap = await getLocalMaxBytes(ctx.engine);
    const cap = ctx.remote === true ? remoteCap : localCap;
    const { loadImageInput } = await import('../search/image-loader.ts');
    const loaded = await loadImageInput(
      (imagePath ?? imageUrl ?? `data:${imageMime ?? 'image/png'};base64,${imageData}`)!,
      { maxBytes: cap },
    );

    // Resolve source-scope through the single trust+grant resolver. Pre-fix
    // this branch computed resolvedSourceId then spread sourceScopeOpts(ctx)
    // after it (double-application: the spread silently won, and `__all__`
    // didn't opt out for local callers with ctx.sourceId set). One resolver,
    // one spread — `__all__` spans the brain only for trusted local callers.
    const imageSourceScope = resolveRequestedScope(ctx, sourceIdParam);

    // Reserve immediately before entering the paid search routine. Validation,
    // image loading, and scope resolution happen first so known no-charge
    // failures do not strand reservations. An ambiguous provider failure is
    // settled at this operation's fixed-price upper bound below; pessimistic
    // accounting is safer than reopening daily headroom after the TTL.
    let spendReservationId: string | null = null;
    let estimatedSpendCents = 0;
    if (clientId) {
      const { VOYAGE_MULTIMODAL_3_PER_IMAGE_CENTS } = await import('../spend-log.ts');
      const { reserve } = await import('../minions/budget-meter.ts');
      const calls = 1 + (queryRefinement ? 1 : 0);
      estimatedSpendCents = VOYAGE_MULTIMODAL_3_PER_IMAGE_CENTS * calls;
      const budgetUsd = await getDailyImageBudgetUsd(ctx.engine);
      const reservation = await reserve(ctx.engine, {
        clientId,
        estimatedCents: estimatedSpendCents,
        capCents: budgetUsd * 100,
        provider: 'voyage',
        model: 'voyage-multimodal-3',
      });
      spendReservationId = reservation.reservationId;
    }

    const { searchByImage } = await import('../search/by-image.ts');
    let results: Awaited<ReturnType<typeof searchByImage>>;
    try {
      results = await searchByImage(
        ctx.engine,
        { base64: loaded.base64, mime: loaded.contentType },
        {
          limit: (p.limit as number) || 20,
          offset: (p.offset as number) || 0,
          query: queryRefinement,
          ...imageSourceScope,
        },
      );
    } catch (providerError) {
      if (spendReservationId) {
        const { settle } = await import('../minions/budget-meter.ts');
        try {
          await settle(
            ctx.engine,
            spendReservationId,
            estimatedSpendCents,
            'search_by_image_error_pessimistic',
            ctx.auth?.clientName ?? null,
          );
        } catch (accountingError) {
          throw new AggregateError(
            [providerError, accountingError],
            'search_by_image provider call failed and its spend reservation could not be settled',
          );
        }
      }
      throw providerError;
    }

    // Settlement and the spend-log mirror commit in one transaction. A
    // database/accounting failure blocks the response and leaves the pending
    // reservation holding headroom rather than returning an unmetered success.
    if (spendReservationId) {
      const { settle } = await import('../minions/budget-meter.ts');
      await settle(
        ctx.engine,
        spendReservationId,
        estimatedSpendCents,
        'search_by_image',
        ctx.auth?.clientName ?? null,
      );
    }

    return results;
  },
  cliHints: { name: 'search-by-image' },
};

async function getDailyImageBudgetUsd(engine: BrainEngine): Promise<number> {
  try {
    const v = await engine.getConfig('search.image_query.daily_budget_usd_per_client');
    if (v == null) return 5; // default $5
    const n = parseFloat(v);
    return Number.isFinite(n) && n > 0 ? n : 5;
  } catch {
    return 5;
  }
}

async function getLocalMaxBytes(engine: BrainEngine): Promise<number> {
  try {
    const v = await engine.getConfig('search.image_query.max_bytes');
    if (v == null) return 10 * 1024 * 1024;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024;
  } catch {
    return 10 * 1024 * 1024;
  }
}

async function getRemoteMaxBytes(engine: BrainEngine): Promise<number> {
  try {
    const v = await engine.getConfig('search.image_query.remote_max_bytes');
    if (v == null) return 2 * 1024 * 1024;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : 2 * 1024 * 1024;
  } catch {
    return 2 * 1024 * 1024;
  }
}

export const imageOperations: Operation[] = [search_by_image];
