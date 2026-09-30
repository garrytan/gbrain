// Guard self-test fixture (known-BAD): a raw string spliced through trustedSql.
import { sqlFragment, trustedSql } from "./fragment.ts";

export function listPages(orderBy: string) {
  return sqlFragment`SELECT slug FROM pages ORDER BY ${trustedSql(orderBy)}`;
}
