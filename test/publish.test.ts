import { describe, test, expect } from 'bun:test';
import {
  makeShareable,
  extractTitle,
  encryptContent,
  generatePassword,
  generateHtml,
  PUBLISH_PBKDF2_ITERATIONS,
} from '../src/commands/publish.ts';

describe('makeShareable', () => {
  test('strips YAML frontmatter', () => {
    const input = '---\ntitle: Secret\ntype: person\n---\n\n# Jane Doe\n\nPublic content.';
    const result = makeShareable(input);
    expect(result).not.toContain('title: Secret');
    expect(result).not.toContain('type: person');
    expect(result).toContain('# Jane Doe');
    expect(result).toContain('Public content.');
  });

  test('strips [Source: ...] citations', () => {
    const input = 'Jane is CTO [Source: Crustdata enrichment, 2026-04-01] of Acme.';
    expect(makeShareable(input)).toBe('Jane is CTO of Acme.');
  });

  test('strips multi-format citations', () => {
    const input = 'Fact one [Source: User, meeting, 2026-04-01]. Fact two [Source: compiled from timeline].';
    const result = makeShareable(input);
    expect(result).not.toContain('[Source:');
    expect(result).toContain('Fact one');
    expect(result).toContain('Fact two');
  });

  test('strips source citations that contain nested markdown links', () => {
    const input = 'Fact [Source: User, [private note](../raw/meeting.md), 2026-04-01] remains public.';
    const result = makeShareable(input);
    expect(result).toBe('Fact remains public.');
    expect(result).not.toContain('../raw/');
    expect(result).not.toContain('[Source:');
  });

  test('redacts confirmation numbers', () => {
    const input = '**Confirmation:** ABC123DEF456';
    expect(makeShareable(input)).toContain('on file');
    expect(makeShareable(input)).not.toContain('ABC123DEF456');
  });

  test('strips brain cross-links, keeps display text', () => {
    const input = 'Works with [Jane Doe](../people/jane-doe.md) at Acme.';
    const result = makeShareable(input);
    expect(result).toBe('Works with Jane Doe at Acme.');
    expect(result).not.toContain('../people/');
  });

  test('preserves external URLs', () => {
    const input = 'See [their blog](https://example.com/blog) for details.';
    expect(makeShareable(input)).toContain('https://example.com/blog');
  });

  test('removes See also lines', () => {
    const input = '# Title\n\nContent.\n\n- See also: ../companies/acme.md\n\nMore content.';
    const result = makeShareable(input);
    expect(result).not.toContain('See also');
    expect(result).toContain('More content');
  });

  test('removes Timeline section', () => {
    const input = '# Title\n\nPublic content.\n\n---\n\n## Timeline\n\n- 2026-04-01 | Secret event';
    const result = makeShareable(input);
    expect(result).toContain('Public content.');
    expect(result).not.toContain('Timeline');
    expect(result).not.toContain('Secret event');
  });

  test('removes private evidence below the brain page separator even without a Timeline heading', () => {
    const input = '# Title\n\nPublic content.\n\n---\n\n- **2026-04-01** | Secret event [Source: User, private thread]';
    const result = makeShareable(input);
    expect(result).toBe('# Title\n\nPublic content.');
    expect(result).not.toContain('Secret event');
    expect(result).not.toContain('[Source:');
  });

  test('collapses excessive blank lines', () => {
    const input = '# Title\n\n\n\n\nContent.';
    expect(makeShareable(input)).toBe('# Title\n\nContent.');
  });

  test('handles empty input', () => {
    expect(makeShareable('')).toBe('');
  });

  test('handles frontmatter-only input', () => {
    const input = '---\ntitle: Test\n---\n';
    expect(makeShareable(input)).toBe('');
  });

  test('strips .raw/ relative links', () => {
    const input = 'See [raw data](.raw/crustdata.json) for source.';
    const result = makeShareable(input);
    expect(result).toBe('See raw data for source.');
  });
});

describe('extractTitle', () => {
  test('extracts H1 title', () => {
    expect(extractTitle('# Jane Doe\n\nContent.')).toBe('Jane Doe');
  });

  test('extracts title with formatting', () => {
    expect(extractTitle('# **Bold** Title\n\nContent.')).toBe('**Bold** Title');
  });

  test('returns "Document" when no H1', () => {
    expect(extractTitle('No heading here.')).toBe('Document');
  });

  test('ignores H2 and lower', () => {
    expect(extractTitle('## Not H1\n\nContent.')).toBe('Document');
  });

  test('picks first H1 when multiple exist', () => {
    expect(extractTitle('# First\n\n# Second')).toBe('First');
  });
});

