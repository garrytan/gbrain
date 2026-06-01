import { describe, expect, test } from 'bun:test';
import matter from 'gray-matter';
import { parseConversation } from '../../src/core/conversation-parser/parse.ts';
import { buildNameResolver } from '../../src/core/iphone/name-resolver.ts';
import { renderConversationMarkdown, renderPersonMarkdown, slugForContact, slugForConversation } from '../../src/core/iphone/render.ts';
import type { ContactRecord, ConversationSegment } from '../../src/core/iphone/types.ts';

const alice: ContactRecord = {
  recordId: 1,
  firstName: 'Alice',
  lastName: 'Example',
  organization: 'acme-example',
  phones: ['+15550000001'],
  emails: ['alice@acme-example.com'],
};

const segment: ConversationSegment = {
  id: 'chat:7:2024-03',
  chatId: 7,
  chatIdentifier: '+15550000001',
  chatDisplayName: null,
  service: 'iMessage',
  month: '2024-03',
  participantHandles: ['+15550000001'],
  messages: [
    {
      id: 100,
      chatId: 7,
      chatIdentifier: '+15550000001',
      chatDisplayName: null,
      service: 'iMessage',
      handle: '+15550000001',
      isFromMe: true,
      timestamp: new Date('2024-03-15T09:00:00Z'),
      text: 'did acme-example wire the invoice?',
    },
    {
      id: 101,
      chatId: 7,
      chatIdentifier: '+15550000001',
      chatDisplayName: null,
      service: 'iMessage',
      handle: '+15550000001',
      isFromMe: false,
      timestamp: new Date('2024-03-15T09:02:00Z'),
      text: 'yes, this AM',
    },
  ],
};

describe('iPhone markdown renderer', () => {
  test('renders person pages with stable people/<name> slugs', () => {
    const page = renderPersonMarkdown(alice);
    const parsed = matter(page.content);

    expect(page.slug).toBe('people/alice-example');
    expect(slugForContact(alice)).toBe('people/alice-example');
    expect(parsed.data.type).toBe('person');
    expect(parsed.data.imported_from).toBe('iphone-backup');
    expect(parsed.data.phones).toEqual(['+15550000001']);
  });

  test('renders conversation pages in the imessage-slack shape parsed by the existing builtin', () => {
    const resolver = buildNameResolver([alice], { selfName: 'Me' });
    const page = renderConversationMarkdown(segment, resolver);
    const parsed = matter(page.content);
    const result = parseConversation(parsed.content);

    expect(page.slug).toBe('conversations/imessage/alice-example-2024-03');
    expect(slugForConversation(segment, resolver)).toBe(page.slug);
    expect(parsed.data.type).toBe('conversation');
    expect(parsed.content).toContain('**Me** (2024-03-15 9:00 AM): did acme-example wire the invoice?');
    expect(parsed.content).toContain('**Alice Example** (2024-03-15 9:02 AM): yes, this AM');
    expect(result.phase).toBe('regex_match');
    expect(result.matched_pattern_id).toBe('imessage-slack');
    expect(result.messages).toHaveLength(2);
  });

  test('rendering the same segment twice keeps slug and content hash stable', () => {
    const resolver = buildNameResolver([alice], { selfName: 'Me' });
    const first = renderConversationMarkdown(segment, resolver);
    const second = renderConversationMarkdown(segment, resolver);

    expect(second.slug).toBe(first.slug);
    expect(second.content_hash).toBe(first.content_hash);
  });
});
