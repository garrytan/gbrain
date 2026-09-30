// Guard self-test fixture (known-GOOD): every dynamic-SQL form the guard allows.
import { pageReadFilter, type Db } from "./builders.ts";
import { sqlFragment, trustedSql } from "./fragment.ts";

const ORDER_SQL = { recent: "updated_at DESC", slug: "slug ASC" } as const;
const PAGE_COLUMNS = "slug, title";

export function listPages(order: keyof typeof ORDER_SQL, sourceId: string, limit: number) {
  if (!Number.isFinite(limit)) throw new Error("limit must be finite");
  return sqlFragment`
    SELECT ${trustedSql(PAGE_COLUMNS)} FROM pages p
    WHERE p.source_id = ${sourceId} AND ${trustedSql(pageReadFilter("p"))}
    ORDER BY ${trustedSql(ORDER_SQL[order])}
    LIMIT ${trustedSql(`${limit}`)}`;
}

export function getPage(db: Db, slug: string) {
  return db.query("SELECT slug FROM pages WHERE slug = $1", [slug]);
}

export function countPages(db: Db, live: boolean) {
  const sql = `SELECT count(*) FROM pages ${live ? "WHERE deleted_at IS NULL" : ""}`;
  return db.query(sql);
}
