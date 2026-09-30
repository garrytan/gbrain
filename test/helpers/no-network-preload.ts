/**
 * Child-process preload for W0 doctor goldens: every `fetch` is refused and
 * its URL appended to `$GBRAIN_TEST_NET_LOG`, so a golden run can prove no
 * check reached the network (and never depends on it). Loaded with
 * `bun --preload` by test/helpers/doctor-json-golden.ts; never a bunfig preload.
 */
import { appendFileSync } from 'node:fs';

const log = process.env.GBRAIN_TEST_NET_LOG;

globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String((input as Request)?.url ?? input);
  if (log) appendFileSync(log, `${url}\n`);
  throw new Error('network disabled by no-network-preload');
}) as unknown as typeof fetch;
