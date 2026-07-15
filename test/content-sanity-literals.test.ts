import { describe, test, expect } from 'bun:test';
import { parseLiteralsContent } from '../src/core/content-sanity-literals.ts';

describe('parseLiteralsContent — operator file parser', () => {
  test('empty input returns empty list', () => {
    expect(parseLiteralsContent('')).toEqual([]);
  });

  test('only-comments input returns empty list', () => {
    expect(parseLiteralsContent('# comment\n# another\n')).toEqual([]);
  });

  test('only-blanks returns empty list', () => {
    expect(parseLiteralsContent('\n\n\n')).toEqual([]);
  });

  test('single bare literal yields one entry with auto-generated name', () => {
    const out = parseLiteralsContent("You're being blocked\n");
    expect(out.length).toBe(1);
    expect(out[0].substring).toBe("You're being blocked");
    expect(out[0].name).toBe('operator_literal_0');
    expect(out[0].applies_to).toBe('both');
  });

  test('name directive on preceding comment binds to next literal', () => {
    const input = `# name=reddit_blocked
You're being blocked
`;
    const out = parseLiteralsContent(input);
    expect(out.length).toBe(1);
    expect(out[0].name).toBe('reddit_blocked');
    expect(out[0].substring).toBe("You're being blocked");
  });

  test('multiple directives merge into the next literal', () => {
    const input = `# name=linkedin_wall
# applies_to=body
Sign in to your account
`;
    const out = parseLiteralsContent(input);
    expect(out[0].name).toBe('linkedin_wall');
    expect(out[0].applies_to).toBe('body');
    expect(out[0].substring).toBe('Sign in to your account');
  });

  test('blank line between directive and literal resets binding', () => {
    const input = `# name=should_not_stick

You're being blocked
`;
    const out = parseLiteralsContent(input);
    expect(out[0].name).toBe('operator_literal_0'); // auto-generated, not "should_not_stick"
  });

  test('directives only bind to the next literal, then reset', () => {
    const input = `# name=first
First literal
# name=second
Second literal
Third literal
`;
    const out = parseLiteralsContent(input);
    expect(out.length).toBe(3);
    expect(out[0].name).toBe('first');
    expect(out[1].name).toBe('second');
    // The auto-name index counts UNNAMED entries only — so the third
    // (first un-named) is operator_literal_0, not _2.
    expect(out[2].name).toBe('operator_literal_0');
  });

  test('invalid applies_to value falls through to default both', () => {
    const input = `# applies_to=invalid_scope
something
`;
    const out = parseLiteralsContent(input);
    expect(out[0].applies_to).toBe('both');
  });

  test('unknown directives ignored without throwing', () => {
    const input = `# foo=bar
# applies_to=body
literal
`;
    const out = parseLiteralsContent(input);
    expect(out[0].applies_to).toBe('body');
  });

  test('regex meta-characters in literal stay literal (no compile)', () => {
    // The loader does NOT call new RegExp() — literals are passed
    // through as-is and assessContentSanity uses .includes() for matching.
    const input = '(a+)+b\n';
    const out = parseLiteralsContent(input);
    expect(out[0].substring).toBe('(a+)+b');
  });

  test('trims trailing whitespace on literal', () => {
    const input = 'literal-with-trailing-space   \n';
    const out = parseLiteralsContent(input);
    expect(out[0].substring).toBe('literal-with-trailing-space');
  });

  test('CRLF line endings handled', () => {
    const input = '# name=cr\r\nliteral\r\n';
    const out = parseLiteralsContent(input);
    expect(out.length).toBe(1);
    // The trim() preserves \r-stripping. The directive may or may not
    // capture trailing \r — test the substring is reasonably clean.
    expect(out[0].substring.replace(/\r$/, '')).toBe('literal');
  });
});
