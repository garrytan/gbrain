/**
 * A wrapped frontmatter block (text above its opening ---) is refused only when publish can tell it is frontmatter.
 * Keys that do not start with an ASCII letter or _ (a non-Latin key, 2fa_backup:, $secret:, a key with a space) and
 * an unclosed wrapped block that starts with a YAML # comment line were not recognized, so their values published.
 */
import { describe, test, expect } from 'bun:test';
import { makeShareable } from '../src/commands/publish.ts';

const BODY = '# A note\n\nThe offsite moved to Friday.\n';
const invalid = expect.objectContaining({ code: 'invalid_frontmatter' });

describe('wrapped frontmatter with any YAML key shape', () => {
  test('closed wrapped blocks whose keys start with a digit, a symbol, a non-Latin letter or hold a space are refused', () => {
    for (const key of ['2fa_backup', '$secret', 'ключ', '番号', 'home address']) {
      expect(() => makeShareable(`wrapper\n---\n${key}: alice-example-private\n---\n${BODY}`)).toThrow(invalid);
    }
  });

  test('unclosed wrapped blocks whose keys start with a digit or a symbol are refused', () => {
    expect(() => makeShareable('Saved:\n---\n2fa_backup: alice-example-private\n\n# A note\n')).toThrow(invalid);
    expect(() => makeShareable('Saved:\n---\n$secret: alice-example-private\n')).toThrow(invalid);
  });

  test('anchored, tagged, dash-led, complex and mixed-quote keys in wrapped blocks are refused', () => {
    for (const line of ['&a private: alice-example-private', '!!str private: alice-example-private', '-x: alice-example-private', `"alice's phone": alice-example-private`, `'alice''s phone': alice-example-private`, '"a \\" b": alice-example-private', '? private\n: alice-example-private']) {
      expect(() => makeShareable(`Saved:\n---\n${line}\n---\n${BODY}`)).toThrow(invalid);
      expect(() => makeShareable(`Saved:\n---\n${line}\n\n${BODY}`)).toThrow(invalid);
    }
  });

  test('an unclosed wrapped block that starts with a # comment line is refused', () => {
    expect(() => makeShareable('Saved:\n---\n# saved from the brain\nprivate: alice-example\n\nBody text.\n')).toThrow(invalid);
    expect(() => makeShareable('Saved:\n---\n#\n2fa_backup: alice-example-private\n')).toThrow(invalid);
  });

  test('early horizontal rules around prose, a heading or a link still publish', () => {
    expect(makeShareable('intro\n---\n# Heading\nThe draft is ready.\n')).toContain('The draft is ready.');
    expect(makeShareable('intro\n---\nThe meeting is at 10:30 on Friday.\n---\nend\n')).toContain('10:30');
    expect(makeShareable('intro\n---\nSee https://example.com/a\n---\nend\n')).toContain('https://example.com/a');
  });

  test('a list of key: value items between early rules fails closed', () => {
    expect(() => makeShareable('intro\n---\n- item: one\n---\nend\n')).toThrow(invalid);
  });
});
