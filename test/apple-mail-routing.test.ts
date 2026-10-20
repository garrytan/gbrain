/**
 * apple-mail-routing — the pure classification of Mail accounts from PUBLIC metadata (id, server name, account type,
 * enabled) into Apple-eligible / Google / disabled / unknown, and the routing fingerprint. No Apple access, no I/O.
 * Placeholder hosts and ids only.
 */
import { describe, expect, test } from 'bun:test';
import {
  GOOGLE_MAIL_HOSTS, buildMailRouting, classifyMailAccount, describeUnknownRouting, mailRoutingFingerprint, normalizeMailHost,
  routingCoversAllAccounts, routingSummary,
} from '../src/core/apple/mail-routing.ts';
import type { AppleMailAccountMeta } from '../src/core/apple/mail-routing.ts';

const acct = (id: unknown, serverName: unknown, accountType: unknown = 'imap', enabled: unknown = true): AppleMailAccountMeta => ({ id, serverName, accountType, enabled });

describe('documented Google hosts', () => {
  test('the four documented Gmail / Google Workspace IMAP and POP hosts are Google, whatever the case, spacing or trailing dot', () => {
    expect([...GOOGLE_MAIL_HOSTS].sort()).toEqual(['imap.gmail.com', 'imap.googlemail.com', 'pop.gmail.com', 'pop.googlemail.com']);
    for (const host of [...GOOGLE_MAIL_HOSTS, 'IMAP.GMAIL.COM', ' imap.gmail.com ', 'imap.gmail.com.', 'Pop.GoogleMail.Com']) {
      for (const type of ['imap', 'pop']) expect(classifyMailAccount(acct('a1', host, type)).route).toBe('google');
    }
  });

  test('a Google Workspace account on a custom domain is recognised by its host alone: no address, name or domain is ever consulted', () => {
    // The metadata has no address field at all, so the custom domain (acme-example.com) cannot matter.
    const r = buildMailRouting([acct('workspace-1', 'imap.gmail.com'), acct('icloud-1', 'imap.example.com')]);
    expect(r.google).toEqual(['workspace-1']);
    expect(r.eligible.map((a) => a.id)).toEqual(['icloud-1']);
    expect(r.status).toBe('mixed');
  });

  test('a gmail.com ADDRESS on another provider is not Google: only the configured server counts', () => {
    // The account metadata a gmail.com address would live in (emailAddresses) is never part of the input.
    const c = classifyMailAccount(acct('fwd-1', 'imap.example.org'));
    expect(c.route).toBe('apple_eligible');
    expect(buildMailRouting([acct('fwd-1', 'imap.example.org')]).status).toBe('apple');
  });

  test('a Google-like host that is not a documented Gmail host fails closed (unknown), including look-alike suffixes', () => {
    for (const host of ['smtp.gmail.com', 'imap.gmail.com.example.net', 'mail.google-proxy.example', 'gmail-imap.example.com', 'imap.google.com', 'googlemail.l.google.com', 'imap.gmail.co']) {
      const c = classifyMailAccount(acct('x', host));
      expect([host, c.route, c.reason]).toEqual([host, 'unknown', 'google_like_host']);
    }
    expect(buildMailRouting([acct('x', 'imap.google.com'), acct('y', 'imap.example.com')]).status).toBe('unknown');
  });
});

