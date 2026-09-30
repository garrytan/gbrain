// Guard self-test fixture (known-BAD): a hand-written $1 inside a composed template.
import type { Db } from "./builders.ts";

const COLUMNS = "slug, title";

export function getPage(db: Db, slug: string) {
  return db.query(`SELECT ${COLUMNS} FROM pages WHERE slug = $1`, [slug]);
}
