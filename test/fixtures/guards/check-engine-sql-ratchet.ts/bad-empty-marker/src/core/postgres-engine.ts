// Guard self-test fixture (known-GOOD): baselined SQL member, marked member, prose that is not SQL.
export class PostgresEngine {
  getPage(): string {
    return `SELECT slug, title FROM pages WHERE slug = $1`;
  }

  // engine-sql-ok: fixture exemption with a reason
  lockSchema(): string {
    return "SELECT pg_advisory_lock(42)";
  }

  hint(): string {
    // SELECT slug FROM pages in a comment never counts
    return "Select a file from the list";
  }

  evict(): never {
    throw new Error("could not delete from cache");
  }
}