describe('unknown accounts (fail closed)', () => {
  test('unreadable or malformed metadata of an ENABLED account is unknown: never eligible, never skipped', () => {
    const cases: Array<[string, AppleMailAccountMeta, string]> = [
      ['server name missing', acct('a', null), 'server_name_unreadable'],
      ['server name not a string', acct('a', 42), 'server_name_unreadable'],
      ['server name empty', acct('a', ''), 'server_name_malformed'],
      ['server name with port', acct('a', 'imap.example.com:993'), 'server_name_malformed'],
      ['server name is a URL', acct('a', 'https://imap.example.com'), 'server_name_malformed'],
      ['server name is an address', acct('a', 'me@example.com'), 'server_name_malformed'],
      ['server name has spaces', acct('a', 'imap example com'), 'server_name_malformed'],
      ['enabled flag unreadable', acct('a', 'imap.example.com', 'imap', null), 'enabled_unreadable'],
      ['enabled flag not a boolean', acct('a', 'imap.example.com', 'imap', 'yes'), 'enabled_unreadable'],
      ['account type unreadable', acct('a', 'imap.example.com', null), 'account_type_unsupported'],
      ['account type smtp', acct('a', 'imap.example.com', 'smtp'), 'account_type_unsupported'],
      ['account type unknown', acct('a', 'imap.example.com', 'unknown'), 'account_type_unsupported'],
    ];
    for (const [name, meta, reason] of cases) {
      const c = classifyMailAccount(meta);
      expect([name, c.route, c.reason]).toEqual([name, 'unknown', reason]);
      expect([name, buildMailRouting([meta, acct('ok', 'imap.example.net')]).status]).toEqual([name, 'unknown']);
    }
  });

  test('an unreadable account id, or a duplicated one, makes the routing unknown (the id is the identity of every cursor)', () => {
    const noId = buildMailRouting([acct(null, 'imap.example.com'), acct('ok', 'imap.example.net')]);
    expect(noId.status).toBe('unknown');
    expect(noId.unknown).toEqual([{ id: null, reason: 'account_id_unreadable' }]);
    const dup = buildMailRouting([acct('same', 'imap.example.com'), acct('same', 'imap.gmail.com')]);
    expect(dup.status).toBe('unknown');
    expect(dup.unknown.map((u) => u.reason)).toEqual(['duplicate_account_id', 'duplicate_account_id']);
    expect(dup.eligible).toEqual([]);
    expect(dup.google).toEqual([]);
  });

  test('the iCloud account type may report an empty server name (it cannot be Google); any other type may not', () => {
    expect(classifyMailAccount(acct('i', '', 'iCloud')).route).toBe('apple_eligible');
    expect(classifyMailAccount(acct('i', '', 'imap')).route).toBe('unknown');
    expect(classifyMailAccount(acct('i', null, 'iCloud')).route).toBe('unknown');
    expect(classifyMailAccount(acct('i', 'imap.mail.example', 'iCloud')).route).toBe('apple_eligible');
    // ...but an iCloud-typed account that claims a Google host is still never read.
    expect(classifyMailAccount(acct('i', 'imap.gmail.com', 'iCloud')).route).toBe('google');
  });

  test('the explanation names accounts by id and reason only', () => {
    const text = describeUnknownRouting(buildMailRouting([acct('acct-7', 'imap.google.com')]));
    expect(text).toContain('acct-7: google_like_host');
    expect(text).not.toContain('imap.google.com');
  });
});

describe('disabled accounts', () => {
  test('a disabled account is never read and never judged, whatever else is unreadable about it', () => {
    for (const host of ['imap.gmail.com', 'imap.google.com', null, '', 'not a host']) {
      expect(classifyMailAccount(acct('d', host, 'imap', false)).route).toBe('disabled');
    }
    const r = buildMailRouting([acct('d', 'imap.google.com', 'imap', false), acct('ok', 'imap.example.com')]);
    expect(r.status).toBe('apple');
    expect(r.disabled).toEqual(['d']);
    expect(r.unknown).toEqual([]);
    expect(buildMailRouting([acct('d', 'imap.example.com', 'imap', false)]).status).toBe('no_enabled_accounts');
  });
});

