/**
 * Dream-cycle `infer_links` phase: opportunistic typed-edge inference.
 *
 * Symptom this fixes: 24,809 of 35,958 pages (69%) are orphans with link
 * coverage 7.5% because importers (calendar-to-brain, linkedin-export,
 * email-to-brain, monday-crm-sync) write structured frontmatter
 * (email, current_company, at_company, hash_owner) as plain strings,
 * never wrapped in [[wikilinks]]. `extract_links` doesn't see them; the
 * graph stays disconnected.
 *
 * Approach: scan each page; if it has a recognizable structured field
 * pointing at an entity slug, AND no existing [[companies/...]] or
 * [[people/...]] reference, AND the target slug exists, write back the
 * field with a wikilink wrap. Pure schema-discipline reconciler; never
 * creates stub pages (importers own entity creation).
 *
 * Phase contract:
 *   - status 'ok' on every successful run (including zero matches)
 *   - status 'fail' on DB/IO error with PhaseError populated
 *   - dryRun honored: counts what would change, never writes
 *   - idempotent: re-running over an already-wrapped page is a no-op
 *   - soft-delete defensive: `deleted_at IS NULL` filter on every read
 *   - pool-friendly: 100-page batches, yieldDuringPhase between batches
 *
 * Totals contributed to CycleReport via extractTotals (cycle.ts):
 *   links_inferred, links_unresolved
 *
 * NOT in scope (deferred):
 *   - freeform body text parsing → dream synthesize phase
 *   - auto-stub creation for missing target slugs
 *   - deals/email-* zombie cleanup (orthogonal find_orphans bug)
 */

import type { BrainEngine } from '../../engine.ts';
import type { PhaseResult } from '../../cycle.ts';

export interface InferLinksPhaseOpts {
  dryRun?: boolean;
  /** In-phase keepalive callback. Awaited between batches. */
  yieldDuringPhase?: () => Promise<void>;
  /** Pages per batch. Default 100. Bounded to avoid pool saturation. */
  batchSize?: number;
  /** Max pages to process per phase invocation. Default 1000. */
  maxPagesPerRun?: number;
  /** Override generic-email-domain skip set (for tests). */
  genericDomainsOverride?: ReadonlySet<string>;
}

/**
 * Email domains that point at no specific company. Personal mail providers
 * only. NOT a denylist for outbound mail — only for inference: an
 * `@gmail.com` address tells us nothing about the person's employer.
 *
 * Keep this list small and conservative. If in doubt, do NOT infer.
 */
const DEFAULT_GENERIC_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'fastmail.com',
  'fastmail.fm',
  'pm.me',
  'duck.com',
  'live.com',
  'msn.com',
]);

/**
 * Email/domain string → `companies/<slug>` slug. Returns null if generic
 * or unresolvable. Exported so importers (recipes) can share the rule.
 */
export function domainToCompanySlug(
  emailOrDomain: string,
  genericDomains: ReadonlySet<string> = DEFAULT_GENERIC_DOMAINS,
): string | null {
  if (!emailOrDomain) return null;
  const lower = emailOrDomain.toLowerCase().trim();
  const atIdx = lower.lastIndexOf('@');
  let domain = atIdx >= 0 ? lower.slice(atIdx + 1) : lower;
  domain = domain.replace(/^[\s<>]+|[\s<>]+$/g, '');
  if (!domain || !domain.includes('.')) return null;

  if (genericDomains.has(domain)) return null;

  // Strip subdomain prefix for slug derivation. mail.stripe.com → stripe.com.
  const parts = domain.split('.');
  // Compound country TLDs: .com.ky, .co.uk, .co.jp, .com.au etc.
  // The label immediately before the compound suffix is the company name.
  const compoundTlds = new Set(['com.ky', 'co.uk', 'co.jp', 'com.au', 'co.nz', 'co.za']);
  const lastTwo = parts.slice(-2).join('.');
  let coreParts: string[];
  if (compoundTlds.has(lastTwo)) {
    coreParts = parts.slice(0, -2);
  } else {
    coreParts = parts.slice(0, -1);
  }
  if (coreParts.length === 0) return null;

  // Take the LAST core part as the company label (strips subdomains).
  const label = coreParts[coreParts.length - 1];
  if (!label) return null;
  if (genericDomains.has(`${label}.com`)) return null;

  const slug = label.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return null;
  return `companies/${slug}`;
}

/**
 * Plain company name (e.g., "Sober Grid") → `companies/<slug>`. Used for
 * `current_company:` / `at_company:` fields that hold display strings
 * rather than email domains.
 */
