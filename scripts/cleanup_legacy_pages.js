import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { readdirSync, lstatSync, existsSync } from 'fs';
import { join, relative } from 'path';

const BRAIN_DIR = '/root/brain';

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'exports') continue;
    const full = join(dir, entry);
    try {
      if (lstatSync(full).isDirectory()) {
        walk(full, files);
      } else if (entry.endsWith('.md') && !entry.startsWith('_')) {
        files.push(full);
      }
    } catch { /* skip unreadable */ }
  }
  return files;
}

try {
  const db = await PGlite.create({
    dataDir: '/root/.gbrain/brain.pglite',
    extensions: { vector, pg_trgm }
  });

  // Get all files on disk and compute their expected slugs
  const diskFiles = walk(BRAIN_DIR);
  const diskSlugs = new Set();
  for (const file of diskFiles) {
    const rel = relative(BRAIN_DIR, file);
    const slug = rel.replace(/\.md$/, '').toLowerCase();
    diskSlugs.add(slug);
  }

  console.log(`Found ${diskSlugs.size} markdown files on disk.`);

  // Get all active pages in the DB
  const dbPagesRes = await db.query("SELECT id, slug, title, type FROM pages WHERE deleted_at IS NULL");
  console.log(`Found ${dbPagesRes.rows.length} active pages in the database.`);

  const toDelete = [];
  for (const row of dbPagesRes.rows) {
    if (!diskSlugs.has(row.slug)) {
      toDelete.push(row);
    }
  }

  console.log(`\n=== STALE PAGES IN DATABASE (${toDelete.length}) ===`);
  for (const row of toDelete) {
    console.log(`- [${row.type}] ${row.title} (slug: '${row.slug}', ID: ${row.id})`);
  }

  if (toDelete.length > 0) {
    console.log("\nDeleting stale pages from the database...");
    for (const row of toDelete) {
      await db.query("DELETE FROM pages WHERE id = $1", [row.id]);
    }
    console.log("Deletion complete!");
  } else {
    console.log("\nNo stale pages to delete.");
  }

  await db.close();
} catch (e) {
  console.error("Error during cleanup:", e);
}
