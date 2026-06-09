#!/usr/bin/env bun

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import postgres from 'postgres';
import { slugifyPath } from '../src/core/sync.ts';

function usage(): never {
  console.error('Usage: GBRAIN_DATABASE_URL=postgres://... bun run scripts/rockaway-prune-index.ts <mirror-dir>');
  process.exit(64);
}

function collectMarkdownSlugs(root: string): string[] {
  const slugs: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const st = statSync(path);
      if (st.isDirectory()) {
        walk(path);
      } else if (st.isFile() && /\.mdx?$/i.test(path)) {
        slugs.push(slugifyPath(relative(root, path)));
      }
    }
  }

  walk(root);
  return slugs.sort();
}

const root = process.argv[2];
const databaseUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
if (!root || !databaseUrl) usage();

const slugs = collectMarkdownSlugs(root);
if (slugs.length === 0) {
  console.error(`[rockaway-prune-index] refusing to prune: no markdown files found in ${root}`);
  process.exit(1);
}

const sql = postgres(databaseUrl, {
  max: 1,
  idle_timeout: 5,
  connect_timeout: 10,
  prepare: false,
});

try {
  const before = await sql`SELECT COUNT(*)::int AS n FROM pages`;
  const deleted = await sql`
    DELETE FROM pages
    WHERE source_id = 'default'
      AND slug NOT IN ${sql(slugs)}
    RETURNING slug
  `;
  const after = await sql`SELECT COUNT(*)::int AS n FROM pages`;
  console.log(JSON.stringify({
    status: 'ok',
    mirror_root: root,
    mirror_slugs: slugs.length,
    before: before[0]?.n ?? null,
    deleted: deleted.length,
    after: after[0]?.n ?? null,
  }));
} finally {
  await sql.end();
}
