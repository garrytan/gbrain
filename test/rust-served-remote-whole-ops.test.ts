/**
 * Remote writes over the served wire (multi-user lane L3, design item approved 2026-11-26, approach (a)): an
 * agent-facing (remote) caller of a served client sends a write as one whole operation (`runOperation`), never as single
 * engine members, and only the operations of one closed list cross.
 *
 * 1. Protects: the closed list lives in one constant; every listed operation is a registered write operation that is
 *    not local-only, and names the served parity file that proves it, which must be a `served` row of the served set.
 * 2. Fails on: an operation added to the list with no served parity proof, a read or local-only operation on the list,
 *    a proof file missing from the served set.
 * 3. Seam: none; the constant, the operation registry and the manifest as they are.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REMOTE_WHOLE_OPERATIONS } from '../src/core/rust-engine/served/remote-whole-ops.ts';
import { operationsByName } from '../src/core/operations.ts';

const ROOT = join(import.meta.dir, '..');
const served = new Set(readFileSync(join(ROOT, 'test/engine-parity/rust-served-set.tsv'), 'utf8').split('\n')
  .filter(line => line.split('\t')[1] === 'served').map(line => line.split('\t')[0]));

describe('the closed list of remote whole operations', () => {
  test('put_page is on it', () => {
    expect(Object.hasOwn(REMOTE_WHOLE_OPERATIONS, 'put_page')).toBe(true);
  });

  test('every listed operation is a registered write operation that is not CLI-only; only takes_remove is local-only', () => {
    const bad = Object.keys(REMOTE_WHOLE_OPERATIONS).filter(name => {
      const op = operationsByName[name];
      return !op || op.scope !== 'write' || op.cliOnly !== undefined;
    });
    expect(bad).toEqual([]);
    // A local-only operation is refused for every remote MCP caller by the dispatch; it is listed only for the in-process path.
    expect(Object.keys(REMOTE_WHOLE_OPERATIONS).filter(name => operationsByName[name]?.localOnly === true)).toEqual(['takes_remove']);
  });

  test('every listed operation names a served parity file that is a served row of the served set', () => {
    const missing = Object.entries(REMOTE_WHOLE_OPERATIONS).filter(([, file]) => !served.has(file)).map(([name, file]) => `${name} -> ${file}`);
    expect(missing).toEqual([]);
  });
});
