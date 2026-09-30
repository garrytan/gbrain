// Guard self-test fixture (known-BAD): a serve-http module (refactor wave 1) reaching the singleton.
declare const db: { getConnection: () => unknown };
export function probe(): unknown {
  return db.getConnection();
}
