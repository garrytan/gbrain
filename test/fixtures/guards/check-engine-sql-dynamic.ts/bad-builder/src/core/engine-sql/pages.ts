// Guard self-test fixture (known-BAD): a builder that is not in VETTED_BUILDERS.
import { unvettedFilter } from "./builders.ts";
import { sqlFragment, trustedSql } from "./fragment.ts";

export function listPages() {
  return sqlFragment`SELECT slug FROM pages p WHERE ${trustedSql(unvettedFilter("p"))}`;
}
