/**
 * Remote writes over the served wire (multi-user lane L3, design item approved 2026-11-26, approach (a)): an
 * agent-facing (remote) caller of a served client sends a write as one whole operation (`runOperation`), never as single
 * engine members, and only the operations of one closed list cross.
 *
 * 1. Protects: the closed list lives in one constant; every listed operation is a registered write operation that is
 *    not local-only, and names the served parity file that proves it, which must be a `served` row of the served set.
 *    One named exception: request_tools, a read-scope operation marked `mutating` that crosses only in its persist form
 *    (`{surface}` without `tools`, for a caller grant with an OAuth client id); its other forms run on the client.
 *    A guest note's attribution (the X-Gbrain-Guest header and request-level _meta.guest) crosses with the operation,
 *    so the brain server's guest admission reads what the caller sent; any other attribution shape is refused.
 * 2. Fails on: a page lifecycle write (put_page, delete_page, restore_page) left off the list, an operation added to
 *    the list with no served parity proof, a read or local-only operation on the list other than the named exception, a
 *    proof file missing from the served set, a parameter form on an operation that is not listed, or a request_tools
 *    form other than the persist form crossing, a remote put_page to a guest source that loses its attribution on the
 *    way (refused guest_attribution_missing on a served client), or an attribution carrying any other key.
 * 3. Seam: none; the constant, the operation registry and the manifest as they are.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REMOTE_WHOLE_OPERATIONS, REMOTE_WHOLE_PARAM_FORMS, claimedGuestChannels, remoteOperationContext, remoteWholeOperationForm } from '../src/core/rust-engine/served/remote-whole-ops.ts';
import { operationsByName } from '../src/core/operations.ts';

const ROOT = join(import.meta.dir, '..');
const served = new Set(readFileSync(join(ROOT, 'test/engine-parity/rust-served-set.tsv'), 'utf8').split('\n')
  .filter(line => line.split('\t')[1] === 'served').map(line => line.split('\t')[0]));

describe('the closed list of remote whole operations', () => {
  test('the page lifecycle writes are on it: put_page, delete_page and restore_page', () => {
    expect(['put_page', 'delete_page', 'restore_page'].filter(name => !Object.hasOwn(REMOTE_WHOLE_OPERATIONS, name))).toEqual([]);
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

describe('a guest note\'s attribution on a remote whole operation', () => {
  const putPage = operationsByName.put_page!;
  const grant = { auth: { scopes: ['read', 'write'] } };
  const header = 'sender_label=Bob%20Example&group=team-a';
  const meta = { guest: { sender_label: 'Bob Example', group: 'team-a' } };

  test('the brain server runs the operation with the X-Gbrain-Guest header and _meta.guest the caller sent', () => {
    const channels = { header, requestMeta: meta };
    expect(remoteOperationContext('put_page', putPage, { sourceId: 'guests', guestChannels: channels }, grant).guestChannels).toEqual(channels);
    expect(remoteOperationContext('put_page', putPage, { guestChannels: { requestMeta: meta } }, null).guestChannels).toEqual({ requestMeta: meta });
    expect(remoteOperationContext('put_page', putPage, { sourceId: 'guests' }, grant).guestChannels).toBeUndefined();
  });

  test('the client sends the header and _meta.guest alone: no other _meta key, and nothing when the call carries neither', () => {
    const sent = (guestChannels: unknown) => claimedGuestChannels({ guestChannels } as never);
    expect({
      both: sent({ header, requestMeta: { ...meta, progressToken: 1 } }),
      metaOnly: sent({ requestMeta: meta }),
      otherMetaOnly: sent({ requestMeta: { progressToken: 1 } }),
      undefinedGuest: sent({ requestMeta: { guest: undefined } }),
      none: sent(undefined),
    }).toEqual({ both: { header, requestMeta: meta }, metaOnly: { requestMeta: meta }, otherMetaOnly: undefined,
      undefinedGuest: { requestMeta: { guest: null } }, none: undefined });
  });

  test('any other shape is refused before the operation runs: another key, another _meta key, a header that is not text', () => {
    const refused = (guestChannels: unknown) => {
      try { remoteOperationContext('put_page', putPage, { guestChannels }, grant); return null; } catch (e) { return (e as { code?: string }).code; }
    };
    expect({
      notAnObject: refused('sender_label=Bob'),
      otherKey: refused({ header, principal: 'member:owner' }),
      otherMetaKey: refused({ requestMeta: { ...meta, progressToken: 1 } }),
      metaNotAnObject: refused({ requestMeta: [meta] }),
      headerNotText: refused({ header: 7 }),
    }).toEqual({ notAnObject: 'engine_capability_missing', otherKey: 'engine_capability_missing', otherMetaKey: 'engine_capability_missing', metaNotAnObject: 'engine_capability_missing', headerNotText: 'engine_capability_missing' });
  });
});
