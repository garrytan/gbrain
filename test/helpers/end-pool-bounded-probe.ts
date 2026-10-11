/**
 * #5332 probe child: awaits endPoolBounded against a pool whose end() never
 * settles and reports when the await came back. Spawned by
 * test/postgres-disconnect-bounded.test.ts. No top-level await on purpose:
 * the only thing keeping this process alive is the guard timer itself, so a
 * runtime that drops an unref'd timer exits before the line below is printed
 * (and `bun test` on Windows parked on it forever).
 */
import { endPoolBounded } from '../../src/core/db.ts';

const t0 = Date.now();
void endPoolBounded({ end: () => new Promise<void>(() => { /* never settles */ }) })
  .then(() => console.log(`settled ${Date.now() - t0}`));
