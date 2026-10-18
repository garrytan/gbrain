/**
 * Native Gmail thread pages: the parser binds every message turn to the
 * collector's own envelope (account, ordered message IDs, sender, dates,
 * citation link, attachment footer) and refuses — instead of guessing — when a
 * page that declares that envelope does not match it.
 *
 * Pure-function tests; no PGLite, no LLM. Pages come from the real
 * renderThreadPage producer. Every address and body below is invented.
 */

import { describe, expect, test } from 'bun:test';
import { renderThreadPage } from '../../src/core/google/google-render.ts';
import { parseConversation } from '../../src/core/conversation-parser/parse.ts';
import { conversationSkip } from '../../src/core/facts/conversation-skip.ts';
import type { Page } from '../../src/core/types.ts';

/** Decoder for the renderer's flat YAML subset (scalars as JSON, `  - ` lists). */
function decodeFrontmatter(yaml: string): Record<string, unknown> {
  const fm: Record<string, unknown> = {};
  let key = '';
  for (const line of yaml.trim().split('\n')) {
    if (line.startsWith('  - ')) { (fm[key] as unknown[]).push(JSON.parse(line.slice(4))); continue; }
    const i = line.indexOf(':');
    key = line.slice(0, i);
    const v = line.slice(i + 1).trim();
    if (!v) fm[key] = [];
    else { try { fm[key] = JSON.parse(v); } catch { fm[key] = v; } }
  }
  return fm;
}

const MESSAGES = [
  {
    id: 'a123456789012345', from: 'Alice Example <alice@example.test>', fromAddress: 'alice@example.test',
    to: ['bob@example.test'], cc: ['carol@example.test'], dateIso: '2026-10-18T01:00:00.000Z',
    subject: 'Invented test thread', labelIds: [],
    bodyText: 'Please approve the invented violet fixture.\n\nTo: authored prose stays intact.',
  },
  {
    id: 'b123456789012345', from: 'Bob Example <bob@example.test>', fromAddress: 'bob@example.test',
    to: ['alice@example.test'], cc: [], dateIso: '2026-10-18T01:05:00.000Z',
    subject: 'Invented test thread', labelIds: ['SENT'],
    bodyText: 'I approve the invented violet fixture.',
  },
];

function fixture(account = 'first@example.test') {
  const rendered = renderThreadPage({ threadId: 'thread0123456789', account, messages: MESSAGES } as never)!;
  const [, yaml, body] = rendered.markdown.split('---');
  const frontmatter = decodeFrontmatter(yaml);
  const page = {
    slug: 'synthetic/gmail-fixture', type: 'email', title: 'Invented test thread',
    frontmatter, compiled_truth: body, timeline: '', effective_date: new Date(String(frontmatter.date)),
  } as unknown as Page;
  return { page, body, fm: frontmatter as Record<string, any> };
}

