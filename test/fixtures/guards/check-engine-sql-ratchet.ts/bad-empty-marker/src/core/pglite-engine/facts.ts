// Guard self-test fixture (known-BAD): an engine-sql-ok marker without a reason.
// engine-sql-ok:
export function deleteFact(): string {
  return "DELETE FROM facts WHERE id = $1";
}