export function companyNameToSlug(name: string): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return null;
  return `companies/${slug}`;
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

function alreadyHasCompanyLink(page: { compiled_truth?: string | null; frontmatter?: Record<string, unknown> | null }): boolean {
  const body = page.compiled_truth ?? '';
  if (body.match(/\[\[companies\//)) return true;
  const fm = page.frontmatter ?? {};
  for (const v of Object.values(fm)) {
    if (typeof v === 'string' && v.includes('[[companies/')) return true;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && item.includes('[[companies/')) return true;
      }
    }
  }
  return false;
}

function valueIsAlreadyWikilink(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  return /\[\[[^\]]+\]\]/.test(v);
}

export async function runPhaseInferLinks(
  engine: BrainEngine,
  opts: InferLinksPhaseOpts = {},
): Promise<PhaseResult> {
  const dryRun = opts.dryRun === true;
  const batchSize = opts.batchSize ?? 100;
  const maxPagesPerRun = opts.maxPagesPerRun ?? 1000;
  const genericDomains = opts.genericDomainsOverride ?? DEFAULT_GENERIC_DOMAINS;

  let linksInferred = 0;
  let linksUnresolved = 0;
  let pagesScanned = 0;
  let pagesUpdated = 0;

  // Pull candidate pages: people/* or companies/* with structured fields
  // that could yield links but currently have no companies/people wikilink.
  // Soft-delete defensive filter on every read.
  let candidates: Array<{
    id: number;
    slug: string;
    frontmatter: Record<string, unknown> | null;
    compiled_truth: string | null;
  }>;
  try {
    candidates = await engine.executeRaw(`
      SELECT id, slug, frontmatter, compiled_truth
      FROM pages
      WHERE deleted_at IS NULL
        AND (slug LIKE 'people/%' OR slug LIKE 'companies/%')
        AND frontmatter IS NOT NULL
        AND (
          frontmatter ? 'email'
          OR frontmatter ? 'current_company'
          OR frontmatter ? 'at_company'
          OR frontmatter ? 'company'
          OR frontmatter ? 'companies'
          OR frontmatter ? 'hash_owner'
          OR frontmatter ? 'firm'
          OR frontmatter ? 'firms'
        )
      LIMIT ${maxPagesPerRun}
    `);
  } catch (err) {
    return {
      phase: 'infer_links',
      status: 'fail',
      duration_ms: 0,
      summary: 'failed to scan candidate pages',
      details: { error: err instanceof Error ? err.message : String(err) },
      error: {
        class: 'InferLinksScanFailed',
        code: 'infer_links_scan_failed',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  for (let i = 0; i < candidates.length; i += batchSize) {
    if (opts.yieldDuringPhase) {
      try { await opts.yieldDuringPhase(); } catch { /* keepalive errors non-fatal */ }
    }
    const batch = candidates.slice(i, i + batchSize);

    for (const page of batch) {
      pagesScanned += 1;
      // Per-field idempotency is gated below via valueIsAlreadyWikilink +
      // email_domain-exists checks. We deliberately don't short-circuit
      // pages that have ANY wikilink already, because partial-state pages
      // (one field wrapped, another not) need the unwrapped fields fixed.

      const fm = page.frontmatter ?? {};
      const updates: Record<string, string> = {};
      const fieldsTouched: string[] = [];

      // email → companies/<domain>. Skip if email_domain already set
      // (idempotent re-runs must be no-ops).
      const emailVal = fm.email;
      const existingEmailDomain = fm.email_domain;
      if (
        typeof emailVal === 'string'
        && !valueIsAlreadyWikilink(emailVal)
        && existingEmailDomain === undefined
      ) {
        const slug = domainToCompanySlug(emailVal, genericDomains);
        if (slug) {
          const exists = await targetExists(engine, slug);
          if (exists) {
            // Keep email as a plain string (it's a value, not a slug ref);
            // emit a separate `email_domain:` field with the wikilink wrap.
            updates['email_domain'] = JSON.stringify(`[[${slug}]]`);
            fieldsTouched.push('email_domain');
            linksInferred += 1;
          } else {
            linksUnresolved += 1;
          }
        }
      }

      // current_company / at_company / company / firm — display name strings
      for (const key of ['current_company', 'at_company', 'company', 'firm']) {
        const val = fm[key];
        if (typeof val !== 'string' || !val.trim() || valueIsAlreadyWikilink(val)) continue;
        const slug = companyNameToSlug(val);
        if (!slug) continue;
        const exists = await targetExists(engine, slug);
        if (exists) {
          updates[key] = JSON.stringify(`[[${slug}]]`);
          fieldsTouched.push(key);
          linksInferred += 1;
        } else {
          linksUnresolved += 1;
        }
      }

      // companies / firms — array of display names. Wrap each resolvable
      // entry; leave unresolved items as plain strings so the cohort surfaces
      // honestly in links_unresolved instead of silently dropping.
      for (const key of ['companies', 'firms']) {
        const val = fm[key];
        if (!Array.isArray(val) || val.length === 0) continue;
        // Skip if every entry is already a wikilink string.
        const anyUnwrapped = val.some(
          (item) => typeof item === 'string' && item.trim() && !valueIsAlreadyWikilink(item),
        );
        if (!anyUnwrapped) continue;
        const wrapped: string[] = [];
        let touchedThisKey = false;
        for (const item of val) {
          if (typeof item !== 'string' || !item.trim()) {
            wrapped.push(typeof item === 'string' ? item : String(item));
            continue;
          }
          if (valueIsAlreadyWikilink(item)) {
            wrapped.push(item);
            continue;
          }
          // Heuristic: if the entry already looks like a slug shape
          // ("hash-directors"), prepend companies/ before resolving;
          // otherwise treat it as a display name.
          const looksLikeSlug = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/i.test(item.trim()) && item.includes('-');
          const slug = looksLikeSlug
            ? `companies/${item.trim().toLowerCase()}`
            : companyNameToSlug(item);
          if (!slug) {
            wrapped.push(item);
            continue;
          }
          const exists = await targetExists(engine, slug);
          if (exists) {
            wrapped.push(`[[${slug}]]`);
            touchedThisKey = true;
            linksInferred += 1;
          } else {
            wrapped.push(item);
            linksUnresolved += 1;
          }
        }
        if (touchedThisKey) {
          // jsonb_set on an array requires a JSON-encoded array literal;
          // we serialize and use jsonb (not text) cast below.
          updates[key] = JSON.stringify(wrapped);
          fieldsTouched.push(key);
        }
      }

      // hash_owner — points at a person slug, not a company
      const ownerVal = fm.hash_owner;
      if (typeof ownerVal === 'string' && ownerVal.trim() && !valueIsAlreadyWikilink(ownerVal)) {
        const personSlug = `people/${ownerVal.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`;
        const exists = await targetExists(engine, personSlug);
        if (exists) {
          updates['hash_owner'] = JSON.stringify(`[[${personSlug}]]`);
          fieldsTouched.push('hash_owner');
          linksInferred += 1;
        } else {
          linksUnresolved += 1;
        }
      }

      if (Object.keys(updates).length === 0) continue;
      if (dryRun) {
        pagesUpdated += 1;
        continue;
      }

      // Merge updates into frontmatter and persist via jsonb_set chain.
      // We update one key at a time to avoid clobbering concurrent writes
      // to unrelated keys. Values are JSON-encoded so both strings and
      // arrays land with the right JSONB type (jsonb_set + ::jsonb cast).
      try {
        for (const [k, v] of Object.entries(updates)) {
          // v is either a JSON-encoded string ("\"[[companies/foo]]\"")
          // or a JSON-encoded array ("[\"[[companies/foo]]\",\"Bar\"]").
          await engine.executeRaw(
            `UPDATE pages
               SET frontmatter = jsonb_set(COALESCE(frontmatter, '{}'::jsonb), $2, $3::jsonb, true)
             WHERE id = $1
               AND deleted_at IS NULL`,
            [page.id, `{${k}}`, v],
          );
        }
        pagesUpdated += 1;
      } catch (err) {
        // Per-page failure is non-fatal; record and continue. The next
        // tick will retry idempotently because the page still lacks the
        // wikilink wrap.
        linksUnresolved += fieldsTouched.length;
      }
    }
  }

  return {
    phase: 'infer_links',
    status: 'ok',
    duration_ms: 0,
    summary: dryRun
      ? `(dry-run) would wrap ${linksInferred} typed edges across ${pagesUpdated}/${pagesScanned} pages; ${linksUnresolved} unresolved targets`
      : `wrapped ${linksInferred} typed edges across ${pagesUpdated}/${pagesScanned} pages; ${linksUnresolved} unresolved targets`,
    details: {
      dryRun,
      links_inferred: linksInferred,
      links_unresolved: linksUnresolved,
      pages_scanned: pagesScanned,
      pages_updated: pagesUpdated,
    },
  };
}

async function targetExists(engine: BrainEngine, slug: string): Promise<boolean> {
  try {
    const rows = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = $1 AND deleted_at IS NULL LIMIT 1`,
      [slug],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}
