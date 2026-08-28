/**
 * loops ops — the open-loop engine's read/write surface.
 *
 *   open_loops  (read)  — the killer output: who is waiting on you, what you
 *                         promised, and the context needed to respond.
 *   loops_close (write) — mark a loop done/dropped.
 *   loops_mute  (write) — suppress a sender/thread from future detection.
 *
 * Remote posture (approved D4-A): open_loops is NOT localOnly — hosted
 * gbrain.io serves it over HTTP to its authenticated owner. Fail-closed
 * evidence redaction instead: `ctx.remote !== false` gets counts +
 * counterparty + summary + due; verbatim quotes, Gmail deep links, and the
 * injectable text block are trusted-local only.
 *
 * Trust-critical freshness (outside-voice F2): the result carries the google
 * sources' last-successful-sync ages and a `stale` flag — stale-but-confident
 * "you owe Alice a reply" is worse than no output, so the CLI refuses on
 * stale unless --stale-ok.
 */

import { OperationError, type Operation, type OperationContext } from './contract.ts';
import { resolveRequestedScope, sourceScopeOpts } from './context.ts';
import { validateSourceId } from '../utils.ts';
import {
  addSuppression,
  closeOpenLoop,
  listOpenLoops,
  type LoopStatus,
  type LoopType,
  type OpenLoopRow,
} from '../loops/loops-store.ts';

const STALE_AFTER_MS = 24 * 3_600_000;

interface GoogleSourceFreshness {
  id: string;
  last_sync_at: string | null;
  stale: boolean;
}

async function googleSourceFreshness(
  ctx: OperationContext,
  scope: { sourceId?: string; sourceIds?: string[] },
): Promise<{ sources: GoogleSourceFreshness[]; stale: boolean }> {
  try {
    const rows = await ctx.engine.executeRaw<{ id: string; last_sync_at: string | null; config: unknown }>(
      `SELECT id, last_sync_at, config FROM sources WHERE archived IS NOT TRUE`,
      [],
    );
    const sources = rows
      .filter((r) => {
        const c =
          typeof r.config === 'string'
            ? (JSON.parse(r.config) as Record<string, unknown>)
            : ((r.config ?? {}) as Record<string, unknown>);
        if (c.kind !== 'google') return false;
        if (scope.sourceIds && !scope.sourceIds.includes(r.id)) return false;
        if (scope.sourceId && scope.sourceId !== r.id) return false;
        return true;
      })
      .map((r) => ({
        id: r.id,
        last_sync_at: r.last_sync_at,
        stale:
          r.last_sync_at === null || Date.now() - Date.parse(r.last_sync_at) > STALE_AFTER_MS,
      }));
    return { sources, stale: sources.length > 0 && sources.every((s) => s.stale) };
  } catch {
    // Fail TOWARD stale: this surface's invariant is "stale-but-confident is
    // worse than nothing" — a DB error must not present confident output
    // with the stale warning suppressed.
    return { sources: [], stale: true };
  }
}

/** Regenerate Gmail deep links (code, never stored LLM text) for evidence. */
async function deepLinksFor(
  ctx: OperationContext,
  loops: OpenLoopRow[],
): Promise<Map<string, string>> {
  // account lives in the thread page's frontmatter; batch one query.
  const slugs = [...new Set(loops.map((l) => l.page_slug).filter((s): s is string => s !== null))];
  const accounts = new Map<string, string>();
  if (slugs.length > 0) {
    try {
      // source-scoped so the composite (source_id, slug) unique index serves
      // the lookup — a slug-only predicate would sequential-scan pages.
      const sourceIds = [...new Set(loops.map((l) => l.source_id))];
      const rows = await ctx.engine.executeRaw<{ slug: string; account: string | null; source_id: string }>(
        `SELECT slug, source_id, frontmatter->>'account' AS account FROM pages
         WHERE source_id = ANY(string_to_array($2, E'\\n'))
           AND slug = ANY(string_to_array($1, E'\\n')) AND deleted_at IS NULL`,
        [slugs.join('\n'), sourceIds.join('\n')],
      );
      for (const r of rows) if (r.account) accounts.set(`${r.source_id}:${r.slug}`, r.account);
    } catch { /* links degrade to none */ }
  }
  const out = new Map<string, string>();
  const { emailCitation } = await import('../output/scaffold.ts');
  for (const l of loops) {
    const account = l.page_slug ? accounts.get(`${l.source_id}:${l.page_slug}`) : undefined;
    const messageId = l.evidence.find((e) => e.message_id)?.message_id;
    if (!account || !messageId) continue;
    try {
      out.set(
        `${l.id}`,
        emailCitation({
          account,
          messageId,
          subject: l.summary.slice(0, 80),
          dateISO: l.last_activity_at.slice(0, 10),
        }),
      );
    } catch { /* invalid message id — no link */ }
  }
  return out;
}

