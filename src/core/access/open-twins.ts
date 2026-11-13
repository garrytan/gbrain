/**
 * GST-2603: labels and folder rules apply per source, so a page labelled or ruled in one source leaves a live row with the
 * same slug in another source as it was, and a reader with no source filter still finds that row. `openTwins` lists, for
 * the pages a preview changes, those rows a caller outside the change could still read: a row that is not private by its
 * own labels (privateSnapshotFilterFragment; lineage is not read, so a plan that reads no links still reads none) and that the empty identity or an enabled member outside `readers` passes by its own readers and
 * folder rules (readersAllowedSql, folderRulesAllowedSql). Read-only and bounded; it lists and never approves, so no
 * preview hash covers it.
 */
import type { BrainEngine } from '../engine.ts';
import { folderAccessFor } from './caller.ts';
import { listMembers } from './members.ts';
import { identityFor, normalizePrincipal } from './principals.ts';
import { folderRulesAllowedSql, privateSnapshotFilterFragment, readersAllowedSql } from '../search/private-visibility.ts';

/** The pages of one preview checked for twins, and the twins listed. */
export const OPEN_TWINS_PAGES = 1000;
export const OPEN_TWINS_LISTED = 50;
export interface OpenTwins { count: number; twins: Array<{ source_id: string; slug: string; twin_of: string }>; commands: string[] }

/** `readers`: who the change leaves reading (bare member ids or principals); `cover(source, slugs)`: the command giving one source's listed twins the same change. */
export async function openTwins(engine: BrainEngine, pages: ReadonlyArray<{ source_id: string; slug: string }>, readers: readonly string[],
  cover: (sourceId: string, slugs: string[]) => string): Promise<OpenTwins> {
  const window = pages.slice(0, OPEN_TWINS_PAGES);
  if (!window.length) return { count: 0, twins: [], commands: [] };
  const inside = new Set<string | null>(readers.map(normalizePrincipal));
  const outside = [[], ...(await listMembers(engine)).filter(member => member.status === 'enabled')
    .map(member => identityFor(member.id, member.groups)).filter(identity => !identity.some(principal => inside.has(principal)))];
  const readable = await Promise.all(outside.map(async identity =>
    `(${readersAllowedSql('t', identity)} AND ${folderRulesAllowedSql('t', identity.length ? (await folderAccessFor(engine, identity)).satisfiedRuleIds : [])})`));
  const rows = await engine.executeRaw<{ source_id: string; slug: string; twin_of: string; n: number }>(`SELECT t.source_id, t.slug, min(c.source_id) AS twin_of,
      count(*) OVER ()::int AS n FROM unnest($1::text[], $2::text[]) AS c(source_id, slug)
    JOIN pages t ON t.slug = c.slug AND t.source_id <> c.source_id AND t.deleted_at IS NULL
    WHERE NOT EXISTS (SELECT 1 FROM unnest($1::text[], $2::text[]) AS w(source_id, slug) WHERE w.source_id = t.source_id AND w.slug = t.slug)
      AND ${privateSnapshotFilterFragment('t')} AND (${readable.join(' OR ')})
    GROUP BY t.source_id, t.slug ORDER BY t.source_id, t.slug LIMIT ${OPEN_TWINS_LISTED}`, [window.map(page => page.source_id), window.map(page => page.slug)]);
  const twins = rows.map(({ source_id, slug, twin_of }) => ({ source_id, slug, twin_of: `${twin_of}:${slug}` }));
  const sources = [...new Set(twins.map(twin => twin.source_id))];
  return { count: Number(rows[0]?.n ?? 0), twins, commands: sources.map(source => cover(source, twins.filter(twin => twin.source_id === source).map(twin => twin.slug))) };
}

/** The preview warning for open twins; none when there are none. */
export function openTwinsWarning(found: OpenTwins): string[] {
  return found.count ? [`${found.count} live page(s) in other sources share a slug with a page this changes and stay readable by callers outside the change, `
    + `because labels and rules apply per source. details.open_twins lists them; to cover them, run: ${found.commands.join('; ')}`] : [];
}

/** The text lines of a preview's open twins. */
export function openTwinsLines(found: OpenTwins | undefined): string[] {
  return found?.count ? [`  open twins: ${found.count}`, ...found.twins.map(twin => `  open twin ${twin.source_id}:${twin.slug} (twin of ${twin.twin_of})`),
    ...found.commands.map(command => `  cover: ${command}`)] : [];
}
