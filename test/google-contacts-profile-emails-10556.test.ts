import { describe, expect, test } from 'bun:test';

import { PeopleClient, type FetchImpl } from '../src/core/google/google-clients.ts';

const src = (type: string) => ({ source: { type } });

describe('contacts linked to a Workspace account (#10556)', () => {
  test('a contact keeps its own addresses, not the linked account\'s', async () => {
    const fetchImpl: FetchImpl = async () =>
      new Response(JSON.stringify({
        connections: [
          {
            resourceName: 'people/c1',
            emailAddresses: [
              { value: 'bob@example.com', metadata: src('CONTACT') },
              { value: 'Alice@example.com', metadata: { primary: true, ...src('DOMAIN_PROFILE') } },
              { value: 'bob@example.com', metadata: src('DOMAIN_PROFILE') },
            ],
          },
          {
            resourceName: 'people/c2',
            emailAddresses: [
              { value: 'alice@example.com', metadata: { primary: true, ...src('DOMAIN_PROFILE') } },
              { value: 'bob@example.com', metadata: src('DOMAIN_PROFILE') },
            ],
          },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    const tokens = { getAccessToken: async () => 't', forceRefresh: async () => 't' } as never;
    const people = new PeopleClient(tokens, fetchImpl, () => {}, '123-abc.apps.googleusercontent.com');
    const outcome = await people.listConnections({}).then((r) => r, (e) => ({ error: String(e) }));
    expect('contacts' in outcome).toBe(true);
    if (!('contacts' in outcome)) return;
    expect(outcome.contacts[0].emails).toEqual(['bob@example.com']);
    // no card address at all: fall back to the profile's primary address
    expect(outcome.contacts[1].emails).toEqual(['alice@example.com']);
  });
});
