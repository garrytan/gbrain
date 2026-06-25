import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOutlook } from '../src/commands/outlook.ts';
import {
  DEFAULT_OUTLOOK_CLIENT_ID,
  DEFAULT_OUTLOOK_TENANT_ID,
  loadOutlookToken,
  resolveOutlookAppConfig,
  scanOutlook,
} from '../src/core/outlook-collector.ts';
import { withEnv } from './helpers/with-env.ts';

describe('outlook collector strict scan', () => {
  test('keeps direct, active, calendar-linked business mail and skips marketing/no-reply', () => {
    const summary = scanOutlook({
      selfDomains: ['example-user.com'],
      knownDomains: ['partner-example.com'],
      contacts: [
        {
          id: 'c1',
          displayName: 'Person One',
          companyName: 'Partner Example',
          emailAddresses: [{ name: 'Person One', address: 'person.one@partner-example.com' }],
        },
      ],
      events: [
        {
          id: 'event-1',
          subject: 'Follow-up meeting',
          start: { dateTime: '2026-06-22T15:00:00Z' },
          attendees: [
            { emailAddress: { name: 'Person One', address: 'person.one@partner-example.com' } },
            { emailAddress: { name: 'The User', address: 'me@example-user.com' } },
          ],
        },
      ],
      messages: [
        {
          id: 'm1',
          conversationId: 'thread-1',
          subject: 'Re: Proposal timing',
          receivedDateTime: '2026-06-22T12:00:00Z',
          from: { emailAddress: { name: 'Person One', address: 'person.one@partner-example.com' } },
          toRecipients: [{ emailAddress: { name: 'The User', address: 'me@example-user.com' } }],
          bodyPreview: 'Here is the revised timing.',
        },
        {
          id: 'm2',
          conversationId: 'thread-1',
          subject: 'Proposal timing',
          receivedDateTime: '2026-06-21T12:00:00Z',
          from: { emailAddress: { name: 'Person One', address: 'person.one@partner-example.com' } },
          toRecipients: [{ emailAddress: { name: 'The User', address: 'me@example-user.com' } }],
          bodyPreview: 'Can we discuss timing?',
        },
        {
          id: 'm3',
          conversationId: 'thread-2',
          subject: 'June newsletter sale',
          receivedDateTime: '2026-06-20T12:00:00Z',
          from: { emailAddress: { name: 'Marketing', address: 'newsletter@vendor-example.com' } },
          toRecipients: [{ emailAddress: { name: 'The User', address: 'me@example-user.com' } }],
          bodyPreview: 'Unsubscribe for fewer promotions.',
        },
      ],
    });

    expect(summary.skipped_spam_newsletters).toBe(1);
    expect(summary.people_detected).toBe(1);
    expect(summary.threads_worth_saving).toBe(1);
    expect(summary.people[0]?.email).toBe('person.one@partner-example.com');
    expect(summary.people[0]?.reasons).toContain('calendar-linked person');
    expect(summary.threads[0]?.messageCount).toBe(2);
  });

  test('skips obvious cold spam from unknown domains', () => {
    const summary = scanOutlook({
      selfDomains: ['example-user.com'],
      messages: [
        {
          id: 'm1',
          conversationId: 'cold-1',
          subject: 'Cold outreach promotion',
          receivedDateTime: '2026-06-22T12:00:00Z',
          from: { emailAddress: { name: 'Cold Sender', address: 'sender@unknown-example.com' } },
          toRecipients: [{ emailAddress: { name: 'The User', address: 'me@example-user.com' } }],
          bodyPreview: 'Limited time webinar. Unsubscribe here.',
        },
      ],
      events: [],
      contacts: [],
    });

    expect(summary.people_detected).toBe(0);
    expect(summary.threads_worth_saving).toBe(0);
    expect(summary.skipped_spam_newsletters).toBe(1);
  });

  test('does not treat every addressed message as direct when self domain is unknown', () => {
    const summary = scanOutlook({
      messages: [
        {
          id: 'm1',
          conversationId: 'unknown-direct',
          subject: 'Quick question',
          receivedDateTime: '2026-06-22T12:00:00Z',
          from: { emailAddress: { name: 'Sender Example', address: 'sender@unknown-example.com' } },
          toRecipients: [{ emailAddress: { name: 'The User', address: 'me@example-user.com' } }],
          bodyPreview: 'Can we talk next week?',
        },
      ],
      events: [],
      contacts: [],
    });

    expect(summary.people_detected).toBe(0);
    expect(summary.threads_worth_saving).toBe(0);
    expect(summary.skipped_spam_newsletters).toBe(1);
  });

  test('uses exact self email rather than hiding everyone on a shared provider', () => {
    const summary = scanOutlook({
      selfEmails: ['me@outlook.com'],
      selfDomains: [],
      messages: [
        {
          id: 'm1',
          conversationId: 'shared-provider',
          subject: 'Re: Intro',
          receivedDateTime: '2026-06-22T12:00:00Z',
          from: { emailAddress: { name: 'Person Two', address: 'person.two@outlook.com' } },
          toRecipients: [{ emailAddress: { name: 'The User', address: 'me@outlook.com' } }],
          bodyPreview: 'Thanks for the intro.',
        },
        {
          id: 'm2',
          conversationId: 'self-sent',
          subject: 'Note to self',
          receivedDateTime: '2026-06-22T13:00:00Z',
          from: { emailAddress: { name: 'The User', address: 'me@outlook.com' } },
          toRecipients: [{ emailAddress: { name: 'Person Two', address: 'person.two@outlook.com' } }],
          bodyPreview: 'This should not become a person page.',
        },
      ],
      events: [],
      contacts: [],
    });

    expect(summary.people_detected).toBe(1);
    expect(summary.people[0]?.email).toBe('person.two@outlook.com');
    expect(summary.skipped_spam_newsletters).toBe(1);
  });

  test('keeps a one-off direct email from a human sender', () => {
    const summary = scanOutlook({
      selfEmails: ['me@example-user.com'],
      messages: [
        {
          id: 'm1',
          conversationId: 'human-direct-1',
          subject: 'Quick intro',
          receivedDateTime: '2026-06-22T12:00:00Z',
          from: { emailAddress: { name: 'Jane Smith', address: 'jane@indieco.com' } },
          toRecipients: [{ emailAddress: { name: 'The User', address: 'me@example-user.com' } }],
          bodyPreview: 'Wanted to make an introduction.',
        },
      ],
      events: [],
      contacts: [],
    });

    expect(summary.people_detected).toBe(1);
    expect(summary.people[0]?.email).toBe('jane@indieco.com');
    expect(summary.people[0]?.reasons).toContain('direct human email');
    expect(summary.skipped_spam_newsletters).toBe(0);
  });

  test('does not bake user Microsoft app ids into source defaults', () => {
    expect(DEFAULT_OUTLOOK_CLIENT_ID).toBe('');
    expect(DEFAULT_OUTLOOK_TENANT_ID).toBe('');
    expect(resolveOutlookAppConfig({
      env: {
        GBRAIN_OUTLOOK_CLIENT_ID: 'client-from-env',
        GBRAIN_OUTLOOK_TENANT_ID: 'tenant-from-env',
      },
    })).toEqual({
      clientId: 'client-from-env',
      tenantId: 'tenant-from-env',
    });
    expect(resolveOutlookAppConfig({
      clientId: 'client-from-cli',
      tenantId: 'tenant-from-cli',
      env: {
        GBRAIN_OUTLOOK_CLIENT_ID: 'client-from-env',
        GBRAIN_OUTLOOK_TENANT_ID: 'tenant-from-env',
      },
    })).toEqual({
      clientId: 'client-from-cli',
      tenantId: 'tenant-from-cli',
    });
  });

  test('skips do-not-reply senders', () => {
    const summary = scanOutlook({
      selfEmails: ['me@example-user.com'],
      messages: [
        {
          id: 'm1',
          conversationId: 'machine-1',
          subject: 'Security alert',
          receivedDateTime: '2026-06-22T12:00:00Z',
          from: { emailAddress: { name: 'System Mail', address: 'do-not-reply@security-example.com' } },
          toRecipients: [{ emailAddress: { name: 'The User', address: 'me@example-user.com' } }],
          bodyPreview: 'Automated delivery.',
        },
      ],
      events: [],
      contacts: [],
    });

    expect(summary.people_detected).toBe(0);
    expect(summary.skipped_spam_newsletters).toBe(1);
  });

  test('scan dry-run never calls the writer', async () => {
    let printed = false;
    let wrote = false;

    await runOutlook({} as never, ['scan', '--dry-run'], {
      loadToken: async () => ({
        token_type: 'Bearer',
        access_token: 'token',
        expires_at: Date.now() + 60_000,
      }),
      fetchInput: async () => ({
        messages: [],
        events: [],
        contacts: [],
        selfEmails: [],
        selfDomains: [],
      }),
      scan: () => ({
        kept: 0,
        skipped_spam_newsletters: 0,
        people_detected: 0,
        threads_worth_saving: 0,
        people: [],
        companies: [],
        threads: [],
        meetings: [],
      }),
      writeScan: async () => {
        wrote = true;
        return { written: 1, slugs: ['should-not-write'] };
      },
      printSummary: () => {
        printed = true;
      },
    });

    expect(printed).toBe(true);
    expect(wrote).toBe(false);
  });

  test('refreshes an expired cached token using app and tenant claims when config is absent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-outlook-token-'));
    try {
      const gbrainHome = join(home, '.gbrain');
      mkdirSync(gbrainHome, { recursive: true });
      writeFileSync(join(gbrainHome, 'outlook-token.json'), JSON.stringify({
        token_type: 'Bearer',
        access_token: fakeJwt({
          appid: 'client-from-token',
          tid: 'tenant-from-token',
        }),
        refresh_token: 'refresh-from-cache',
        expires_at: 0,
      }));

      let requestUrl = '';
      let requestBody = '';
      await withEnv({
        GBRAIN_HOME: home,
        GBRAIN_OUTLOOK_CLIENT_ID: undefined,
        GBRAIN_OUTLOOK_TENANT_ID: undefined,
      }, async () => {
        const token = await loadOutlookToken({
          now: () => 1_000_000,
          fetchImpl: async (url, init) => {
            requestUrl = String(url);
            requestBody = String(init?.body ?? '');
            return new Response(JSON.stringify({
              token_type: 'Bearer',
              access_token: 'new-access-token',
              expires_in: 3600,
            }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          },
        });

        expect(token.access_token).toBe('new-access-token');
      });

      expect(requestUrl).toContain('/tenant-from-token/oauth2/v2.0/token');
      const form = new URLSearchParams(requestBody);
      expect(form.get('client_id')).toBe('client-from-token');
      expect(form.get('refresh_token')).toBe('refresh-from-cache');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode(claims)}.`;
}
