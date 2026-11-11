/**
 * #8719: a forwarded email's content is the message, not a quoted tail of
 * this thread, so the Gmail renderer keeps it. Reply trimming is unchanged,
 * including a forward quoted inside a reply.
 *
 * Synthetic bodies only: example.invalid addresses.
 */
import { describe, expect, test } from 'bun:test';
import { trimQuotedReply } from '../src/core/google/google-render.ts';

describe('#8719 trimQuotedReply keeps forwarded content', () => {
  test('a Gmail forward keeps the note and the forwarded body', () => {
    const text = 'FYI\n\n---------- Forwarded message ---------\nFrom: Alice Example <alice@example.invalid>\nSubject: Launch\n\nThe launch moved to Friday.';
    expect(trimQuotedReply(text)).toBe(text);
  });

  test('a forward with no note is not emptied', () => {
    const text = '---------- Forwarded message ---------\nFrom: alice@example.invalid\n\nThe launch moved to Friday.';
    expect(trimQuotedReply(text)).toBe(text);
  });

  test('an Apple Mail forward keeps the reply chain quoted inside it', () => {
    const text = 'See below.\n\nBegin forwarded message:\n\nFrom: alice@example.invalid\nThe launch moved to Friday.\n\nOn Mon, Jan 5, 2026 at 9:00 AM Bob Example <bob@example.invalid> wrote:\n> Is the launch still Thursday?';
    expect(trimQuotedReply(text)).toBe(text);
  });

  test('a reply that quotes a forward is still cut at the reply marker', () => {
    const text = 'Thanks, noted.\n\nOn Mon, Jan 5, 2026 at 9:00 AM Alice Example <alice@example.invalid> wrote:\n> ---------- Forwarded message ---------\n> The launch moved to Friday.';
    expect(trimQuotedReply(text)).toBe('Thanks, noted.');
  });
});
