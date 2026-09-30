// Guard self-test fixture (known-BAD): a value concatenated into SQL text.
import type { Db } from "./builders.ts";

export function getPage(db: Db, slug: string) {
  return db.query("SELECT slug FROM pages WHERE slug = '" + slug + "'");
}
