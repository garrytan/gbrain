/**
 * The attendance lookup of frontmatter link extraction (src/core/link-extraction.ts `makeResolver` `resolveAttendance`):
 * the live person pages of a source an attendee name can mean. The statement is the caller's, byte for byte, and both
 * SQL engines run it through their own `executeRaw`. The Rust store serves the same member
 * (rust/crates/gbrain-store/src/meeting_pages.rs).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/**
 * At most two slugs of live `person` pages of the source whose slug is one of `slugs`, whose title is `name` under
 * `lower()`, or whose frontmatter `aliases` array holds `name` under `lower()`, in no set order. The caller resolves a
 * name only when exactly one page matches.
 */
export async function listAttendanceMatches(raw: Raw, sourceId: string, slugs: readonly string[], name: string): Promise<string[]> {
  const matches = await raw.executeRaw<{ slug: string }>(`SELECT slug FROM pages
        WHERE source_id=$1 AND deleted_at IS NULL AND type='person'
          AND (slug=ANY($2::text[]) OR lower(title)=lower($3)
            OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(frontmatter->'aliases')='array'
              THEN frontmatter->'aliases' ELSE '[]'::jsonb END) alias WHERE lower(alias)=lower($3))) LIMIT 2`,
  [sourceId, [...slugs], name]);
  return matches.map(row => row.slug);
}
