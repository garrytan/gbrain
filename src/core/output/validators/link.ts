/**
 * link validator — brain-internal wikilinks point to pages that exist.
 *
 * Scans compiled_truth + timeline for `[text](path)` markdown links.
 * Classifies each:
 *   - External URL (http://, https://) → skipped; url_reachable resolver
 *     handles reachability on-demand, not pre-write.
 *   - Relative .md wikilink → resolved against brain via engine.getPage.
 *     Dangling links emit an error.
 *   - Anything else (mailto:, internal anchors) → warning.
 *
 * We strip leading "../" components so a link from a daily file written as
 * `../../people/alice.md` resolves to the `people/alice` slug the engine
 * knows. This matches how engine.addLink is called downstream.
 */

import type { PageValidator, PageValidationContext, ValidationFinding } from '../writer.ts';

const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

export const linkValidator: PageValidator = {
  id: 'link',

  async validate(ctx: PageValidationContext): Promise<ValidationFinding[]> {
    const findings: ValidationFinding[] = [];
    const body = `${ctx.compiledTruth}\n${ctx.timeline}`;

    // Collect unique internal targets first to batch engine lookups.
    const internalTargets = new Set<string>();
    const linkPositions = new Map<string, { display: string; raw: string; line: number }[]>();

    for (const { match, line } of iterateLinks(body)) {
      const [, display, href] = match;

      if (isExternalUrl(href)) continue;
      if (isNonBrainRef(href)) {
        findings.push({
          slug: ctx.slug,
          validator: 'link',
          severity: 'warning',
          line,
          message: `Non-brain link (mailto/anchor/scheme): ${truncate(href, 80)}`,
        });
        continue;
      }

      const slug = normalizeToSlug(href);
      if (!slug) {
        findings.push({
          slug: ctx.slug,
          validator: 'link',
          severity: 'warning',
          line,
          message: `Unresolvable link path: ${truncate(href, 80)}`,
        });
        continue;
      }

      internalTargets.add(slug);
      const list = linkPositions.get(slug) ?? [];
      list.push({ display, raw: href, line });
      linkPositions.set(slug, list);
    }

    // Batch-check which targets exist.
    for (const slug of internalTargets) {
      const page = await ctx.engine.getPage(slug);
      if (page) continue;
      const positions = linkPositions.get(slug) ?? [];
      for (const pos of positions) {
        findings.push({
          slug: ctx.slug,
          validator: 'link',
          severity: 'error',
          line: pos.line,
          message: `Dangling wikilink to ${slug} (no such page)`,
        });
      }
    }

    return findings;
  },
};

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

export function isExternalUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export function isNonBrainRef(href: string): boolean {
  return /^(mailto:|tel:|javascript:|data:|#)/i.test(href);
}

/**
 * Normalize a link href to a brain slug. Accepts:
 *   "people/alice-smith.md"
 *   "../people/alice-smith.md"
 *   "../../people/alice-smith.md"
 *   "/people/alice-smith.md"
 *   "people/alice-smith"   (no extension)
 * Returns null if the shape isn't slug-like.
 */
export function normalizeToSlug(href: string): string | null {
  let s = href.trim();
  // Strip repeated leading relative-path components (./, ../, multiple levels).
  while (/^\.\.?\/+/.test(s)) s = s.replace(/^\.\.?\/+/, '');
  // Strip leading slashes
  s = s.replace(/^\/+/g, '');
  // Strip trailing .md
  s = s.replace(/\.md$/i, '');
  // Must look like dir/name (or dir/name/subname)
  if (!/^[a-z0-9][a-z0-9\-]*(\/[a-z0-9][a-z0-9\-]*)+$/i.test(s)) return null;
  return s.toLowerCase();
}

/**
 * Iterate markdown links with 1-based line numbers. Skips links that appear
 * inside fenced code blocks — those are examples, not wikilinks.
 */
function* iterateLinks(body: string): IterableIterator<{ match: RegExpExecArray; line: number }> {
  const lines = body.split('\n');
  let insideFence = false;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (insideFence) {
      if (line.startsWith(fenceMarker)) insideFence = false;
      continue;
    }
    if (line.startsWith('```') || line.startsWith('~~~')) {
      insideFence = true;
      fenceMarker = line.startsWith('```') ? '```' : '~~~';
      continue;
    }
    // Strip inline code so `[x](y)` inside backticks doesn't get validated
    const cleanedLine = line.replace(/`[^`\n]*`/g, '');
    MD_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MD_LINK_RE.exec(cleanedLine)) !== null) {
      yield { match: m, line: i + 1 };
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}
