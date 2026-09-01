/**
 * Dense-hub graph fixture for the traversePaths row-cap tests (unit + parity).
 *
 * `cap/hub` has 200 inbound spokes (cap/s000..cap/s199 -> hub) and 200
 * outbound spokes (hub -> cap/s200..cap/s399). The 400 spokes also form a
 * ring where every spoke links to the next `ringOffsets` spokes, so a
 * `direction: 'both'` walk from the hub at depth 3 touches every edge at
 * every depth level: distinct (from, to, type, depth) keys =
 * 400 + 2 * (400 + 400 * ringOffsets). With the default 5 offsets that is
 * 5,200 deduped edges (> TRAVERSE_PATH_ROW_CAP) from ~49k raw CTE rows —
 * enough to overflow the cap on the DEDUPED count, so the pre-cap engine is
 * discriminable from the capped one by `paths.length` alone.
 *
 * Slugs share one prefix + zero-padded index so ORDER BY from_slug, to_slug
 * sorts identically under any collation (Postgres vs PGLite parity).
 */
import type { BrainEngine, LinkBatchInput } from '../../src/core/engine.ts';

export const DENSE_HUB_SLUG = 'cap/hub';
export const DENSE_HUB_SPOKES = 400;

export function denseHubSpoke(i: number): string {
  return `cap/s${String(i).padStart(3, '0')}`;
}

export async function seedDenseHub(engine: BrainEngine, ringOffsets = 5): Promise<{ edges: number }> {
  await engine.putPage(DENSE_HUB_SLUG, { type: 'note', title: 'Hub', compiled_truth: 'hub body', timeline: '' });
  for (let i = 0; i < DENSE_HUB_SPOKES; i++) {
    await engine.putPage(denseHubSpoke(i), { type: 'note', title: `Spoke ${i}`, compiled_truth: `spoke ${i}`, timeline: '' });
  }
  const links: LinkBatchInput[] = [];
  for (let i = 0; i < DENSE_HUB_SPOKES; i++) {
    const spoke = denseHubSpoke(i);
    if (i < DENSE_HUB_SPOKES / 2) {
      links.push({ from_slug: spoke, to_slug: DENSE_HUB_SLUG, link_type: 'inbound', context: 'in', link_source: 'manual' });
    } else {
      links.push({ from_slug: DENSE_HUB_SLUG, to_slug: spoke, link_type: 'outbound', context: 'out', link_source: 'manual' });
    }
    for (let k = 1; k <= ringOffsets; k++) {
      links.push({
        from_slug: spoke,
        to_slug: denseHubSpoke((i + k) % DENSE_HUB_SPOKES),
        link_type: 'ring',
        context: `ring+${k}`,
        link_source: 'manual',
      });
    }
  }
  for (let i = 0; i < links.length; i += 500) {
    await engine.addLinksBatch(links.slice(i, i + 500));
  }
  return { edges: links.length };
}
