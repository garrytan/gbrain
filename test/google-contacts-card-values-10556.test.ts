/**
 * #10556: in a Google Workspace domain, People `connections.list` returns a card's own values (source CONTACT) next to
 * every value on the Workspace account the card is linked to (DOMAIN_PROFILE / PROFILE / ACCOUNT), aliases included.
 * When Bob's old address is an alias on Alice's account, Bob's card came back with Alice's addresses, so two person
 * pages claimed alice@example.com and every meeting she attended was attendance-blocked. A contact keeps its card's
 * values, deduplicated; the linked account's primary address is kept only for a card with no address of its own.
 */
import { describe, expect, test } from 'bun:test';

import { PeopleClient } from '../src/core/google/google-clients.ts';
import { renderPersonPage } from '../src/core/google/google-render.ts';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const tokens = { getAccessToken: async () => 'token', forceRefresh: async () => 'token' };
const from = (type: string, primary = false) => ({ metadata: { ...(primary ? { primary: true } : {}), source: { type, id: 'synthetic' } } });

async function listed(connections: unknown[]) {
  const people = new PeopleClient(tokens, async () => json({ connections, nextSyncToken: 'ppl-1' }));
  return (await people.listConnections({})).contacts;
}

/** Alice's Workspace account: her primary address, an alias, and Bob's old address kept as an alias so his mail still reaches her. */
const aliceAccount = [
  { value: 'alice@example.com', ...from('DOMAIN_PROFILE', true) },
  { value: 'a.example@example.com', ...from('DOMAIN_PROFILE') },
  { value: 'bob@example.com', ...from('DOMAIN_PROFILE') },
];

describe('Google contacts keep the values on their own card (#10556)', () => {
  test('two cards linked to one Workspace account no longer claim each other\'s addresses', async () => {
    const [bob, alice] = await listed([
      { resourceName: 'people/c1', names: [{ displayName: 'Bob Example' }],
        emailAddresses: [{ value: 'bob@example.com', ...from('CONTACT', true) }, ...aliceAccount],
        phoneNumbers: [{ value: '+12025550101', ...from('CONTACT') }, { value: '+12025550199', ...from('DOMAIN_PROFILE') }] },
      { resourceName: 'people/c2', names: [{ displayName: 'Alice Example' }],
        emailAddresses: [{ value: 'Alice@Example.com ', ...from('CONTACT') }, ...aliceAccount] },
    ]);
    expect(bob!.emails).toEqual(['bob@example.com']);
    expect(bob!.phones).toEqual(['+12025550101']);
    expect(alice!.emails).toEqual(['alice@example.com']);
    const frontmatter = (c: typeof bob) => renderPersonPage(c!)!.markdown.split('\n---\n')[0]!;
    expect(frontmatter(bob)).not.toContain('alice@example.com');
    expect(frontmatter(alice)).not.toContain('bob@example.com');
  });

  test('a card address repeated by the linked account, or in another case, is listed once', async () => {
    const [c] = await listed([{ resourceName: 'people/c3', names: [{ displayName: 'Carol Example' }], emailAddresses: [
      { value: 'carol@example.com', ...from('CONTACT', true) }, { value: ' CAROL@example.com', ...from('CONTACT') },
      { value: 'carol@example.com', ...from('DOMAIN_PROFILE') }, { value: 'carol.work@example.com', ...from('OTHER_CONTACT') },
    ] }]);
    expect(c!.emails).toEqual(['carol@example.com', 'carol.work@example.com']);
  });

  test('a card with no address of its own keeps the linked account\'s primary address, else its first', async () => {
    const [primary, first, phoneOnly] = await listed([
      { resourceName: 'people/c4', names: [{ displayName: 'Alice Example' }], emailAddresses: [aliceAccount[2], aliceAccount[0]] },
      { resourceName: 'people/c5', names: [{ displayName: 'Dan Example' }],
        emailAddresses: [{ value: 'dan@example.com', ...from('PROFILE') }, { value: 'dan.alt@example.com', ...from('ACCOUNT') }] },
      { resourceName: 'people/c6', names: [{ displayName: 'Erin Example' }], emailAddresses: [{ value: 'erin@example.com', ...from('DOMAIN_PROFILE', true) }],
        phoneNumbers: [{ value: '+12025550102', ...from('CONTACT') }, { value: '+12025550103', ...from('DOMAIN_PROFILE') }] },
    ]);
    expect(primary!.emails).toEqual(['alice@example.com']);
    expect(first!.emails).toEqual(['dan@example.com']);
    expect(phoneOnly!.emails).toEqual(['erin@example.com']);
    expect(phoneOnly!.phones).toEqual(['+12025550102']);
  });

  test('a card with neither an address nor a phone of its own keeps the linked account\'s primary phone', async () => {
    const [c] = await listed([{ resourceName: 'people/c7', names: [{ displayName: 'Frank Example' }],
      phoneNumbers: [{ value: '+12025550104', ...from('DOMAIN_PROFILE') }, { value: '+12025550105', ...from('DOMAIN_PROFILE', true) }] }]);
    expect(c!.emails).toEqual([]);
    expect(c!.phones).toEqual(['+12025550105']);
  });

  test('entries without metadata (a personal account, an older response) are the card\'s own', async () => {
    const [c] = await listed([{ resourceName: 'people/c8', names: [{ displayName: 'Grace Example' }],
      emailAddresses: [{ value: 'grace@example.com' }, { value: 'grace@example.com' }, { value: 'grace.home@example.com', metadata: { primary: false } }],
      phoneNumbers: [{ value: '+12025550106' }] }]);
    expect(c!.emails).toEqual(['grace@example.com', 'grace.home@example.com']);
    expect(c!.phones).toEqual(['+12025550106']);
  });
});
