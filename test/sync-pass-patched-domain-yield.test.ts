/**
 * GBRA-133 PR 2b (search during a sync): a confirm round patches the level's origin domain at the slots the pass wrote
 * (sync-pass-narrow.ts `patchedDomain`). After a first sync that is every page, and the patch ran with no yield at all:
 * at 10k pages it held timers for 0.9-1.4 s at the end of the sync while concurrent searches waited. Its loops now yield
 * as a full build's do.
 *
 * Forced probe (deterministic): every 20th origin key costs 4 ms of thread CPU (`keyOf`, a seam the input supplies), and
 * a confirm round patches all 4,000 pages (about 800 ms of keys). Without yields that is one stretch; with them, none
 * passes the bound, and the patch equals the full build.
 */
import { expect } from 'bun:test';
import { domainCache, levelDomain, type DomainInput } from '../src/core/persistence/sync-pass-narrow.ts';
import { PageTable } from '../src/core/persistence/sync-pass.ts';
import type { GitTreeEntry } from '../src/core/persistence/sync-git-stream.ts';
import { loopYield } from '../src/core/persistence/sync-yield.ts';
import { spinCpuMs, watchLoopLag } from './helpers/cpu-time.ts';
import { isolatedTest } from './helpers/isolated-test.ts';

const MAX_LAG_MS = 100;
const PAGES = 4_000;
/** Thread CPU clocks tick in about 4 ms steps, so the cost comes in 4 ms pieces. */
const KEY_CPU_MS = 4, KEY_COST_EVERY = 20;

isolatedTest(import.meta.path, 'a confirm round that patches every page yields; no stretch passes the bound and the patch equals a full build', async () => {
  const tree = new Map<string, GitTreeEntry>(), pages = new PageTable({ name: 'markdown', version: 1 } as never);
  for (let i = 0; i < PAGES; i++) {
    const path = `notes/n${i}.md`;
    tree.set(path, { mode: '100644', oid: i.toString(16).padStart(40, '0') });
    pages.id.push(i + 1); pages.slug.push(`notes/n${i}`); pages.sourcePath.push(path); pages.revision.push('1');
    pages.requestId.push(null); pages.bits.push(0); pages.blobOid.push(undefined); pages.fullEpisode.push(null);
  }
  let costly = false;
  const keyOf = (row: number) => { if (costly && row % KEY_COST_EVERY === 0) spinCpuMs(KEY_CPU_MS); return pages.sourcePath[row]!; };
  const input = (prior?: DomainInput['prior']): DomainInput => ({ pages, tree, keyOf, inLevel: () => true, extra: [], markerPaths: [],
    isFile: () => true, originOf: path => path, step: loopYield(), ...(prior ? { prior } : {}) });
  const full = await levelDomain(input());
  const expected = { domain: [...full.domain].sort(), byOrigin: [...full.byOrigin].sort() };
  costly = true;
  const lag = watchLoopLag({ reportAtMs: MAX_LAG_MS });
  let patched: Awaited<ReturnType<typeof levelDomain>>, maxLag = 0;
  try { patched = await levelDomain(input({ cache: domainCache(full, 'tree'), changed: { rewritten: [], from: 0 }, oldKey: sourcePath => sourcePath })); }
  finally { ({ maxLag } = lag.stop()); }
  expect(patched!.touched!.size).toBe(PAGES);
  expect({ domain: [...patched!.domain].sort(), byOrigin: [...patched!.byOrigin].sort() }).toEqual(expected);
  expect(Math.round(maxLag)).toBeLessThan(MAX_LAG_MS);
}, 60_000);
