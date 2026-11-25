/**
 * check_claims (agent-platform C3): before an agent states numbers, it checks them against the allowed-claims pages
 * (type: facts with claims: allowed) the caller can read. Matching is deterministic (core/claims/check.ts). Pages are
 * read the way get_page reads them for this caller: source scope, private pages, the read floor and the privacy fences,
 * so a line the caller cannot read never supports or contradicts anything and its claim reads not_found.
 * A page counts only while its precedence is approved or record (eligibility/precedence.ts) and its trust tier is
 * neither external_untrusted nor written by an agent over MCP: a guest, external, remote-agent or quarantined page
 * marked claims: allowed is ignored, and the result names it under `skipped` with the reason. A trusted local write
 * (setup's `gbrain put`, a local edit) keeps it approved. The claims: allowed filter runs in SQL, so the page cap
 * counts allowed-claims pages only.
 */
import { allowedLines, checkClaim, extractClaims, type AllowedLine } from '../claims/check.ts';
import { selfApprovalBlocked } from '../eligibility/precedence.ts';
import { isQuarantined } from '../quarantine.ts';
import type { Operation } from './contract.ts';
import { assertExplicitSourceLive, federatedSearchScope, parseSourceIdParam, readPolicyOpts } from './context.ts';
import { invalidParam } from './op-fix.ts';
import { pageTrustForRead } from './get-page-projection.ts';
import { stripPrivacyFencesForRemoteReader } from './pages.ts';

export const CHECK_CLAIMS_MAX_CHARS = 20_000;
const MAX_ALLOWED_PAGES = 200;
/** Why an allowed-claims page the caller can read was not used. */
export type SkipReason = 'segmented' | 'quarantined' | 'external' | 'written_by_agent' | 'not_approved';

const check_claims: Operation = {
  name: 'check_claims',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'Check the numbers in a draft against allowed-claims pages (type: facts, claims: allowed) before stating them. '
    + 'Per claim: supported (with the cited dated line), conflicts (lines that say another number) or not_found, which means no allowed claim covers it, not that it is false.',
  params: {
    text: { type: 'string', required: true, description: `The draft to check (max ${CHECK_CLAIMS_MAX_CHARS} characters).` },
    source_id: { type: 'string', description: "One source, or '__all__'." },
  },
  handler: async (ctx, p) => {
    const text = typeof p.text === 'string' ? p.text : '';
    if (!text.trim() || text.length > CHECK_CLAIMS_MAX_CHARS) {
      throw invalidParam(ctx, 'check_claims', 'text', `check_claims: text must be 1 to ${CHECK_CLAIMS_MAX_CHARS} characters.`, { example: 'We have 20 paying customers.' });
    }
    const sourceIdParam = parseSourceIdParam(p.source_id, 'check_claims', { allowAll: true });
    const scope = federatedSearchScope(ctx, sourceIdParam);
    await assertExplicitSourceLive(ctx, sourceIdParam);
    const policy = ctx.remote === false && !ctx.applyRemoteReadPolicy ? undefined : await readPolicyOpts(ctx, scope);
    const pages = scope.sourceIds?.length === 0 ? [] : await ctx.engine.listPages({ type: 'facts' as never, where: { claims: ['allowed'] }, limit: MAX_ALLOWED_PAGES, excludePrivate: policy?.excludePrivate, ...scope });
    const lines: AllowedLine[] = [];
    const skipped: Array<{ slug: string; source_id: string; reason: SkipReason }> = [];
    let read = 0;
    for (const page of pages) {
      const fm = page.frontmatter as Record<string, unknown> | null;
      if (fm?.claims !== 'allowed') continue;
      const readable = await pageTrustForRead(ctx, page, undefined);
      if (!readable) continue;
      const { precedence, trust_tier, origin } = readable.trust;
      const reason: SkipReason | null = page.body_storage === 'segmented' ? 'segmented'
        : isQuarantined(fm) ? 'quarantined'
        : precedence === 'external' || trust_tier === 'external_untrusted' ? 'external'
        : selfApprovalBlocked(trust_tier, origin) ? 'written_by_agent'
        : precedence !== 'approved' && precedence !== 'record' ? 'not_approved'
        : null;
      if (reason) { skipped.push({ slug: page.slug, source_id: page.source_id, reason }); continue; }
      const visible = ctx.remote === false ? page : await stripPrivacyFencesForRemoteReader(ctx, page);
      read++;
      lines.push(...allowedLines({ slug: page.slug, source_id: page.source_id, body: visible.compiled_truth ?? '' }));
    }
    const claims = extractClaims(text).map(claim => checkClaim(claim, lines));
    const count = (status: string) => claims.filter(c => c.status === status).length;
    return {
      claims,
      summary: { supported: count('supported'), conflicts: count('conflicts'), not_found: count('not_found') },
      allowed_pages: read,
      ...(skipped.length ? { skipped } : {}),
      ...(pages.length >= MAX_ALLOWED_PAGES ? { pages_truncated: true } : {}),
      note: 'not_found means no allowed claim covers the sentence, not that it is false.'
        + (skipped.length ? ` ${skipped.length} allowed-claims page(s) were not used; skipped names each and why.` : '')
        + (pages.length >= MAX_ALLOWED_PAGES ? ` Only the ${MAX_ALLOWED_PAGES} newest allowed-claims pages were read, so an older one may be missing.` : ''),
    };
  },
  scope: 'read',
  cliHints: { hidden: true },
};

export const claimsOperations: Operation[] = [check_claims];
