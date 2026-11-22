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
});

describe('key shapes from the earlier key-pattern fix stay refused', () => {
  for (const key of ['2fa_backup', '$secret', 'ключ', '番号', 'home address']) {
    test(`closed block with key ${key}`, () => {
      expect(() => makeShareable(closed(`${key}: alice-example-private`))).toThrow(invalid);
    });
  }

  for (const key of ['2fa_backup', '$secret']) {
    test(`unclosed block with key ${key}`, () => {
      expect(() => makeShareable(`Saved:\n---\n${key}: alice-example-private\n`)).toThrow(invalid);
    });
  }

  for (const line of ['&a private: alice-example-private', '!!str private: alice-example-private', '-x: alice-example-private', `"alice's phone": alice-example-private`, `'alice''s phone': alice-example-private`, '"a \\" b": alice-example-private', '? private\n: alice-example-private']) {
    test(`closed block ${JSON.stringify(line)}`, () => {
      expect(() => makeShareable(closed(line))).toThrow(invalid);
    });
    test(`unclosed block ${JSON.stringify(line)}`, () => {
      expect(() => makeShareable(unclosed(line))).toThrow(invalid);
    });
  }

  test('an unclosed block that starts with a # comment line', () => {
    expect(() => makeShareable('Saved:\n---\n# saved from the brain\nprivate: alice-example\n\nBody text.\n')).toThrow(invalid);
  });

  test('an unclosed block that starts with a bare # line', () => {
    expect(() => makeShareable('Saved:\n---\n#\n2fa_backup: alice-example-private\n')).toThrow(invalid);
  });

  test('language openers and a flow mapping', () => {
    expect(() => makeShareable(`wrapper\n---yaml\ntitle: A note\n---\n${BODY}`)).toThrow(invalid);
    expect(() => makeShareable(`wrapper\n--- json\n{"private": "alice-example"}\n---\n${BODY}`)).toThrow(invalid);
    expect(() => makeShareable(closed('{private: alice-example}'))).toThrow(invalid);
  });
});

describe('pages that are not wrapped frontmatter still publish', () => {
  test('prose between two early rules', () => {
    const page = '# Plan\n\nWe met on Monday.\n---\nThe draft is ready for a read.\n\n---\n\nMore notes after the second rule.\n';
    expect(makeShareable(page)).toBe(page.trim());
  });

  test('a heading after a rule', () => {
    expect(makeShareable('intro\n---\n# Heading\nThe draft is ready.\n')).toContain('The draft is ready.');
  });

  test('a time in a sentence between rules', () => {
    expect(makeShareable('intro\n---\nThe meeting is at 10:30 on Friday.\n---\nend\n')).toContain('10:30');
  });

  test('a URL between rules', () => {
    expect(makeShareable('intro\n---\nSee https://example.com/a\n---\nend\n')).toContain('https://example.com/a');
  });

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