describe('encryptContent', () => {
  test('uses hardened PBKDF2 iterations', () => {
    expect(PUBLISH_PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });

  test('returns salt, iv, and ciphertext', () => {
    const result = encryptContent('hello world', 'password123');
    expect(result.salt).toBeTruthy();
    expect(result.iv).toBeTruthy();
    expect(result.ciphertext).toBeTruthy();
  });

  test('produces valid base64', () => {
    const result = encryptContent('test content', 'pw');
    expect(() => Buffer.from(result.salt, 'base64')).not.toThrow();
    expect(() => Buffer.from(result.iv, 'base64')).not.toThrow();
    expect(() => Buffer.from(result.ciphertext, 'base64')).not.toThrow();
  });

  test('different passwords produce different ciphertext', () => {
    const a = encryptContent('same text', 'password1');
    const b = encryptContent('same text', 'password2');
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  test('same password produces different output (random salt/iv)', () => {
    const a = encryptContent('same text', 'same password');
    const b = encryptContent('same text', 'same password');
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
  });

  test('handles unicode content', () => {
    const result = encryptContent('Hello -- arrows -> and quotes "test"', 'pw');
    expect(result.ciphertext).toBeTruthy();
  });

  test('handles empty string', () => {
    const result = encryptContent('', 'pw');
    expect(result.ciphertext).toBeTruthy();
  });
});

describe('generatePassword', () => {
  test('default length is 16', () => {
    expect(generatePassword()).toHaveLength(16);
  });

  test('custom length', () => {
    expect(generatePassword(8)).toHaveLength(8);
    expect(generatePassword(32)).toHaveLength(32);
  });

  test('excludes ambiguous characters', () => {
    // No 0, O, l, 1, I (all excluded from the charset)
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword(32);
      expect(pw).not.toMatch(/[0OlI1]/);
    }
  });

  test('generates unique passwords', () => {
    const passwords = new Set(Array.from({ length: 20 }, () => generatePassword()));
    expect(passwords.size).toBe(20);
  });
});

describe('generateHtml', () => {
  test('generates valid HTML with title', () => {
    const html = generateHtml({ title: 'Test Page', markdown: '# Hello\n\nWorld.' });
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>Test Page</title>');
    expect(html).toContain('marked.parse');
  });

  test('includes markdown content as JSON', () => {
    const html = generateHtml({ title: 'T', markdown: '# Test Content' });
    expect(html).toContain('# Test Content');
  });

  test('escapes HTML in title', () => {
    const html = generateHtml({ title: '<script>alert("xss")</script>', markdown: 'x' });
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('includes password UI when encrypted', () => {
    const encrypted = encryptContent('secret', 'pw');
    const html = generateHtml({ title: 'T', markdown: 'x', encrypted });
    expect(html).toContain('pw-overlay');
    expect(html).toContain('pw-form');
    expect(html).toContain('Enter password');
    expect(html).toContain('window.__SALT');
    expect(html).toContain('window.__IV');
    expect(html).toContain('window.__CT');
  });

  test('uses hardened browser PBKDF2 iterations for password unlock', () => {
    const encrypted = encryptContent('secret', 'pw');
    const html = generateHtml({ title: 'T', markdown: 'x', encrypted });
    expect(html).toContain('iterations: 600000');
  });

  test('renders sanitized markdown without assigning untrusted HTML to live innerHTML', () => {
    const html = generateHtml({ title: 'T', markdown: '<img src=x onerror=alert(1)><svg><script>alert(2)</script></svg>' });
    expect(html).toContain('new DOMParser().parseFromString');
    expect(html).toContain('replaceChildren');
    expect(html).toContain('ALLOWED_TAGS');
    expect(html).not.toContain('div.innerHTML = html');
    expect(html).not.toContain("document.getElementById('content').innerHTML");
  });

  test('no password UI when unencrypted', () => {
    const html = generateHtml({ title: 'T', markdown: 'x' });
    expect(html).not.toContain('pw-overlay');
    expect(html).not.toContain('window.__SALT');
  });

  test('includes dark mode CSS', () => {
    const html = generateHtml({ title: 'T', markdown: 'x' });
    expect(html).toContain('prefers-color-scheme: dark');
  });

  test('inlines marked.js (no CDN dependency)', () => {
    const html = generateHtml({ title: 'T', markdown: 'x' });
    expect(html).not.toContain('cdn.jsdelivr.net');
    expect(html).toContain('marked');
  });
});
