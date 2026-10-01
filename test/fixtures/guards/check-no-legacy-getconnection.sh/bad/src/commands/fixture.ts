// Guard self-test fixture (known-BAD): a new command reaching the module singleton.
declare const db: { getConnection: () => unknown };
export function probe(): unknown {
  return db.getConnection();
}
