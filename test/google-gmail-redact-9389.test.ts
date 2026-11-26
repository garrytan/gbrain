/**
 * #9389: opt-in redaction of one-time codes, sign-in links and credentials in
 * Gmail bodies before they become page text.
 *
 * Protects: a labelled code, a token-bearing sign-in/reset/verify link, a
 * credential the shared secret scanner knows, and a labelled temporary
 * password each become a stable placeholder.
 * Regression it catches: ordinary mail text (order, invoice and tracking
 * numbers, phone numbers, dates, prices, zip codes, years, bare digit runs,
 * unsubscribe and product links) being rewritten.
 * Seam: none (pure functions; the sync wiring is pinned in
 * google-gmail-redact-ingest-9389.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import {
  GMAIL_REDACT_CREDENTIALS_KEY,
  gmailRedactValueRefusal,
  redactMailSecrets,
  redactThreadBodies,
} from '../src/core/google/gmail-redact.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';

/** A synthetic link token, assembled at run time so secret scanners never see a credential-shaped literal. */
const FAKE_TOKEN = ['Zk81Qp', '2Lm9Xa', '77Rt4Bv0'].join('');

const OTP = '[redacted:otp]';
const LINK = '[redacted:login-link]';
const CRED = '[redacted:credential]';
const PASS = '[redacted:password]';

describe('labelled one-time codes', () => {
  test.each([
    ['Your verification code is 482913.', `Your verification code is ${OTP}.`],
    ['Your Acme verification code: 482913', `Your Acme verification code: ${OTP}`],
    ['Your verification code for Acme Example is 482913', `Your verification code for Acme Example is ${OTP}`],
    ['Use 739201 to sign in to Acme.', `Use ${OTP} to sign in to Acme.`],
    ['Enter 482913 to verify your email.', `Enter ${OTP} to verify your email.`],
    ['482913 is your Acme verification code', `${OTP} is your Acme verification code`],
    ['G-482913 is your verification code.', `${OTP} is your verification code.`],
    ['Your one-time passcode is 4829 13', `Your one-time passcode is ${OTP}`],
    ['One-time password: 55102384', `One-time password: ${OTP}`],
    ['Security code: 4829', `Security code: ${OTP}`],
    ['Your sign-in code is X7K2P9', `Your sign-in code is ${OTP}`],
    ['Your login code:\n\n**482913**', `Your login code:\n\n**${OTP}**`],
    ['Your PIN is 4829.', `Your PIN is ${OTP}.`],
    ['OTP: 104729', `OTP: ${OTP}`],
  ])('%j', (input, expected) => {
    expect(redactMailSecrets(input)).toBe(expected);
  });

  test('a mixed-case code after an explicit verification label is redacted; after an ambiguous label it still needs capitals', () => {
    expect(redactMailSecrets('Your verification code is aB3dE9.')).toBe(`Your verification code is ${OTP}.`);
    expect(redactMailSecrets('One-time passcode: k7Qm2x')).toBe(`One-time passcode: ${OTP}`);
    expect(redactMailSecrets('Verify your sign-in.\ncode: aB3dE9')).toBe('Verify your sign-in.\ncode: aB3dE9');
    expect(redactMailSecrets('Verify your sign-in.\ncode: AB3DE9')).toBe(`Verify your sign-in.\ncode: ${OTP}`);
  });

  test('a bare "code" label counts only in a sign-in or verification message', () => {
    expect(redactMailSecrets('Verify your sign-in.\ncode: 4829-13')).toBe(`Verify your sign-in.\ncode: ${OTP}`);
    expect(redactMailSecrets('Our new office opens soon.\ncode: 4829-13')).toBe('Our new office opens soon.\ncode: 4829-13');
  });
});

describe('sign-in, reset and verification links', () => {
  test('a token-bearing link in a sign-in message is replaced whole', () => {
    const body = `Click to sign in to Acme:\nhttps://app.acme-example.invalid/auth/magic?token=${FAKE_TOKEN}&utm_source=mail\nIt expires in 15 minutes.`;
    expect(redactMailSecrets(body)).toBe(`Click to sign in to Acme:\n${LINK}\nIt expires in 15 minutes.`);
  });

  test('reset and verify links carrying a token in the path or the fragment', () => {
    expect(redactMailSecrets('Reset your password: https://acme-example.invalid/reset/9f86d081884c7d659a2feaa0c55ad015.'))
      .toBe(`Reset your password: ${LINK}.`);
    expect(redactMailSecrets('Verify your email address <https://acme-example.invalid/v#access_token=aB3dE5fG7hJ9kL1mN3pQ>'))
      .toBe(`Verify your email address <${LINK}>`);
  });

  test('ordinary links stay: unsubscribe, product pages, links without a token, links without sign-in context', () => {
    const signIn = [
      'Sign in to Acme with the link we sent.',
      'Help: https://acme-example.invalid/help/articles/360001234567-How-to-sign-in',
      'Shop: https://shop.acme-example.invalid/products/blue-widget-2026-edition-xl?ref=mail',
      'Login page: https://app.acme-example.invalid/login?next=%2Fsettings%2Fbilling2026',
      `Unsubscribe: https://acme-example.invalid/unsubscribe?token=${FAKE_TOKEN}`,
      `Preferences: https://acme-example.invalid/email-preferences/${FAKE_TOKEN}`,
    ].join('\n');
    expect(redactMailSecrets(signIn)).toBe(signIn);
    const newsletter = `This week at Acme: https://acme-example.invalid/blog/post?id=${FAKE_TOKEN}`;
    expect(redactMailSecrets(newsletter)).toBe(newsletter);
  });
});

