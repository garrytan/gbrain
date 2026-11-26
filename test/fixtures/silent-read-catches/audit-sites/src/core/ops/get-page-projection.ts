// @ts-nocheck
// Pinned audit sites: code copied verbatim from src/core/ops/get-page-projection.ts at origin/master 7ef3d53a47 (parsed by the guard test, never run).
// The test asserts each catch below is counted under the path#function key that scripts/silent-read-catches-baseline.tsv uses.

// verbatim src/core/ops/get-page-projection.ts:211-221
export async function pageTrustForRead(ctx: Pick<OperationContext, 'engine' | 'auth'>, page: Pick<Page, 'id'>, minTrust: unknown):
  Promise<{ trust: TrustFields; eligibility: ReadEligibility } | null> {
  const eligibility = await resolveReadEligibility(ctx, { minTrust });
  const trust = (await loadPageTrust(ctx.engine, [{ page_id: page.id, slug: '' }]).catch(() => null))?.byId.get(page.id)
    ?? { trust_tier: 'unknown' as const, origin: 'unrecorded' };
  if (eligibility.floor && !admitsTrust(trust.trust_tier, eligibility.floor)) return null;
  const [hidden] = await ctx.engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM pages p WHERE p.id = $1 AND NOT ${rederiveHiddenSql('pages', 'p')}`, [page.id]);
  if (Number(hidden?.n) > 0) return null;
  return { trust, eligibility };
}