describe('status', () => {
  test('apple / mixed / google_only / unknown / no_enabled_accounts', () => {
    const g = acct('g', 'imap.gmail.com');
    const a = acct('a', 'imap.example.com');
    expect(buildMailRouting([a]).status).toBe('apple');
    expect(buildMailRouting([a, g]).status).toBe('mixed');
    expect(buildMailRouting([g]).status).toBe('google_only');
    expect(buildMailRouting([g, acct('u', null)]).status).toBe('unknown');
    expect(buildMailRouting([]).status).toBe('no_enabled_accounts');
    expect(buildMailRouting([a, g]).eligible).toEqual([{ id: 'a', serverName: 'imap.example.com', accountType: 'imap' }]);
  });

  test('the summary carries counts and the fingerprint, never an account id, host or address', () => {
    const r = buildMailRouting([acct('a-secret-id', 'imap.example.com'), acct('g-secret-id', 'imap.gmail.com')]);
    const text = JSON.stringify(routingSummary(r));
    expect(text).not.toContain('secret-id');
    expect(text).not.toContain('example.com');
    expect(routingSummary(r)).toMatchObject({ version: 1, status: 'mixed', apple_accounts: 1, google_accounts_excluded: 1, disabled_accounts: 0, unknown_accounts: 0 });
  });

  test('a read that cannot find a target proves it gone only when no account is routed away or disabled', () => {
    expect(routingCoversAllAccounts(buildMailRouting([acct('a', 'imap.example.com')]))).toBe(true);
    expect(routingCoversAllAccounts(buildMailRouting([acct('a', 'imap.example.com'), acct('g', 'imap.gmail.com')]))).toBe(false);
    expect(routingCoversAllAccounts(buildMailRouting([acct('a', 'imap.example.com'), acct('d', 'imap.example.com', 'imap', false)]))).toBe(false);
  });
});

describe('fingerprint', () => {
  const fp = (...accounts: AppleMailAccountMeta[]): string => buildMailRouting(accounts).fingerprint;

  test('stable under ordering and case; sha-256 hex', () => {
    expect(fp(acct('a', 'imap.example.com'), acct('b', 'imap.example.net'))).toBe(fp(acct('b', 'IMAP.EXAMPLE.NET.'), acct('a', ' imap.example.com ')));
    expect(fp(acct('a', 'imap.example.com'))).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a provider change under the SAME account id changes it: id-only signatures would not notice', () => {
    const base = fp(acct('a', 'imap.example.com'));
    expect(fp(acct('a', 'imap.other.example.com'))).not.toBe(base); // another host
    expect(fp(acct('a', 'imap.example.com', 'pop'))).not.toBe(base); // another account type
    expect(fp(acct('a', 'imap.gmail.com'))).not.toBe(base); // Apple-hosted -> Google, same id
    expect(fp(acct('a', 'imap.example.com', 'imap', false))).not.toBe(base); // disabled
  });

  test('an unrelated Google or disabled account does not change what is read, so it does not change the fingerprint', () => {
    const base = fp(acct('a', 'imap.example.com'));
    expect(fp(acct('a', 'imap.example.com'), acct('g', 'imap.gmail.com'))).toBe(base);
    expect(fp(acct('a', 'imap.example.com'), acct('d', 'imap.example.net', 'imap', false))).toBe(base);
  });

  test('delimiter-ambiguous ids and hosts cannot collide', () => {
    const rows = (...r: Array<[string, string, string]>) => mailRoutingFingerprint(1, r.map(([id, host, type]) => ({ id, host, type })));
    expect(rows(['a|b', 'c', 'imap'], ['d', 'e', 'imap'])).not.toBe(rows(['a', 'b|c', 'imap'], ['d', 'e', 'imap']));
    expect(rows(['a,b', 'c', 'imap'])).not.toBe(rows(['a', 'b,c', 'imap']));
    expect(rows(['a', 'b', 'c'])).not.toBe(rows(['a', 'b', 'c'], ['a', 'b', 'c']));
    expect(mailRoutingFingerprint(1, [])).not.toBe(mailRoutingFingerprint(2, []));
  });
});

describe('server name normalization', () => {
  test('bare lower-case hosts only', () => {
    expect(normalizeMailHost(' IMAP.Example.COM. ')).toBe('imap.example.com');
    for (const bad of ['', ' ', 'a b', 'imap.example.com:993', 'imap_example.com', '-bad.example.com', 'x'.repeat(300), 'imap..example.com', null, undefined, 5]) {
      expect(normalizeMailHost(bad as never)).toBeNull();
    }
  });
});
