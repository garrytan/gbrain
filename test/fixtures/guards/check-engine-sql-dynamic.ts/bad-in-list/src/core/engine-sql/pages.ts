// Guard self-test fixture (known-BAD): an expanded IN (...) list.
import type { Db } from "./builders.ts";

export function getPages(db: Db, ids: number[]) {
  return db.query(`SELECT slug FROM pages WHERE id IN (${ids.join(",")})`);
}
