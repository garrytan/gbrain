/**
 * Remote writes over the served wire (multi-user lane L3, design item approved 2026-11-26, approach (a)): an
 * agent-facing (remote) caller of a served client sends a write as one whole operation (`runOperation`), never as single
 * engine members, and only the operations of one closed list cross.
 *
 * 1. Protects: the closed list lives in one constant; every listed operation is a registered write operation that is
 *    not local-only, and names the served parity file that proves it, which must be a `served` row of the served set.
 *    One named exception: request_tools, a read-scope operation marked `mutating` that crosses only in its persist form
 *    (`{surface}` without `tools`, for a caller grant with an OAuth client id); its other forms run on the client.
 * 2. Fails on: an operation added to the list with no served parity proof, a read or local-only operation on the list
 *    other than the named exception, a proof file missing from the served set, a parameter form on an operation that is
 *    not listed, or a request_tools form other than the persist form crossing.
 * 3. Seam: none; the constant, the operation registry and the manifest as they are.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REMOTE_WHOLE_OPERATIONS, REMOTE_WHOLE_PARAM_FORMS, remoteWholeOperationForm } from '../src/core/rust-engine/served/remote-whole-ops.ts';
import { operationsByName } from '../src/core/operations.ts';

const ROOT = join(import.meta.dir, '..');
const served = new Set(readFileSync(join(ROOT, 'test/engine-parity/rust-served-set.tsv'), 'utf8').split('\n')
  .filter(line => line.split('\t')[1] === 'served').map(line => line.split('\t')[0]));

describe('the closed list of remote whole operations', () => {
  test('put_page is on it', () => {
    expect(Object.hasOwn(REMOTE_WHOLE_OPERATIONS, 'put_page')).toBe(true);
  });

  // The named exception: a read-scope operation that writes in one parameter form only (Operation.mutating).
  const READ_SCOPE_WRITERS = ['request_tools'];

  test('every listed operation is a registered write operation that is not CLI-only; only takes_remove is local-only', () => {
    const bad = Object.keys(REMOTE_WHOLE_OPERATIONS).filter(name => {
      const op = operationsByName[name];
      if (!op || op.cliOnly !== undefined) return true;
      return READ_SCOPE_WRITERS.includes(name) ? op.scope !== 'read' || op.mutating !== true : op.scope !== 'write';
    });
    expect(bad).toEqual([]);
    // A local-only operation is refused for every remote MCP caller by the dispatch; it is listed only for the in-process path.
    expect(Object.keys(REMOTE_WHOLE_OPERATIONS).filter(name => operationsByName[name]?.localOnly === true)).toEqual(['takes_remove']);
  });

  test('every listed operation names a served parity file that is a served row of the served set', () => {
    const missing = Object.entries(REMOTE_WHOLE_OPERATIONS).filter(([, file]) => !served.has(file)).map(([name, file]) => `${name} -> ${file}`);
    expect(missing).toEqual([]);
  });

  test('the named exception is listed, and only it crosses in one parameter form', () => {
    expect(READ_SCOPE_WRITERS.filter(name => !Object.hasOwn(REMOTE_WHOLE_OPERATIONS, name))).toEqual([]);
    expect(Object.keys(REMOTE_WHOLE_PARAM_FORMS)).toEqual(READ_SCOPE_WRITERS);
  });

  test('request_tools crosses only as a persist for an OAuth client; the listing, descriptor, combined and stdio forms stay on the client', () => {
    const grant = { clientId: 'c', scopes: ['read'] };
    expect({
      persist: remoteWholeOperationForm('request_tools', { surface: 'starter' }, grant),
      noClient: remoteWholeOperationForm('request_tools', { surface: 'starter' }, { scopes: ['read'] }),
      noGrant: remoteWholeOperationForm('request_tools', { surface: 'starter' }, null),
      listing: remoteWholeOperationForm('request_tools', {}, grant),
      descriptor: remoteWholeOperationForm('request_tools', { tools: ['get_page'] }, grant),
      combined: remoteWholeOperationForm('request_tools', { surface: 'starter', tools: ['get_page'] }, grant),
      notAnObject: remoteWholeOperationForm('request_tools', ['starter'], grant),
      putPage: remoteWholeOperationForm('put_page', { slug: 'a' }, null),
      offList: remoteWholeOperationForm('set_config', { key: 'k' }, grant),
    }).toEqual({ persist: true, noClient: false, noGrant: false, listing: false, descriptor: false, combined: false, notAnObject: false, putPage: true, offList: false });
  });
});
