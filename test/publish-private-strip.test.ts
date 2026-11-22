import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeShareable, runPublish } from '../src/commands/publish.ts';

const SECRET = 'private log entry';

describe('makeShareable drops every private section, whatever comes before it (#10020)', () => {
  const timelineCases: Array<[string, string]> = [
    ['bare ## Timeline heading', '# Test\n\nBody.\n\n## Timeline\n\n- **2026-01-01** | ' + SECRET + '\n'],
    ['extra blank lines after the rule', '# Test\n\nBody.\n\n---\n\n\n## Timeline\n\n- 2026-01-01 ' + SECRET + '\n'],
    ['no blank line after the rule', '# Test\n\nBody.\n\n---\n## Timeline\n\n- 2026-01-01 ' + SECRET + '\n'],
    ['CRLF line endings', '# Test\r\n\r\nBody.\r\n\r\n---\r\n\r\n## Timeline\r\n\r\n- 2026-01-01 ' + SECRET + '\r\n'],
    ['<!-- timeline --> sentinel', '# Test\n\nBody.\n\n<!-- timeline -->\n\n- 2026-01-01 ' + SECRET + '\n'],
    ['<!--timeline--> sentinel', '# Test\n\nBody.\n\n<!--timeline-->\n- 2026-01-01 ' + SECRET + '\n'],
    ['--- timeline --- sentinel', '# Test\n\nBody.\n\n--- timeline ---\n\n- 2026-01-01 ' + SECRET + '\n'],
    ['## History heading', '# Test\n\nBody.\n\n---\n\n## History\n\n- 2026-01-01 ' + SECRET + '\n'],
    ['lowercase heading with trailing text', '# Test\n\nBody.\n\n## timeline (raw)\n\n- 2026-01-01 ' + SECRET + '\n'],
    ['H3 Timeline heading', '# Test\n\nBody.\n\n### Timeline\n\n- 2026-01-01 ' + SECRET + '\n'],
    ['sections after the timeline', '# Test\n\nBody.\n\n## Timeline\n\n- 2026-01-01 ' + SECRET + '\n\n## Later\n\nmore ' + SECRET + '\n'],
  ];
  for (const [name, input] of timelineCases) {
    test(name, () => {
      const out = makeShareable(input);
      expect(out).not.toContain(SECRET);
      expect(out).not.toMatch(/timeline|history/i);
      expect(out).toBe('# Test\n\nBody.');
    });
  }

  test('facts and takes fences are dropped with their headings', () => {
    const input = '# Test\n\nBody.\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility |\n|---|---|---|---|---|\n| 1 | ' + SECRET + ' | fact | 1.0 | private |\n<!--- gbrain:facts:end -->\n\n## Takes\n\n<!--- gbrain:takes:begin -->\n| # | claim |\n|---|---|\n| 1 | take ' + SECRET + ' |\n<!--- gbrain:takes:end -->\n\nAfter.\n';
    const out = makeShareable(input);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('gbrain:');
    expect(out).toBe('# Test\n\nBody.\n\nAfter.');
  });

  test('an unclosed gbrain fence drops everything after it', () => {
    const out = makeShareable('# Test\n\nBody.\n\n<!--- gbrain:facts:begin -->\n| 1 | ' + SECRET + ' |\n\n## Later\n\nmore\n');
    expect(out).not.toContain(SECRET);
    expect(out).toBe('# Test\n\nBody.');
  });

  test('HTML comments are dropped, and an unclosed one drops the rest', () => {
    expect(makeShareable('# Test\n\nBody. <!-- ' + SECRET + ' --> Tail.\n')).toBe('# Test\n\nBody. Tail.');
    expect(makeShareable('# Test\n\nBody.\n\n<!-- ' + SECRET + '\n\nmore\n')).toBe('# Test\n\nBody.');
  });

  test('frontmatter whose value holds --- is dropped whole', () => {
    const out = makeShareable('---\ntitle: a---b\nemail: ' + SECRET + '\n---\n\n# Test\n\nBody.\n');
    expect(out).not.toContain(SECRET);
    expect(out).toBe('# Test\n\nBody.');
  });

  test('frontmatter after leading blank lines is dropped', () => {
    expect(makeShareable('\n\n---\nemail: ' + SECRET + '\n---\n# Test\n\nBody.\n')).toBe('# Test\n\nBody.');
  });

  test('unclosed frontmatter refuses instead of publishing it', () => {
    expect(() => makeShareable('---\nemail: ' + SECRET + '\n\n# Test\n\nBody.\n')).toThrow(/frontmatter/i);
  });

  test('a page without private sections keeps its body', () => {
    const input = '# Test\n\nBody.\n\n---\n\n## Notes\n\nPublic notes about a timeline of events.\n';
    expect(makeShareable(input)).toBe('# Test\n\nBody.\n\n---\n\n## Notes\n\nPublic notes about a timeline of events.');
  });
});

describe('gbrain publish writes no private section into the HTML (#10020)', () => {
  test('bare ## Timeline stays out of the published file, title included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'publish-10020-'));
    try {
      const page = join(dir, 'page.md');
      const out = join(dir, 'page.html');
      writeFileSync(page, 'Body without a title.\n\n## Timeline\n\n# ' + SECRET + ' heading\n\n- **2026-01-01** | ' + SECRET + '\n');
      const log = console.log;
      console.log = () => {};
      try { await runPublish([page, '--out', out]); } finally { console.log = log; }
      const html = readFileSync(out, 'utf8');
      expect(html).not.toContain(SECRET);
      expect(html).toContain('Body without a title.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
