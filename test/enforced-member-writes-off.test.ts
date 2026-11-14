/**
 * GST-2675: the brain setting access.enforced_member_writes, read by enforcedWritesMode (src/cli/enforced-member.ts).
 *
 * 1. Protects: under enforced member mode writes stay checked only when the brain's config says checked (or holds no
 *    value); refuse_pages turns off page writes, and refuse, any other value and a failed config read turn off both
 *    page writes and named-path git commit-push.
 * 2. Fails when: a failed config read, an unknown value or refuse reads as anything less strict than refuse.
 * 3. Existing coverage: test/enforced-member.serial.test.ts (every write as a real subprocess with the key set).
 * 4. Real seams: the engine's getConfig, faked here so the read can fail.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { ENFORCED_MEMBER_WRITES_KEY, enforcedWritesMode, type EnforcedWritesMode } from '../src/cli/enforced-member.ts';

const engineWith = (getConfig: (key: string) => Promise<string | null>) => ({ getConfig }) as unknown as BrainEngine;

describe('enforcedWritesMode', () => {
  test('reads access.enforced_member_writes from the brain config', async () => {
    const seen: string[] = [];
    await enforcedWritesMode(engineWith(async key => { seen.push(key); return null; }));
    expect({ key: ENFORCED_MEMBER_WRITES_KEY, seen }).toEqual({ key: 'access.enforced_member_writes', seen: ['access.enforced_member_writes'] });
  });

  test('unset and checked keep writes checked; refuse_pages; refuse, any other value and a failed read are refuse', async () => {
    const cases: Array<[string, () => Promise<string | null>, EnforcedWritesMode]> = [
      ['unset', async () => null, 'checked'],
      ['checked', async () => 'checked', 'checked'],
      ['refuse_pages', async () => 'refuse_pages', 'refuse_pages'],
      ['refuse_pages, spaced and upper case', async () => ' REFUSE_PAGES ', 'refuse_pages'],
      ['refuse', async () => 'refuse', 'refuse'],
      ['unknown value', async () => 'chekced', 'refuse'],
      ['empty value', async () => '', 'refuse'],
      ['read fails', async () => { throw new Error('connection lost'); }, 'refuse'],
    ];
    for (const [name, read, mode] of cases) expect({ name, mode: await enforcedWritesMode(engineWith(read)) }).toEqual({ name, mode });
  });
});
