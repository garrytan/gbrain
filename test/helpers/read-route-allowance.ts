/** The read-route allowance of test/engine-parity/raw-sql.test.ts, kept here so its negative case can run without a database. */
/**
 * Write members whose first step is a typed READ on this trunk (master reads the same values through raw SQL, which the probe
 * below does not record). Each read runs on `preparationRead` and returns before the write, which runs in its own transaction
 * (or the caller's) and never on a read route. The allowance is these three members on that one route and nothing else.
 */
const READS_FIRST: ReadonlyMap<string, string> = new Map([
  // invalidateStaleSignatureEmbeddings reads getConfigValues for the active embedding column, then updates in its transaction.
  ['invalidateStaleSignatureEmbeddings', 'preparationRead'],
  // invalidateContentDriftEmbeddings reads getConfigValues for the active embedding column, then updates in its transaction.
  ['invalidateContentDriftEmbeddings', 'preparationRead'],
  // restorePage reads listRevivalPages through assertRevivalUnclaimed (origin-guard.ts), then restores in the same transaction.
  ['restorePage', 'preparationRead'],
]);
/** The write members the probe saw enter a read route that no locking read or READS_FIRST entry explains: `name -> route`. */
export const unexplainedReadRoutes = (entered: ReadonlyArray<readonly [string, string]>): string[] =>
  entered.filter(([name, route]) => !route.endsWith('(unbounded)') && READS_FIRST.get(name) !== route).map(([name, route]) => `${name} -> ${route}`);