interface LoopView {
  id: number;
  loop_type: LoopType;
  status: LoopStatus;
  summary: string;
  due_at: string | null;
  opened_at: string;
  last_activity_at: string;
  counterparty_slug: string | null;
  counterparty_email: string | null;
  detector: string;
  confidence: number;
  page_slug: string | null;
  /** Trusted-local only. */
  quote?: string;
  deep_link?: string;
}

function loopView(l: OpenLoopRow, trusted: boolean, deepLinks: Map<string, string>): LoopView {
  const base: LoopView = {
    id: l.id,
    loop_type: l.loop_type,
    status: l.status,
    summary: l.summary,
    due_at: l.due_at,
    opened_at: l.opened_at,
    last_activity_at: l.last_activity_at,
    counterparty_slug: l.counterparty_slug,
    counterparty_email: l.counterparty_email,
    detector: l.detector,
    confidence: l.confidence,
    page_slug: l.page_slug,
  };
  if (trusted) {
    const q = l.evidence.find((e) => e.quote)?.quote;
    if (q) base.quote = q;
    const link = deepLinks.get(`${l.id}`);
    if (link) base.deep_link = link;
  }
  return base;
}

interface CounterpartyGroup {
  counterparty: string;
  counterparty_slug: string | null;
  counterparty_email: string | null;
  /** The loops' home source — entity cards/aliases live THERE, not in the
   *  caller's (often 'default') scope. */
  source_id: string;
  loop_count: number;
  oldest_opened_at: string;
  nearest_due_at: string | null;
  loops: LoopView[];
  context?: unknown;
}

function rankGroups(groups: CounterpartyGroup[], backlinks: Map<string, number>): CounterpartyGroup[] {
  const score = (g: CounterpartyGroup): number => {
    let s = g.loop_count * 10;
    if (g.nearest_due_at) {
      const days = (Date.parse(g.nearest_due_at) - Date.now()) / 86_400_000;
      s += days <= 0 ? 50 : days <= 3 ? 30 : days <= 7 ? 15 : 5;
    }
    const ageDays = (Date.now() - Date.parse(g.oldest_opened_at)) / 86_400_000;
    s += Math.min(20, ageDays);
    if (g.counterparty_slug) s += Math.min(20, backlinks.get(g.counterparty_slug) ?? 0);
    return s;
  };
  return [...groups].sort((a, b) => score(b) - score(a) || a.counterparty.localeCompare(b.counterparty));
}

function renderText(groups: CounterpartyGroup[], stale: boolean, noGoogleSources: boolean): string {
  const lines: string[] = [];
  if (stale) lines.push('⚠ google sources have not synced recently — this may be out of date.');
  if (groups.length === 0) {
    if (noGoogleSources) {
      // Trust-critical copy: on a brain whose email arrives some other way
      // (a gateway, an agent-authored collector), "You are clean" would be a
      // confident lie — the engine has nothing to read.
      lines.push(
        'No google source is connected in this scope — the open-loop engine has nothing to read, ' +
          'so this is NOT "inbox clean". Connect one with: gbrain google setup ' +
          '(existing gateway/CLI access works too: gbrain sources add <id> --kind google --access command|env — see docs/guides/google-connect.md).',
      );
      return lines.join('\n');
    }
    lines.push('No open loops — no unanswered threads older than 24h and no tracked promises. You are clean.');
    return lines.join('\n');
  }
  lines.push(`${groups.length} ${groups.length === 1 ? 'person is' : 'people are'} waiting on you:`);
  for (const g of groups) {
    lines.push('', `## ${g.counterparty} (${g.loop_count} open)`);
    for (const l of g.loops) {
      const due = l.due_at ? ` — due ${l.due_at.slice(0, 10)}` : '';
      // Age renders at READ time from last_activity_at — stored summaries
      // deliberately carry no age (it would freeze at detection time).
      const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(l.last_activity_at)) / 86_400_000));
      const age = Number.isFinite(ageDays) ? ` (${ageDays}d)` : '';
      lines.push(`- [${l.loop_type}] ${l.summary}${age}${due}`);
      if (l.quote) lines.push(`  > "${l.quote}"`);
      if (l.deep_link) lines.push(`  ${l.deep_link}`);
    }
  }
  return lines.join('\n');
}

