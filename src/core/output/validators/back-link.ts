/**
 * back-link validator — every outbound link has a reverse back-link.
 *
 * The Iron Law: if page A mentions page B, page B must link back to A.
 *
 * After v0.12.0 shipped auto-link + runAutoLink reconciliation, the graph
 * layer creates the forward edges automatically on put_page. This validator
 * catches the MINORITY case where:
 *   - A page has a link that runAutoLink didn't extract (unusual phrasing)
 *   - A bulk edit to timeline forgot to back-link the mentioned entity
 *   - A manual page edit added a brand-new wikilink between commits
 *
 * It reads engine.getLinks(slug) and verifies each (slug → target) has a
 * matching (target → slug) via engine.getBacklinks(target). Missing reverses
 * are warnings (lint mode), not errors — runAutoLink is the authoritative
 * enforcer at write time; this is defense-in-depth.
 */

import type { PageValidator, PageValidationContext, ValidationFinding } from '../writer.ts';

export const backLinkValidator: PageValidator = {
  id: 'back-link',

  async validate(ctx: PageValidationContext): Promise<ValidationFinding[]> {
    const findings: ValidationFinding[] = [];

    const outbound = await ctx.engine.getLinks(ctx.slug);
    if (outbound.length === 0) return findings;

    // Iron Law: if ctx.slug → target, target must ALSO link back to ctx.slug.
    // We check target's outbound links; if none of them point at ctx.slug,
    // the back-link is missing.
    const uniqueTargets = new Set<string>();
    for (const link of outbound) uniqueTargets.add(link.to_slug);

    for (const target of uniqueTargets) {
      const targetOutbound = await ctx.engine.getLinks(target);
      const hasReverse = targetOutbound.some(l => l.to_slug === ctx.slug);
      if (!hasReverse) {
        findings.push({
          slug: ctx.slug,
          validator: 'back-link',
          severity: 'warning',
          message: `Outbound link to ${target} has no back-link (${target} does not reference ${ctx.slug}). runAutoLink should reconcile this on next put_page; flag for inspection.`,
        });
      }
    }

    return findings;
  },
};
