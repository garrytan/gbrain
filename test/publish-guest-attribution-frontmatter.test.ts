/**
 * `gbrain get` prints a guest page with its warning line above the frontmatter. Saved to a file and published, that
 * line hid the frontmatter from makeShareable (the file no longer started with ---), so every frontmatter line went
 * into the shared page. Publish now drops the exact warning line when frontmatter opens right after it.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeShareable, runPublish } from '../src/commands/publish.ts';
import { formatGetPage } from '../src/cli/page-render.ts';
import { GUEST_WARNING_LINE_RE, guestWarningLine, unattributedGuest, type GuestStamp } from '../src/core/guests/marker.ts';

const GUEST: GuestStamp = { sender: 'Bob Example', group: 'team-a', audience_member: 'alice-example', saved_at: '2026-11-13', promoted: false };
const LINE = guestWarningLine(GUEST);
const FRONTMATTER = '---\ntype: note\ntitle: A note\nprivate: alice-example\n---\n';
const BODY = '# A note\n\nThe offsite moved to Friday.\n';

describe('gbrain publish on a guest page saved from gbrain get', () => {
  test('the warning line and the frontmatter after it stay out of the shared page', () => {
    for (const line of [LINE, guestWarningLine(unattributedGuest())]) {
      const out = makeShareable(`${line}\n${FRONTMATTER}${BODY}`);
      expect(out).not.toContain('alice-example');
      expect(out).not.toContain('private:');
      expect(out).not.toContain('outside guest');
      expect(out.trim()).toBe(BODY.trim());
    }
    expect(makeShareable(`${LINE}\r\n${FRONTMATTER.replace(/\n/g, '\r\n')}${BODY}`)).not.toContain('alice-example');
  });

  test('the real gbrain get text, saved and published, writes no frontmatter into the HTML', async () => {
    const text = formatGetPage({
      slug: 'notes/guest-note', type: 'note', title: 'A note', tags: [], frontmatter: { private: 'alice-example' },
      compiled_truth: BODY, timeline: '', guest: GUEST,
    } as never);
    expect(text.split('\n')[0]).toBe(LINE);
    expect(text).toContain('private: alice-example');
    const dir = mkdtempSync(join(tmpdir(), 'publish-guest-'));
    try {
      const page = join(dir, 'page.md');
      const out = join(dir, 'page.html');
      writeFileSync(page, text);
      const log = console.log;
      console.log = () => {};
      try { await runPublish([page, '--out', out]); } finally { console.log = log; }
      const html = readFileSync(out, 'utf8');
      expect(html).not.toContain('alice-example');
      expect(html).not.toContain('outside guest');
      expect(html).toContain('The offsite moved to Friday.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('frontmatter that opens after the warning line and never closes is refused', () => {
    const invalid = expect.objectContaining({ code: 'invalid_frontmatter' });
    expect(() => makeShareable(`${LINE}\n---\nprivate: alice-example\n\n${BODY}`)).toThrow(invalid);
    expect(() => makeShareable(`${LINE}\n---\nnotes: |\n  ---\nprivate: alice-example\n`)).toThrow(invalid);
  });

  test('only the exact warning line, first and followed by frontmatter, is dropped', () => {
    expect(makeShareable(`${LINE}\n${FRONTMATTER}${BODY}`).trim()).toBe(BODY.trim());
    expect(makeShareable(`${LINE}\n${BODY}`)).toContain(`${LINE}\n# A note`);
    expect(makeShareable(`${BODY}${LINE}\nkept: yes\n`)).toContain(LINE);
    expect(() => makeShareable(`${BODY}${LINE}\n---\nkept: yes\n---\n`)).toThrow(expect.objectContaining({ code: 'invalid_frontmatter' }));
  });

  test('a saved_at outside YYYY-MM-DD still drops the line and strips the frontmatter', () => {
    for (const saved_at of ['+010000-01', '2026-11-13T10:00:00Z', '', '2026-11-13] · x\nprivate: y']) {
      const out = makeShareable(`${guestWarningLine({ ...GUEST, saved_at })}\n${FRONTMATTER}${BODY}`);
      expect({ saved_at, leaked: out.includes('alice-example') }).toEqual({ saved_at, leaked: false });
    }
  });

  test('the pattern matches every line guestWarningLine writes, escaped labels included', () => {
    const wide: GuestStamp = { ...GUEST, sender: '[x] · <y> "z"; ' + 'w'.repeat(80), group: 'team\u0007-b', saved_at: null };
    for (const stamp of [GUEST, wide, unattributedGuest()]) expect(GUEST_WARNING_LINE_RE.test(`${guestWarningLine(stamp)}\n`)).toBe(true);
    expect(GUEST_WARNING_LINE_RE.test('[outside guest · alice-example · team-b · 2020-01-01 · owner verified]\n')).toBe(false);
    expect(GUEST_WARNING_LINE_RE.test(`x${LINE}\n`)).toBe(false);
  });
});