const open_loops: Operation = {
  name: 'open_loops',
  description:
    'The open-loop engine\'s killer output: who is waiting on you, what you promised, and the context ' +
    'needed to respond. Grouped by counterparty (default, ranked) or flat. Loops come from the ' +
    'deterministic Gmail thread-state detector and the LLM commitment extractor. Remote callers get ' +
    'redacted evidence (no verbatim quotes); trusted local callers also get quotes, Gmail deep links, ' +
    'entity-card context, and a pre-rendered text digest. Carries google-source freshness (stale flag).',
  params: {
    group_by: { type: 'string', enum: ['counterparty', 'none'], description: "Default 'counterparty' (ranked groups)." },
    status: { type: 'string', enum: ['open', 'done', 'dropped', 'stale'], description: "Default 'open'." },
    loop_type: { type: 'string', enum: ['commitment_owed_by_me', 'commitment_owed_to_me', 'unanswered_inbound', 'unanswered_outbound', 'decision_pending'], description: 'Filter to one loop type.' },
    counterparty: { type: 'string', description: 'Filter to one counterparty (slug or email).' },
    limit: { type: 'number', description: 'Grouped: max groups (default 3). Flat: max loops (default 50). The internal fetch is capped at 500 rows; `truncated: true` marks a hit.' },
    include_context: { type: 'boolean', description: 'Attach the counterparty entity card per group (trusted local only). Default true.' },
    source_id: { type: 'string', description: "Scope to one source (e.g. the google source, when the caller's transport is bound elsewhere). Remote callers must hold a grant covering it." },
    all_sources: { type: 'boolean', description: 'Trusted local: span every source in the brain. Remote callers stay inside their grant.' },
  },
  scope: 'read',
  annotations: { readOnlyHint: true },
  handler: async (ctx, p) => {
    const trusted = ctx.remote === false;
    const groupBy = (p.group_by as string | undefined) ?? 'counterparty';
    const status = ((p.status as string | undefined) ?? 'open') as LoopStatus;
    // Per-call scope via the canonical trust+grant resolver: an MCP caller
    // whose transport is bound to another source can point this read at the
    // google source (`source_id`) or, trusted-local, span the brain
    // (`all_sources`) — remote callers stay inside their grant and an
    // out-of-grant source_id is denied there.
    const scope = resolveRequestedScope(
      ctx,
      p.source_id as string | undefined,
      p.all_sources === true,
    );
    // Tighter than the shared resolver for REMOTE callers: resolveRequestedScope
    // honors an explicit source_id for scalar-scoped callers (its other
    // consumers apply page-visibility filtering, so a cross-source read there
    // exposes world rows only). Loops have NO visibility tiering — summaries
    // derive from private email — so a remote source_id must sit inside the
    // caller's grant, scalar or federated.
    if (!trusted && typeof p.source_id === 'string') {
      const allowed = ctx.auth?.allowedSources;
      const inGrant =
        (allowed && allowed.length > 0 && allowed.includes(p.source_id)) ||
        (!(allowed && allowed.length > 0) && ctx.sourceId === p.source_id);
      if (!inGrant) {
        throw new OperationError(
          'permission_denied',
          `open_loops: source '${p.source_id}' is outside your granted sources`,
        );
      }
    }
    // Fail-closed invariant: an untrusted caller must arrive with a resolved
    // scope. Shipped transports refuse unscoped remote calls upstream, but
    // the op must not rely on them — an unscoped remote read here would span
    // every source (the cross-source leak class).
    if (!trusted && !scope.sourceId && !scope.sourceIds) {
      throw new OperationError(
        'permission_denied',
        'open_loops: remote callers need a resolved source scope',
      );
    }
    const loops = await listOpenLoops(ctx.engine, {
      ...(scope.sourceIds ? { sourceIds: scope.sourceIds } : {}),
      ...(scope.sourceId ? { sourceIds: [scope.sourceId] } : {}),
      status,
      ...(p.loop_type ? { loopType: p.loop_type as LoopType } : {}),
      ...(p.counterparty ? { counterparty: p.counterparty as string } : {}),
      limit: 500,
    });
    const freshness = await googleSourceFreshness(ctx, scope);
    const noGoogleSources = freshness.sources.length === 0;
    const deepLinks = trusted ? await deepLinksFor(ctx, loops) : new Map<string, string>();

    const truncated = loops.length >= 500;
    if (groupBy === 'none') {
      const limit = Math.min(Math.max((p.limit as number | undefined) ?? 50, 1), 500);
      return {
        loops: loops.slice(0, limit).map((l) => loopView(l, trusted, deepLinks)),
        count: loops.length,
        truncated,
        stale: freshness.stale,
        sources: freshness.sources,
        no_google_sources: noGoogleSources,
        redacted: !trusted,
      };
    }

    const byKey = new Map<string, CounterpartyGroup>();
    for (const l of loops) {
      const key = l.counterparty_slug ?? l.counterparty_email ?? 'unknown';
      let g = byKey.get(key);
      if (!g) {
        g = {
          counterparty: key,
          counterparty_slug: l.counterparty_slug,
          counterparty_email: l.counterparty_email,
          source_id: l.source_id,
          loop_count: 0,
          oldest_opened_at: l.opened_at,
          nearest_due_at: null,
          loops: [],
        };
        byKey.set(key, g);
      }
      g.loop_count++;
      if (l.opened_at < g.oldest_opened_at) g.oldest_opened_at = l.opened_at;
      if (l.due_at && (!g.nearest_due_at || l.due_at < g.nearest_due_at)) g.nearest_due_at = l.due_at;
      g.loops.push(loopView(l, trusted, deepLinks));
    }

    const backlinks = new Map<string, number>();
    try {
      const slugs = [...byKey.values()]
        .map((g) => g.counterparty_slug)
        .filter((s): s is string => s !== null);
      if (slugs.length > 0) {
        // getBacklinkCounts takes numeric page ids (v0.46.35) — resolve the
        // counterparty slugs within the loops' home sources first (same
        // composite-key discipline as deepLinksFor), then fold back to slugs.
        const srcIds = [...new Set([...byKey.values()].map((g) => g.source_id))];
        const rows = await ctx.engine.executeRaw<{ id: number; slug: string }>(
          `SELECT id, slug FROM pages
           WHERE source_id = ANY(string_to_array($2, E'\\n'))
             AND slug = ANY(string_to_array($1, E'\\n')) AND deleted_at IS NULL`,
          [slugs.join('\n'), srcIds.join('\n')],
        );
        if (rows.length > 0) {
          const counts = await ctx.engine.getBacklinkCounts(rows.map((r) => Number(r.id)));
          for (const r of rows) {
            const c = counts.get(Number(r.id));
            if (c !== undefined) backlinks.set(r.slug, Math.max(backlinks.get(r.slug) ?? 0, c));
          }
        }
      }
    } catch { /* rank without backlinks */ }

    const limit = Math.min(Math.max((p.limit as number | undefined) ?? 3, 1), 50);
    const groups = rankGroups([...byKey.values()], backlinks).slice(0, limit);

    // Entity-card context (zero-LLM, trusted local only).
    if (trusted && (p.include_context as boolean | undefined) !== false) {
      const { buildEntityCard } = await import('../verbs/entity-card.ts');
      for (const g of groups) {
        if (!g.counterparty_slug) continue;
        try {
          // The card resolves in the LOOP's source (where the person page +
          // alias rows live), never the caller's scope — an unqualified
          // `gbrain waiting` would otherwise look in 'default' and silently
          // never attach context (same bug class as deepLinksFor's fix).
          const card = await buildEntityCard(ctx.engine, g.source_id, g.counterparty_slug, { remote: false });
          if (card.found) g.context = card.card;
        } catch { /* context is best-effort */ }
      }
    }

    return {
      groups,
      count: loops.length,
      truncated,
      stale: freshness.stale,
      sources: freshness.sources,
      no_google_sources: noGoogleSources,
      redacted: !trusted,
      ...(trusted ? { text: renderText(groups, freshness.stale, noGoogleSources) } : {}),
    };
  },
};

