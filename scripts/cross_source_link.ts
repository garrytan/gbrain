/**
 * Cross-source orphan archive linking sprint.
 *
 * Links no-inbound pages in default/curated/zeus sources to the appropriate
 * archive hub page in the default source. Uses the engine's addLinksBatch so
 * we can thread explicit from_source_id / to_source_id; the `gbrain link` CLI
 * currently resolves both endpoints in source=default and fails for curated/zeus.
 */

import { readFileSync } from 'node:fs';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { connectWithRetry } from '../src/core/db.ts';
import type { LinkBatchInput } from '../src/core/engine.ts';

const SOURCES = [
  { sourceId: 'default', file: '/tmp/default_orphans.json' },
  { sourceId: 'curated', file: '/tmp/curated_orphans.json' },
  { sourceId: 'zeus', file: '/tmp/zeus_orphans.json' },
] as const;

const DOMAIN_HUB: Record<string, string> = {
  atoms: 'hubs/atoms-archive',
  wiki: 'hubs/wiki-archive',
  decisions: 'hubs/decisions-archive',
  _bundle: 'hubs/bundle-archive',
  knowledge: 'hubs/knowledge-archive',
};

const DEFAULT_HUB = 'hubs/misc-archive';

function parseJsonFile(path: string): { orphans: { slug: string; title: string; domain: string }[] } {
  const raw = readFileSync(path, 'utf-8');
  // gbrain orphans --json prefixes progress lines like "[orphans.scan] start".
  const clean = raw
    .split('\n')
    .filter(line => !line.trim().startsWith('['))
    .join('\n');
  return JSON.parse(clean);
}

async function main() {
  const config = loadConfig();
  if (!config) {
    throw new Error('No gbrain config found; run `gbrain init` first.');
  }

  const engine = await createEngine(toEngineConfig(config));
  await connectWithRetry(engine, toEngineConfig(config), { noRetry: true });

  const rows: LinkBatchInput[] = [];
  const summary: Record<string, { total: number; inserted: number; missing: string[] }> = {};

  for (const { sourceId, file } of SOURCES) {
    const data = parseJsonFile(file);
    const orphans = data.orphans || [];
    const batch: LinkBatchInput[] = [];

    for (const o of orphans) {
      const hub = DOMAIN_HUB[o.domain] || DEFAULT_HUB;
      batch.push({
        from_slug: hub,
        to_slug: o.slug,
        context: `Archive inbound link for ${o.domain} orphan (${sourceId})`,
        link_source: 'orphan-archive-sprint',
        from_source_id: 'default',
        to_source_id: sourceId,
      });
    }

    rows.push(...batch);
    summary[sourceId] = { total: batch.length, inserted: 0, missing: [] };

    if (batch.length === 0) continue;

    const inserted = await engine.addLinksBatch(batch, { auditSite: 'orphan-archive-sprint' });
    summary[sourceId].inserted = inserted;

    if (inserted < batch.length) {
      // Batch insert silently skips rows whose from/to page does not exist.
      // Surface the slugs we could not link.
      // (We re-query existence rather than guessing which side was missing.)
      const expected = new Set(batch.map(b => b.to_slug));
      for (const slug of expected) {
        try {
          const page = await engine.getPage(slug, { sourceId });
          if (!page) summary[sourceId].missing.push(slug);
        } catch {
          summary[sourceId].missing.push(slug);
        }
      }
    }
  }

  const totalInserted = Object.values(summary).reduce((n, s) => n + s.inserted, 0);

  console.log(JSON.stringify({
    totalRows: rows.length,
    totalInserted,
    summary,
  }, null, 2));

  await engine.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
