/**
 * google/provenance: which pages came from Google, derived from source ids.
 * Every page of a source whose config has `kind: google` came from that
 * source's account (`g_account`); its service is read from the frontmatter
 * google-render.ts writes (`thread_id` / `event_id` / `google_contact_id`),
 * then the page type (email, meeting, person). No page is rewritten. Sources
 * are listed through the engine (archived ones included, since their pages
 * still came from Google) and parsed with parseSourceConfig, so every stored
 * config shape is read the same way on PGLite and Postgres; pages are one read
 * keyed by source id. Live pages only (soft-deleted pages are excluded).
 */
import type { BrainEngine } from '../engine.ts';
import { parseSourceConfig } from '../sources-load.ts';

export type GoogleProvenanceKind = 'gmail' | 'calendar' | 'contacts' | 'other';

export interface GoogleProvenance {
  source_id: string;
  slug: string;
  provider: 'google';
  account: string;
  kind: GoogleProvenanceKind;
}

export async function listGoogleProvenance(engine: BrainEngine, opts: { account?: string; sourceId?: string } = {}): Promise<GoogleProvenance[]> {
  const account = opts.account?.trim().toLowerCase();
  const accounts = new Map<string, string>();
  for (const src of await engine.listAllSources({ includeArchived: true })) {
    const config = parseSourceConfig(src.config);
    if (config.kind !== 'google' || (opts.sourceId && src.id !== opts.sourceId)) continue;
    const owner = typeof config.g_account === 'string' ? config.g_account.trim().toLowerCase() : '';
    if (account && owner !== account) continue;
    accounts.set(src.id, owner);
  }
  if (accounts.size === 0) return [];
  const rows = await engine.executeRaw<{ source_id: string; slug: string; kind: GoogleProvenanceKind }>(
    `SELECT source_id, slug,
            CASE WHEN frontmatter ? 'thread_id' OR type = 'email' THEN 'gmail'
                 WHEN frontmatter ? 'event_id' OR type = 'meeting' THEN 'calendar'
                 WHEN frontmatter ? 'google_contact_id' OR type = 'person' THEN 'contacts'
                 ELSE 'other' END AS kind
       FROM pages
      WHERE source_id = ANY($1::text[]) AND deleted_at IS NULL
      ORDER BY source_id, slug`,
    [[...accounts.keys()]],
  );
  return rows.map((r) => ({ source_id: r.source_id, slug: r.slug, provider: 'google', account: accounts.get(r.source_id) ?? '', kind: r.kind }));
}
