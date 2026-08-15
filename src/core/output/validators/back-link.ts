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
    const federatedSourceIds = ctx.sourceIds && ctx.sourceIds.length > 0
      ? ctx.sourceIds
      : undefined;
    const outboundOpts = federatedSourceIds
      ? { sourceIds: federatedSourceIds }
      : ctx.sourceId
        ? { sourceId: ctx.sourceId }
        : undefined;

    const outbound = await ctx.engine.getLinks(ctx.slug, outboundOpts);
    if (outbound.length === 0) return findings;

    // A federated lookup can return same-slug origins and targets from several
    // sources. Deduplicate only identical endpoint pairs; every distinct origin
    // still needs its own exact reverse.
    const uniqueEdges = new Map<string, typeof outbound[number]>();
    for (const link of outbound) {
      uniqueEdges.set(
        `${link.from_source_id}\0${link.from_slug}\0${link.to_source_id}\0${link.to_slug}`,
        link,
      );
    }

    for (const target of uniqueEdges.values()) {
      const targetOpts = federatedSourceIds
        ? { sourceIds: federatedSourceIds }
        : { sourceId: target.to_source_id };
      const targetOutbound = await ctx.engine.getLinks(target.to_slug, targetOpts);
      const hasReverse = targetOutbound.some(link =>
        link.from_source_id === target.to_source_id
        && link.from_slug === target.to_slug
        && link.to_source_id === target.from_source_id
        && link.to_slug === target.from_slug
      );
      if (!hasReverse) {
        findings.push({
          slug: ctx.slug,
          validator: 'back-link',
          severity: 'warning',
          message: `Outbound link to ${target.to_slug} has no back-link (${target.to_slug} does not reference ${ctx.slug}). runAutoLink should reconcile this on next put_page; flag for inspection.`,
        });
      }
    }

    return findings;
  },
};