describe('native Gmail envelope parsing', () => {
  for (const account of ['first@example.test', 'second@example.test']) {
    for (const legacySenders of [false, true]) {
      test(`renderer output parses exactly (${account}, senders ${legacySenders ? 'absent' : 'present'})`, () => {
        const f = fixture(account);
        if (legacySenders) delete f.fm.senders;
        const p = parseConversation(f.body, { page: f.page });
        expect(p.native_email_refusal).toBeUndefined();
        expect(p.matched_pattern_id).toBe('native-gmail');
        expect(p.messages.map(m => m.speaker)).toEqual(MESSAGES.map(m => m.from));
        expect(p.messages.map(m => m.timestamp)).toEqual(MESSAGES.map(m => m.dateIso));
        // Routing line and attachment footer are stripped; authored "To:" prose is kept.
        expect(p.messages.map(m => m.text)).toEqual(MESSAGES.map(m => m.bodyText));
      });
    }
  }

  const damage: Record<string, (f: ReturnType<typeof fixture>) => void> = {
    'offsite citation link': f => { f.body = f.body.replace('https://mail.google.com/', 'https://evil.example.test/'); },
    'account mismatch': f => { f.fm.account = 'mismatch@example.test'; },
    'message ID order': f => { f.fm.message_ids.reverse(); },
    'sender outside the thread': f => { f.fm.senders = ['forged@example.test']; },
    'heading sender is not the author': f => { f.body = f.body.replace('Alice Example <alice@example.test>', 'Carol Example <carol@example.test>'); },
    'damaged heading clock': f => { f.body = f.body.replace(' · 2026-10-18 01:00', ' · damaged-clock'); },
    'impossible envelope date': f => { f.fm.date = '2026-02-30T01:05:00.000Z'; },
    'wrong message count': f => { f.fm.message_count = 3; },
    'missing last message ID': f => { delete f.fm.message_id; },
    'citation removed': f => { f.body = f.body.replace(/\[Source: email[^\n]+/, 'Gmail message link unavailable.'); },
    'attachment footer mismatch': f => { f.body = f.body.replace('Attachments: not inspected.', 'Attachments: present; forged invented footer.'); },
    'prose body under a native envelope': f => { f.body = '**Agenda:** invented notes'; },
  };
  for (const [name, mutate] of Object.entries(damage)) {
    test(`refuses, never guesses: ${name}`, () => {
      const f = fixture();
      mutate(f);
      const p = parseConversation(f.body, { page: f.page });
      expect(p.native_email_refusal?.code).toBe('NATIVE_GMAIL_ENVELOPE_REFUSED');
      expect(p.messages).toHaveLength(0);
      expect(p.matched_pattern_id).toBeUndefined();
    });
  }

  test('a refusal is never a durable not-extractable outcome, even for prose', () => {
    const f = fixture();
    f.body = '**Agenda:** invented notes\n**Attendees:** Alice, Bob\n**Action items:** none';
    const p = parseConversation(f.body, { page: f.page });
    expect(p.native_email_refusal).toBeDefined();
    expect(conversationSkip(f.page, f.body, p, p.messages, { llmFallback: false })).toBeNull();
  });

  test('a verified single-message thread keeps the durable single-email outcome', () => {
    const one = renderThreadPage({ threadId: 'thread0123456789', account: 'first@example.test', messages: MESSAGES.slice(0, 1) } as never)!;
    const [, yaml, body] = one.markdown.split('---');
    const frontmatter = decodeFrontmatter(yaml);
    const page = { slug: 'synthetic/gmail-single', type: 'email', title: 'Invented test thread', frontmatter,
      compiled_truth: body, timeline: '', effective_date: new Date(String(frontmatter.date)) } as unknown as Page;
    const p = parseConversation(body, { page });
    expect(p.matched_pattern_id).toBe('native-gmail');
    expect(p.messages).toHaveLength(1);
    expect(conversationSkip(page, body, p, p.messages, { llmFallback: false })?.reason).toContain('single email message');
  });

  test('a legacy page without receipts parses its unambiguous body', () => {
    const f = fixture();
    delete f.fm.senders;
    delete f.fm.gmail_attachment_receipts;
    f.body = f.body.replace(/\nAttachments: not inspected\.\n/g, '\n').replace('To: bob@example.test · Cc: carol@example.test\n\n', '');
    const p = parseConversation(f.body, { page: f.page });
    expect(p.matched_pattern_id).toBe('native-gmail');
    expect(p.messages).toHaveLength(2);
    expect(p.messages[0].text).toContain('To: authored prose stays intact.');
  });

  test('disabling the adapter refuses instead of falling through to generic parsing', () => {
    const f = fixture();
    const p = parseConversation(f.body, { page: f.page, disabledBuiltinIds: ['native-gmail'] });
    expect(p.native_email_refusal?.reason).toBe('adapter_disabled');
    expect(p.messages).toHaveLength(0);
  });

  test('pages without a Gmail envelope keep the existing parsers', () => {
    const f = fixture();
    const doc = parseConversation('## Summary\nInvented ordinary notes', { page: { ...f.page, type: 'document' } as Page });
    expect(doc.native_email_refusal).toBeUndefined();
    const chat = parseConversation('**Alice** (2026-10-18 1:00 AM): hello\n**Bob** (2026-10-18 1:01 AM): hi');
    expect(chat.messages).toHaveLength(2);
  });
});
