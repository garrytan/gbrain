import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

try {
  const db = await PGlite.create({
    dataDir: '/root/.gbrain/brain.pglite',
    extensions: { vector, pg_trgm }
  });

  const orphansRes = await db.query(`
    SELECT id, slug, title, type FROM pages p
    WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id)
  `);

  console.log("=== EXACT ORPHAN PAGES ===");
  console.log(`Found ${orphansRes.rows.length} orphan pages.`);

  // Group by type
  const grouped = {};
  for (const row of orphansRes.rows) {
    grouped[row.type] = grouped[row.type] || [];
    grouped[row.type].push(row);
  }

  for (const [type, list] of Object.entries(grouped)) {
    console.log(`\n--- Type: ${type} (${list.length}) ---`);
    for (const item of list.slice(0, 10)) {
      console.log(`  - ${item.title} (slug: ${item.slug})`);
    }
    if (list.length > 10) {
      console.log(`  ... and ${list.length - 10} more`);
    }
  }

  await db.close();
} catch (e) {
  console.error("Error:", e);
}