describe('credentials and labelled passwords', () => {
  test('a credential shape the secret scanner knows becomes [redacted:credential]', () => {
    const key = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6A7b8C9d0E1f2G3h4I5j6K7l8M9n0';
    expect(redactMailSecrets(`Here is the key you asked for: ${key}`)).toBe(`Here is the key you asked for: ${CRED}`);
  });

  test('a labelled temporary password becomes [redacted:password]', () => {
    expect(redactMailSecrets('Temporary password: Kx9mq2Zr')).toBe(`Temporary password: ${PASS}`);
    expect(redactMailSecrets('Your temporary password is Kx9!mq2Z.')).toBe(`Your temporary password is ${PASS}.`);
  });

  test('password prose without a value stays', () => {
    for (const text of ['Your new password is now active.', 'Your new password is case-sensitive.', 'Reset your password from the settings page.']) {
      expect(redactMailSecrets(text)).toBe(text);
    }
  });
});

describe('ordinary mail text is never rewritten', () => {
  test.each([
    'Order #482913 has shipped.',
    'Order number: 482913',
    'Your order confirmation number is 482913.',
    'Invoice INV-2026-00123 is due on 2026-12-01.',
    'Tracking number: 1Z999AA10123456784',
    'Call us at (415) 555-0134 or +1 415 555 0134.',
    'Meeting on Dec 12, 2026 at 10:30.',
    'Total: $1,299.00 (incl. tax 8.625%).',
    'Ship to: 100 Example St, San Francisco, CA 94107.',
    'Zip code: 94107',
    'Use promo code SAVE2026 to get 20% off.',
    'Discount code: 20OFF2026',
    'Error code: 5003',
    'Reference code ABC123 for your booking.',
    'Confirmation code: QX7T2P',
    'Log in to manage your trip. Your booking confirmation code is QX7T2P.',
    'See you in 2026!',
    'The account number ends in 482913.',
    '482913',
    'Your verification code expires in 10 minutes.',
    'We sent you a verification code. It expires on 2026-12-01.',
  ])('%j', (text) => {
    expect(redactMailSecrets(text)).toBe(text);
  });

  test('a mixed body redacts only the secrets', () => {
    const body = 'Your verification code is 482913.\nOrder #771204 ships to 94107 on 2026-12-01 for $129.99.';
    expect(redactMailSecrets(body)).toBe(`Your verification code is ${OTP}.\nOrder #771204 ships to 94107 on 2026-12-01 for $129.99.`);
  });
});

describe('the subject decides what a message is about', () => {
  test('a reset link and a bare code are redacted when only the subject says what the message is', () => {
    const link = `Use this link within the hour:\nhttps://acme-example.invalid/r?token=${FAKE_TOKEN}`;
    expect(redactMailSecrets(link)).toBe(link);
    expect(redactMailSecrets(link, 'Reset your password')).toBe(`Use this link within the hour:\n${LINK}`);
    const code = 'Your code: 482913.';
    expect(redactMailSecrets(code)).toBe(code);
    expect(redactMailSecrets(code, 'Verify your account')).toBe(`Your code: ${OTP}.`);
  });

  test('redactThreadBodies passes each message subject, and never rewrites the subject itself', () => {
    const msg = { id: 'bb22', threadId: 't2', from: 'Acme <no-reply@acme-example.invalid>', fromAddress: 'no-reply@acme-example.invalid', to: ['owner@example.invalid'],
      cc: [], subject: 'Reset your password', dateIso: '2026-11-01T00:00:00.000Z', internalDateMs: 0, labelIds: ['INBOX'], listUnsubscribe: false, calendarMethod: null,
      bodyText: `Open https://acme-example.invalid/r?token=${FAKE_TOKEN} to continue.` };
    const out = redactThreadBodies({ threadId: 't2', account: 'owner@example.invalid', messages: [msg] }, true);
    expect(out.messages[0]!.bodyText).toBe(`Open ${LINK} to continue.`);
    expect(out.messages[0]!.subject).toBe('Reset your password');
  });
});

describe('thread and config', () => {
  test('redactThreadBodies rewrites every message body and nothing else', () => {
    const msg = { id: 'aa11', threadId: 't1', from: 'Acme <no-reply@acme-example.invalid>', fromAddress: 'no-reply@acme-example.invalid', to: ['owner@example.invalid'],
      cc: [], subject: 'Sign in', dateIso: '2026-11-01T00:00:00.000Z', internalDateMs: 0, labelIds: ['INBOX'], listUnsubscribe: false, calendarMethod: null,
      bodyText: 'Your verification code is 482913.' };
    const out = redactThreadBodies({ threadId: 't1', account: 'owner@example.invalid', messages: [msg] }, true);
    expect(out.messages[0]!.bodyText).toBe(`Your verification code is ${OTP}.`);
    expect(out.messages[0]!.subject).toBe('Sign in');
    expect(msg.bodyText).toBe('Your verification code is 482913.');
  });

  test('the key is registered and config set accepts only a boolean', () => {
    expect(GMAIL_REDACT_CREDENTIALS_KEY).toBe('google.gmail.redact_credentials');
    expect(KNOWN_CONFIG_KEYS).toContain(GMAIL_REDACT_CREDENTIALS_KEY);
    expect(gmailRedactValueRefusal('true')).toBeNull();
    expect(gmailRedactValueRefusal('off')).toBeNull();
    expect(gmailRedactValueRefusal('maybe')).toContain('must be true or false');
  });
});
