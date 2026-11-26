/**
 * gbrain publish refuses frontmatter that sits below other text. It used to decide "is this frontmatter" with a key-line
 * pattern, and every YAML key shape the pattern missed published its values. It now asks the YAML parser sync uses: a
 * wrapped block between two column-0 fences, or an unclosed one up to its first blank line, is refused when it parses as
 * a mapping or a sequence holding one, or when it fails to parse while holding a `key:` separator.
 */
import { describe, test, expect } from 'bun:test';
import { makeShareable } from '../src/commands/publish.ts';
import { guestWarningLine, type GuestStamp } from '../src/core/guests/marker.ts';

const BODY = '# A note\n\nThe offsite moved to Friday.\n';
const FRONTMATTER = '---\ntype: note\ntitle: A note\nprivate: alice-example\n---\n';
const GUEST: GuestStamp = { sender: 'Bob Example', group: 'team-a', audience_member: 'alice-example', saved_at: '2026-11-13', promoted: false };
const invalid = expect.objectContaining({ code: 'invalid_frontmatter' });
const closed = (block: string) => `wrapper\n---\n${block}\n---\n${BODY}`;
const unclosed = (block: string) => `Saved:\n---\n${block}\n\n${BODY}`;

describe('wrapped frontmatter the key pattern missed is refused', () => {
  test('an indented key block between wrapped fences', () => {
    expect(() => makeShareable(closed('  secret: alice-example-private'))).toThrow(invalid);
  });

  test('a plain key holding a colon', () => {
    expect(() => makeShareable(closed('a:b: alice-example-private'))).toThrow(invalid);
  });

  test('a plain key holding a time', () => {
    expect(() => makeShareable(closed('time 10:30: alice-example-private'))).toThrow(invalid);
  });

  test('a flow-sequence key', () => {
    expect(() => makeShareable(closed('[a, b]: alice-example-private'))).toThrow(invalid);
  });

  test('a tag alone on a line opening an unclosed wrapped block', () => {
    expect(() => makeShareable(unclosed('!!map\nsecret: alice-example-private'))).toThrow(invalid);
  });

  test('an anchor alone on a line opening an unclosed wrapped block', () => {
    expect(() => makeShareable(unclosed('&a\nsecret: alice-example-private'))).toThrow(invalid);
  });

  test('an empty double-quoted key', () => {
    expect(() => makeShareable(closed('"": alice-example-private'))).toThrow(invalid);
  });

  test('an empty single-quoted key', () => {
    expect(() => makeShareable(closed("'': alice-example-private"))).toThrow(invalid);
  });

  test('a -: key', () => {
    expect(() => makeShareable(closed('-: alice-example-private'))).toThrow(invalid);
  });

  test('a ?: key', () => {
    expect(() => makeShareable(closed('?: alice-example-private'))).toThrow(invalid);
  });

  test('a block that fails to parse but holds a key separator fails closed', () => {
    expect(() => makeShareable(closed('  secret: alice-example-private\n pin: 1234'))).toThrow(invalid);
  });

  test('a list of key: value items between wrapped fences fails closed', () => {
    expect(() => makeShareable('intro\n---\n- item: one\n---\nend\n')).toThrow(invalid);
  });

  test('a setext heading over a sentence that YAML reads as a key: value pair fails closed', () => {
    expect(() => makeShareable('My Notes\n---\nWe met at 10:30 and agreed: ship it.\n')).toThrow(invalid);
  });
});

describe('pages that are not wrapped frontmatter still publish', () => {
  test('a plain list between rules', () => {
    expect(makeShareable('intro\n---\n- one\n- two\n---\nend\n')).toContain('- two');
  });

  test('prose YAML cannot parse and that holds no key separator', () => {
    expect(makeShareable('intro\n---\n`code` and @alice-example said hi\n---\nend\n')).toContain('@alice-example said hi');
  });

  test('a page whose frontmatter starts the file', () => {
    expect(makeShareable(`${FRONTMATTER}${BODY}`)).toBe(BODY.trim());
  });

  test('a gbrain get guest page', () => {
    expect(makeShareable(`${guestWarningLine(GUEST)}\n${FRONTMATTER}${BODY}`)).toBe(BODY.trim());
  });
});
