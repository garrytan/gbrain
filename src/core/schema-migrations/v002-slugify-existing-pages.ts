import type { Migration } from './types.ts';
import { slugifyPath } from '../sync.ts';

// Version 1 is the baseline (schema.sql creates everything with IF NOT EXISTS).
export const v002: Migration = {
  version: 2,
  name: 'slugify_existing_pages',
  sql: '',
  handler: async (engine) => {
    const pages = await engine.listPages();
    let renamed = 0;
    for (const page of pages) {
      const newSlug = slugifyPath(page.slug);
      if (newSlug !== page.slug) {
        try {
          await engine.updateSlug(page.slug, newSlug);
          await engine.rewriteLinks(page.slug, newSlug);
          renamed++;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`  Warning: could not rename "${page.slug}" → "${newSlug}": ${msg}`);
        }
      }
    }
    // Migration progress goes to stderr — stdout must stay clean for
    // callers parsing JSON (e.g. `gbrain doctor --json | jq`); migrations
    // can run lazily inside ANY command's first DB connect.
    if (renamed > 0) process.stderr.write(`  Renamed ${renamed} slugs\n`);
  },
};
