// Guard self-test fixture (known-BAD): a new SQL-bearing engine function with no row or marker.
export function insertFact(table: string): string {
  return `INSERT INTO ${table} (fact) VALUES ($1)`;
}
