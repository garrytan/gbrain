/**
 * GST-3058: the brain owner's wider remote reads (CallerAccess.ownerReads, read through ownerWidened()) are off unless
 * dispatch switches them on for a direct remote call from an owner-bound credential with no room declared. Every other
 * context (agent jobs, on-behalf-of audiences, stdio, attested actors) then reads as before without anyone having to
 * remember it. This census fails when a second site sets the flag.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('census: only dispatch switches the owner widening on', () => {
  const grep = (args: string[]) => Bun.spawnSync(['git', 'grep', ...args, '--', 'src'], { cwd: join(import.meta.dir, '..') }).stdout.toString().trim().split('\n');
  expect(grep(['-l', '-E', 'ownerReads\\??:']).sort()).toEqual(['src/core/search/private-visibility.ts', 'src/mcp/dispatch.ts']);
  expect(grep(['-c', '-E', 'ownerReads\\??:'])).toEqual(expect.arrayContaining(['src/core/search/private-visibility.ts:2', 'src/mcp/dispatch.ts:1']));
  expect(grep(['-c', 'ownerReads: true'])).toEqual(['src/mcp/dispatch.ts:1']);
});
