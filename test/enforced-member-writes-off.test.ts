/**
 * GST-2675: the brain setting access.enforced_member_writes, read by enforcedWritesRefused (src/cli/enforced-member.ts).
 *
 * 1. Protects: under enforced member mode a write refuses unless the brain's config says checked (or holds no value),
 *    and a config read that fails refuses too.
 * 2. Fails when: a failed config read, an unknown value or refuse lets a member write through.
 * 3. Existing coverage: test/enforced-member.serial.test.ts (every write as a real subprocess with the key set).
 * 4. Real seams: the engine's getConfig, faked here so the read can fail.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { ENFORCED_MEMBER_WRITES_KEY, enforcedWritesRefused } from '../src/cli/enforced-member.ts';

const engineWith = (getConfig: (key: string) => Promise<string | null>) => ({ getConfig }) as unknown as BrainEngine;

describe('enforcedWritesRefused', () => {
  test('reads access.enforced_member_writes from the brain config', async () => {
    const seen: string[] = [];
    await enforcedWritesRefused(engineWith(async key => { seen.push(key); return null; }));
    expect({ key: ENFORCED_MEMBER_WRITES_KEY, seen }).toEqual({ key: 'access.enforced_member_writes', seen: ['access.enforced_member_writes'] });
  });

  test('unset and checked allow checked writes; refuse, any other value and a failed read refuse', async () => {
    const cases: Array<[string, () => Promise<string | null>, boolean]> = [
      ['unset', async () => null, false],
      ['checked', async () => 'checked', false],
      ['refuse', async () => 'refuse', true],
      ['unknown value', async () => 'chekced', true],
      ['empty value', async () => '', true],
      ['read fails', async () => { throw new Error('connection lost'); }, true],
    ];
    for (const [name, read, refused] of cases) expect({ name, refused: await enforcedWritesRefused(engineWith(read)) }).toEqual({ name, refused });
  });
});