const loops_close: Operation = {
  name: 'loops_close',
  description:
    "Close an open loop by id: status 'done' (handled) or 'dropped' (not going to). Closing is a state " +
    'transition with an audit trail, never a delete. Thread loops also close automatically when a reply lands.',
  params: {
    id: { type: 'number', required: true, description: 'Loop id (from open_loops).' },
    status: { type: 'string', required: true, enum: ['done', 'dropped'], description: 'Terminal state.' },
    note: { type: 'string', description: 'Optional closed_by note (default: manual).' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const scope = sourceScopeOpts(ctx);
    // Remote callers stay inside their granted source scope; trusted local
    // closes across sources (null = unscoped).
    let sourceId: string | null = null;
    if (ctx.remote !== false) {
      sourceId = scope.sourceId ?? (scope.sourceIds && scope.sourceIds.length === 1 ? scope.sourceIds[0] : null);
      if (!sourceId) {
        // Enumerated error envelope (dispatch classifies + request-logs it),
        // never a success-shaped { closed:false } payload.
        throw new OperationError(
          'permission_denied',
          'loops_close: remote callers need a single-source scope',
        );
      }
    }
    if (ctx.dryRun) return { dry_run: true, action: 'loops_close', id: p.id, status: p.status };
    const row = await closeOpenLoop(
      ctx.engine,
      sourceId,
      p.id as number,
      p.status as 'done' | 'dropped',
      (p.note as string | undefined)?.slice(0, 200) || 'manual',
    );
    if (!row) return { closed: false, reason: 'not_found_or_already_closed' };
    // A closed commitment loop expires its projected fact so entity cards
    // stop carrying it (fence round-trip happens on the next facts sweep).
    if (row.fact_id !== null) {
      try {
        await ctx.engine.executeRaw(
          `UPDATE facts SET expired_at = now() WHERE id = $1 AND expired_at IS NULL`,
          [row.fact_id],
        );
      } catch { /* best-effort */ }
    }
    return { closed: true, id: row.id, status: row.status, fact_expired: row.fact_id !== null };
  },
};

const loops_mute: Operation = {
  name: 'loops_mute',
  description:
    'Suppress a sender (email address) or thread id from opening NEW loops — the detector feedback ' +
    'primitive behind "never track this sender". Existing loops keep their state.',
  params: {
    kind: { type: 'string', required: true, enum: ['sender', 'thread'], description: 'What to mute.' },
    value: { type: 'string', required: true, description: 'The sender email or Gmail thread id.' },
    source_id: { type: 'string', description: 'Google source to scope the mute to (default: routed source).' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const sourceId = (p.source_id as string | undefined) ?? ctx.sourceId ?? 'default';
    validateSourceId(sourceId);
    // Remote callers stay strictly inside their grant (mirrors loops_close):
    // a scalar-scoped caller may only mute within its own source; federated
    // grants must include the target. Trusting p.source_id for a remote
    // WRITE would let any remote client plant suppression rows into
    // arbitrary sources (targeted denial-of-loop-detection).
    if (ctx.remote !== false) {
      const scope = sourceScopeOpts(ctx);
      const granted =
        (scope.sourceId && scope.sourceId === sourceId) ||
        (scope.sourceIds?.includes(sourceId) ?? false);
      if (!granted) {
        throw new OperationError(
          'permission_denied',
          `loops_mute: source "${sourceId}" is outside the caller's scope`,
        );
      }
    }
    if (ctx.dryRun) return { dry_run: true, action: 'loops_mute', kind: p.kind, value: p.value };
    await addSuppression(ctx.engine, sourceId, p.kind as 'sender' | 'thread', p.value as string);
    return { muted: true, kind: p.kind, value: (p.value as string).toLowerCase(), source_id: sourceId };
  },
};

export const loopsOperations: Operation[] = [open_loops, loops_close, loops_mute];
