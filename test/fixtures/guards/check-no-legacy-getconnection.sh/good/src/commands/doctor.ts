// Guard self-test fixture (known-GOOD): the grandfathered doctor façade stays ALLOWED.
declare const db: { getConnection: () => unknown };
export function probe(): unknown {
  return db.getConnection();
}
