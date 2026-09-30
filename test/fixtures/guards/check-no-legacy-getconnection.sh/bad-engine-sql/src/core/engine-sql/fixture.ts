// Guard self-test fixture (known-BAD): the shared engine SQL dir (refactor wave 1) reaching the singleton.
declare const db: { getConnection: () => unknown };
export function probe(): unknown {
  return db.getConnection();
}
