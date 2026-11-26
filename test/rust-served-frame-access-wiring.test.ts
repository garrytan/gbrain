/**
 * Multi-user lane L4, audit row B3 part 3: the served session decides each frame's caller access record by its
 * principal (owner-ipc/frame-access.ts `frameAccessWire`) before the call reaches the owner's dispatcher, a
 * transaction or the request-id replay hash.
 *
 * 1. Protects: a served call never runs under an access record a client built for a principal that is not the brain
 *    owner. The owner's narrowing claim is unchanged (frameAccessWire returns it byte-identical).
 * 2. Fails when: session.ts stops resolving the frame's record before its transaction branch, its replay hash or its
 *    hand-off to the dispatcher, or AuthenticatedPrincipal loses the store-built record the decision reads.
 * 3. Seams: a source check, because until ruling A1 lifts the server admits only the owner's floor, so no running
 *    connection reaches the other branch; the branch itself is unit-tested in test/rust-owner-ipc-frame-access.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('the served session resolves each frame\'s access record by its principal (B3)', () => {
  const session = read('src/core/rust-engine/served/session.ts');
  const prepare = session.slice(session.indexOf('const prepareCall = async'), session.indexOf('// Returning callbacks and transactions over the wire'));

  test('prepareCall resolves the record once, before the transaction branch, the replay hash and the dispatcher', () => {
    const resolve = prepare.indexOf('access = frameAccessWire(principal!, access, member)');
    expect(resolve).toBeGreaterThan(0);
    expect(prepare.indexOf('restoreTail(access, tail)')).toBeLessThan(resolve);
    for (const later of ['if (frame.txn !== undefined)', "createHash('sha256')", 'side.admit(']) {
      const at = prepare.indexOf(later);
      expect({ later, after: at > resolve }).toEqual({ later, after: true });
    }
    // One resolution only, and the refusal answers the call before anything runs.
    expect(prepare.split('frameAccessWire(').length - 1).toBe(1);
    expect(session).toContain("import { frameAccessWire } from '../owner-ipc/frame-access.ts';");
  });

  test('an authenticated principal can carry the record the store built for it', () => {
    const auth = read('src/core/rust-engine/served/auth.ts');
    const shape = auth.slice(auth.indexOf('export interface AuthenticatedPrincipal'), auth.indexOf('export const LOCAL_OWNER'));
    expect(shape).toMatch(/\n\s+record\?: CallerAccess;/);
  });
});
